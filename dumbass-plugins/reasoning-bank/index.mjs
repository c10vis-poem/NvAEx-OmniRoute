// Reasoning Bank: append-only JSONL ledger of request trajectories.
// Every record is a *candidate*. Promotion to a verified success (Success Verification Grade)
// happens outside this plugin, only with evidence: CI green, merged PR, or operator acceptance.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

// OmniRoute's loader forwards hook payloads verbatim and never injects ctx.config, so settings
// come from ./config.json beside this file (defaults below when absent).
const DEFAULTS = { enabled: true, dataDir: "/app/data/dumbass/reasoning_bank", excerptChars: 300 };
let cached;
export async function settings() {
  if (!cached) {
    try {
      const raw = await readFile(new URL("./config.json", import.meta.url), "utf8");
      cached = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      cached = { ...DEFAULTS };
    }
  }
  return cached;
}

// onResponse arrives as { ctx: { ...ctx, response } }; onRequest/onStreamComplete arrive flat.
export function unwrap(p) {
  const ctx = p?.ctx && typeof p.ctx === "object" ? p.ctx : p;
  return { ctx, response: p?.response ?? ctx?.response };
}

const open = new Map(); // requestId -> partial record; the plugin is a long-lived child process
const MAX_OPEN = 5000;

function header(ctx, name) {
  const v = ctx?.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

function lastUserText(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
  }
  return "";
}

export function toolCallNames(response) {
  const calls = response?.choices?.[0]?.message?.tool_calls ?? [];
  const anthropic = Array.isArray(response?.content) ? response.content.filter((p) => p?.type === "tool_use") : [];
  return [...calls.map((c) => c?.function?.name), ...anthropic.map((p) => p?.name)].filter(Boolean);
}

async function write(cfg, kind, record) {
  const dir = path.join(cfg.dataDir || "/app/data/dumbass/reasoning_bank", kind);
  await mkdir(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  await appendFile(path.join(dir, `${day}.jsonl`), JSON.stringify(record) + "\n");
}

export async function onRequest(payload) {
  const { ctx } = unwrap(payload);
  const cfg = await settings();
  if (cfg.enabled === false || !ctx?.requestId) return;
  if (open.size >= MAX_OPEN) open.delete(open.keys().next().value); // bound memory if responses never arrive
  const n = cfg.excerptChars ?? 300;
  open.set(ctx.requestId, {
    requestId: ctx.requestId,
    startedAt: new Date().toISOString(),
    model: ctx.model,
    provider: ctx.provider,
    session: header(ctx, "x-dumbass-session") ?? null,
    harness: header(ctx, "x-dumbass-harness") ?? null,
    retrieval: ctx.metadata?.retrievalPlanner ?? null,
    checkpoint: ctx.metadata?.continualHarness ?? null,
    prompt: n ? lastUserText(ctx.body?.messages).slice(0, n) : undefined,
  });
}

export async function onResponse(payload) {
  const { ctx, response: r } = unwrap(payload);
  const cfg = await settings();
  if (cfg.enabled === false) return;
  const rec = open.get(ctx?.requestId);
  if (!rec) return;
  const n = cfg.excerptChars ?? 300;
  const answer = r?.choices?.[0]?.message?.content;
  Object.assign(rec, {
    finishedAt: new Date().toISOString(),
    outcome: "completed-unverified",
    finishReason: r?.choices?.[0]?.finish_reason ?? r?.stop_reason ?? null,
    toolCalls: toolCallNames(r),
    usage: r?.usage ?? rec.usage ?? null,
    answer: n && typeof answer === "string" ? answer.slice(0, n) : undefined,
  });
  // Streaming responses finish in onStreamComplete (usage/timing); non-streaming ones finish here.
  if (r?.usage) {
    open.delete(ctx.requestId);
    await write(cfg, "candidates", rec);
  }
}

export async function onStreamComplete(payload) {
  const cfg = await settings();
  if (cfg.enabled === false) return;
  const rec = open.get(payload?.requestId);
  if (!rec) return;
  open.delete(payload.requestId);
  Object.assign(rec, {
    finishedAt: rec.finishedAt ?? new Date().toISOString(),
    outcome: payload.status >= 400 || payload.errorCode ? "failed" : rec.outcome ?? "completed-unverified",
    usage: payload.usage ?? rec.usage ?? null,
    timing: payload.timing ?? null,
    errorCode: payload.errorCode ?? null,
  });
  await write(cfg, rec.outcome === "failed" ? "failure_logs" : "candidates", rec);
}

// Upstream loader currently drops onError for disk plugins (wrapper expects 2 args, gets 1);
// kept for when that is fixed. Failures are captured via onStreamComplete status/errorCode.
export async function onError(payload) {
  const { ctx } = unwrap(payload);
  const cfg = await settings();
  if (cfg.enabled === false) return;
  const rec = open.get(ctx?.requestId) ?? { requestId: ctx?.requestId, model: ctx?.model, provider: ctx?.provider };
  open.delete(ctx?.requestId);
  await write(cfg, "failure_logs", {
    ...rec,
    finishedAt: new Date().toISOString(),
    outcome: "failed",
    error: String(payload?.error ?? ctx?.error?.message ?? ctx?.error ?? "unknown").slice(0, 500),
  });
}
