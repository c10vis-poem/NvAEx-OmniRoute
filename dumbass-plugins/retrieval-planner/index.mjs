// Retrieval planner: retrieval is part of routing. Decide which arms a request needs, query them
// in parallel, and inject the results under a budget scaled to the target model's context window.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  enabled: true,
  mem0: { url: "http://mem0:8000", apiKey: "", userId: "operator", topK: 8 },
  terrestrialBrain: { url: "http://host.docker.internal:8000/mcp", key: "", limit: 8, threshold: 0.4 },
  codeReviewGraph: { url: "http://host.docker.internal:5555/mcp", limit: 5, maxResults: 12 },
  // Plugins load in name order on boot (src/lib/db/plugins.ts ORDER BY name), so reasoning-bank
  // runs before this plugin and never sees its metadata; it reads this per-request file instead.
  handoffDir: "/app/data/dumbass/handoff",
  timeoutMs: 4000,
  budgetShare: 0.25, // share of the model's context window available to retrieval
  reserveOutputTokens: 8000,
  defaultContextTokens: 128000,
  modelContextTokens: {}, // substring of model id -> context tokens, e.g. {"claude": 200000}
  longPromptChars: 1500, // prompts this long consult every arm
};

let cached;
export async function settings() {
  if (!cached) {
    try {
      const raw = JSON.parse(await readFile(new URL("./config.json", import.meta.url), "utf8"));
      cached = { ...DEFAULTS, ...raw };
      for (const k of ["mem0", "terrestrialBrain", "codeReviewGraph"]) cached[k] = { ...DEFAULTS[k], ...raw[k] };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      cached = structuredClone(DEFAULTS);
    }
  }
  return cached;
}

