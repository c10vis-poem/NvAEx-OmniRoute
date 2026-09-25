// Continual Harness: session working state, never durable truth.
// Session = request header x-dumbass-session. Rollback = header x-dumbass-checkpoint: <n back>.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// OmniRoute's loader forwards hook payloads verbatim and never injects ctx.config, so settings
// come from ./config.json beside this file (defaults below when absent).
const DEFAULTS = { enabled: true, dataDir: "/app/data/dumbass/checkpoints", keepCheckpoints: 10, maxCheckpointChars: 4000 };
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

const MARK = "[continual-harness checkpoint]";

export function header(ctx, name) {
  const v = ctx?.headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

export function sessionFile(dataDir, session) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(session)) return null; // no path tricks via header
  return path.join(dataDir, `${session}.json`);
}

async function load(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { checkpoints: [] };
    throw e;
  }
}

export function lastUserText(messages) {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
  }
  return "";
}

export function responseText(response) {
  const c = response?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  const parts = response?.content; // Anthropic-shaped
  return Array.isArray(parts) ? parts.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : "";
}

export function renderCheckpoint(cp, maxChars) {
  const lines = [MARK, `session turn ${cp.turn} @ ${cp.at}`];
  for (const t of cp.recent) lines.push(`- asked: ${t.asked}\n  answered: ${t.answered}`);
  return lines.join("\n").slice(0, maxChars);
}

export function injectCheckpoint(body, text) {
  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages || messages.some((m) => typeof m?.content === "string" && m.content.startsWith(MARK))) return null;
  return { ...body, messages: [{ role: "system", content: text }, ...messages] };
}

export async function onRequest(payload) {
  const { ctx } = unwrap(payload);
  const cfg = await settings();
  if (cfg.enabled === false) return;
  const session = header(ctx, "x-dumbass-session");
  const file = session && sessionFile(cfg.dataDir || "/app/data/dumbass/checkpoints", session);
  if (!file) return;
  const { checkpoints } = await load(file);
  const back = Number(header(ctx, "x-dumbass-checkpoint") || 0);
  const cp = checkpoints[checkpoints.length - 1 - (Number.isInteger(back) && back > 0 ? back : 0)];
  if (!cp) return { metadata: { continualHarness: { session, checkpoint: null } } };
  const body = injectCheckpoint(ctx.body, renderCheckpoint(cp, cfg.maxCheckpointChars || 4000));
  const metadata = { continualHarness: { session, checkpoint: cp.turn, rolledBack: back > 0 ? back : 0 } };
  return body ? { body, metadata } : { metadata };
}

export async function onResponse(payload) {
  const { ctx, response } = unwrap(payload);
  const cfg = await settings();
  if (cfg.enabled === false) return;
  const session = header(ctx, "x-dumbass-session");
  const dataDir = cfg.dataDir || "/app/data/dumbass/checkpoints";
  const file = session && sessionFile(dataDir, session);
  if (!file) return;
  const asked = lastUserText(ctx.body?.messages).slice(0, 500);
  const answered = responseText(response).slice(0, 800);
  if (!asked && !answered) return;
  const state = await load(file);
  const prev = state.checkpoints[state.checkpoints.length - 1];
  const recent = [...(prev?.recent ?? []), { asked, answered }].slice(-5);
  const cp = { turn: (prev?.turn ?? 0) + 1, at: new Date().toISOString(), recent };
  const keep = cfg.keepCheckpoints || 10;
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, JSON.stringify({ checkpoints: [...state.checkpoints, cp].slice(-keep) }));
}