const MARK = "[retrieval-planner context]";
const SIGNALS = {
  code: [
    /```|\b[\w./-]+\.(ts|tsx|js|mjs|py|rs|go|java|kt|sh|sql|json|ya?ml|toml)\b|\b(function|class|method|refactor|stack ?trace|exception|compile|build|test|repo|import|calls?|callers?|endpoint|bug)\b|\b\w+_\w+\(/gi,
    /\b[a-z]+[A-Z]\w*\b/g, // camelCase identifiers: must stay case-sensitive
  ],
  memory: [/\b(remember|recall|last time|earlier|before|previously|we (decided|agreed|said|talked)|did (i|we)|my (preference|setup|usual)|yesterday|again)\b/gi],
  corpus: [/\b(docs?|documentation|wiki|vault|notes?|corpus|spec|architecture|plan|decision|protocol|contract|according to|reference|guide|how does .* work)\b/gi],
};

export function lastUserText(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
  }
  return "";
}

/** Returns arms in priority order (strongest signal first). Any, all, or none. */
export function chooseArms(text, cfg) {
  if (text.length >= cfg.longPromptChars) return { arms: ["code", "corpus", "memory"], reason: "long-prompt" };
  const hits = Object.entries(SIGNALS)
    .map(([arm, res]) => [arm, res.reduce((n, re) => n + (text.match(re) || []).length, 0)])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return { arms: hits.map(([arm]) => arm), reason: hits.length ? "signals" : "no-signals" };
}

export function budgetTokens(model, promptChars, cfg) {
  const hit = Object.entries(cfg.modelContextTokens || {}).find(([k]) => String(model || "").includes(k));
  const ctxTokens = hit ? hit[1] : cfg.defaultContextTokens;
  const promptTokens = Math.ceil(promptChars / 4);
  return Math.max(0, Math.min(Math.floor(ctxTokens * cfg.budgetShare), ctxTokens - promptTokens - cfg.reserveOutputTokens));
}

async function post(url, body, headers, timeoutMs) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}

async function rpcResult(res) {
  const text = await res.text();
  const json = text.trimStart().startsWith("{")
    ? JSON.parse(text)
    : JSON.parse(text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).pop() || "{}");
  if (json.error) throw new Error(json.error.message || "MCP error");
  return json.result;
}

const mcpSessions = new Map(); // url -> session id (plugin is a long-lived process)
async function mcpCall(url, headers, tool, args, timeoutMs) {
  const call = async () => {
    let sid = mcpSessions.get(url);
    if (sid === undefined) {
      const init = await post(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "retrieval-planner", version: "0.1.0" } } }, headers, timeoutMs);
      sid = init.headers.get("mcp-session-id") || "";
      await init.text();
      const h = sid ? { ...headers, "Mcp-Session-Id": sid } : headers;
      await (await post(url, { jsonrpc: "2.0", method: "notifications/initialized" }, h, timeoutMs)).text();
      mcpSessions.set(url, sid);
    }
    const h = sid ? { ...headers, "Mcp-Session-Id": sid } : headers;
    const result = await rpcResult(await post(url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }, h, timeoutMs));
    return (result?.content || []).filter((c) => c?.type === "text").map((c) => c.text).join("\n");
  };
  try {
    return await call();
  } catch (e) {
    mcpSessions.delete(url); // stale session after a server restart: re-initialize once
    if (/HTTP (400|404)/.test(String(e.message))) return await call();
    throw e;
  }
}

const ARMS = {
  memory: async (query, cfg) => {
    const c = cfg.mem0;
    if (!c.apiKey) throw new Error("mem0.apiKey not configured");
    const res = await post(`${c.url}/search`, { query, filters: { user_id: c.userId }, top_k: c.topK }, { "X-API-Key": c.apiKey }, cfg.timeoutMs);
    const data = await res.json();
    const items = Array.isArray(data) ? data : data?.results || [];
    return items.map((m) => m?.memory || m?.text).filter(Boolean);
  },
  corpus: async (query, cfg) => {
    const c = cfg.terrestrialBrain;
    if (!c.key) throw new Error("terrestrialBrain.key not configured");
    const text = await mcpCall(c.url, { "x-brain-key": c.key }, "search_thoughts", { query, limit: c.limit, threshold: c.threshold }, cfg.timeoutMs);
    return text ? text.split(/\n{2,}/).filter((s) => s.trim()) : [];
  },
  code: async (query, cfg) => {
    const c = cfg.codeReviewGraph;
    // cross_repo_search matches node names; whole sentences only return noise, so search identifiers.
    const q = codeTerms(query).join(" ") || query.slice(0, 200);
    const data = JSON.parse(await mcpCall(c.url, {}, "cross_repo_search_tool", { query: q, limit: c.limit, max_results: c.maxResults }, cfg.timeoutMs));
    if (data.status !== "ok") throw new Error(String(data.error || data.summary || "code-review-graph error").slice(0, 200));
    return (data.results || []).map((r) => `${r.repo}/${path.relative(r.repo_path, r.file_path)}:${r.line_start} ${r.kind} ${r.name}${r.params ?? ""}`);
  },
};
/** camelCase / snake_case / dotted identifiers and file names in the prompt. */
export function codeTerms(text) {
  return [...new Set(text.match(/\b(?:[\w-]+\.(?:ts|tsx|js|mjs|py|rs|go|sh)|[a-z]+[A-Z]\w*|[A-Za-z]+_\w+|[A-Z][a-z]+[A-Z]\w*)\b/g) || [])].slice(0, 5);
}

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
async function handoff(cfg, requestId, meta) {
  if (!cfg.handoffDir || !SAFE_ID.test(String(requestId))) return;
  await mkdir(cfg.handoffDir, { recursive: true });
  await writeFile(path.join(cfg.handoffDir, `${requestId}.json`), JSON.stringify(meta));
}

const LABEL = { memory: "mem0 (episodic memory)", corpus: "Terrestrial Brain (corpus)", code: "code-review-graph (code)" };

/** Interleave arms in priority order and take chunks until the token budget is spent. */
export function fitToBudget(results, arms, budget) {
  let left = budget * 4; // ~4 chars/token
  const taken = Object.fromEntries(arms.map((a) => [a, []]));
  const queues = arms.map((a) => [a, [...(results[a] || [])]]);
  let progressed = true;
  while (progressed && left > 0) {
    progressed = false;
    for (const [arm, q] of queues) {
      const chunk = q.shift();
      if (!chunk) continue;
      if (chunk.length > left) { left = 0; break; }
      taken[arm].push(chunk);
      left -= chunk.length;
      progressed = true;
    }
  }
  return taken;
}

export function render(taken) {
  const parts = [MARK, "Retrieved for this request. Cite the source label when you rely on it; ignore what is irrelevant."];
  for (const [arm, chunks] of Object.entries(taken)) if (chunks.length) parts.push(`## ${LABEL[arm]}\n${chunks.join("\n\n")}`);
  return parts.length > 2 ? parts.join("\n\n") : null;
}

export async function onRequest(payload) {
  const ctx = payload?.ctx && typeof payload.ctx === "object" ? payload.ctx : payload;
  const cfg = await settings();
  if (cfg.enabled === false) return;
  const messages = Array.isArray(ctx?.body?.messages) ? ctx.body.messages : null;
  if (!messages || messages.some((m) => typeof m?.content === "string" && m.content.startsWith(MARK))) return;
  const query = lastUserText(messages).trim();
  const started = Date.now();
  const { arms, reason } = chooseArms(query, cfg);
  const promptChars = JSON.stringify(messages).length;
  const budget = budgetTokens(ctx.model, promptChars, cfg);
  const meta = { arms, reason, budgetTokens: budget, injectedTokens: 0, errors: {} };

  // Pre-flight: x-dumbass-plan-only returns the route plan and stops before any model call,
  // so a harness (Task Observer) can show/log it and then send the real request.
  const planOnly = String(ctx?.headers?.["x-dumbass-plan-only"] ?? "").toLowerCase();
  if (["1", "true", "yes"].includes(planOnly)) {
    return {
      blocked: true,
      response: {
        object: "dumbass.plan",
        requestId: ctx.requestId ?? null,
        model: ctx.model ?? null,
        provider: ctx.provider ?? null,
        session: ctx?.headers?.["x-dumbass-session"] ?? null,
        checkpoint: ctx?.metadata?.continualHarness ?? null,
        retrieval: { arms, reason, budgetTokens: budget, promptTokensEst: Math.ceil(promptChars / 4) },
        note: "Plan only: no model was called. Resend without x-dumbass-plan-only to execute.",
      },
    };
  }
  const done = async (out) => {
    await handoff(cfg, ctx.requestId, meta).catch(() => {}); // ledger only; never fail the request
    return out;
  };
  if (!query || !arms.length || budget <= 0) return done({ metadata: { retrievalPlanner: meta } });

  const settled = await Promise.allSettled(arms.map((a) => ARMS[a](query, cfg)));
  const results = {};
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") results[arms[i]] = s.value;
    else meta.errors[arms[i]] = String(s.reason?.message || s.reason).slice(0, 200);
  });
  const block = render(fitToBudget(results, arms, budget));
  meta.latencyMs = Date.now() - started;
  if (!block) return done({ metadata: { retrievalPlanner: meta } });
  meta.injectedTokens = Math.ceil(block.length / 4);
  return done({
    body: { ...ctx.body, messages: [{ role: "system", content: block }, ...messages] },
    metadata: { retrievalPlanner: meta },
  });
}
