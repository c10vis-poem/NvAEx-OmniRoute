// Run: node --test dumbass-plugins/test/
// Payload shapes mirror src/lib/plugins/loader.ts: onRequest/onStreamComplete flat, onResponse nested { ctx }.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = (name) => path.join(here, "..", name);

async function withConfig(name, cfg, fn) {
  const file = path.join(pluginDir(name), "config.json");
  await writeFile(file, JSON.stringify(cfg));
  try {
    return await fn(await import(`${pluginDir(name)}/index.mjs?t=${Date.now()}${Math.random()}`));
  } finally {
    await rm(file, { force: true });
  }
}

const ctx = (over = {}) => ({
  requestId: "req-1",
  model: "openrouter/openai/gpt-4o-mini",
  provider: "openrouter",
  headers: { "x-dumbass-session": "s1", "x-dumbass-harness": "claude-code" },
  body: { messages: [{ role: "user", content: "what did we decide about the VM?" }] },
  metadata: {},
  ...over,
});
const replyData = { choices: [{ message: { content: "We moved to x86." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
// Real chatCore envelope (open-sse/handlers/chatCore/pluginOnResponse.ts)
const reply = { status: 200, data: replyData, streamed: false };

test("continual-harness: no checkpoint first, injects after a response, rolls back by n", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ch-"));
  await withConfig("continual-harness", { dataDir: dir }, async (ch) => {
    assert.deepEqual((await ch.onRequest(ctx())).metadata.continualHarness.checkpoint, null);
    await ch.onResponse({ ctx: { ...ctx(), response: reply } });
    await ch.onResponse({ ctx: { ...ctx({ body: { messages: [{ role: "user", content: "second" }] } }), response: reply } });
    const r = await ch.onRequest(ctx());
    assert.equal(r.metadata.continualHarness.checkpoint, 2);
    assert.match(r.body.messages[0].content, /^\[continual-harness checkpoint\]/);
    assert.match(r.body.messages[0].content, /second/);
    assert.match(r.body.messages[0].content, /We moved to x86/); // answers are captured from the envelope
    const back = await ch.onRequest(ctx({ headers: { "x-dumbass-session": "s1", "x-dumbass-checkpoint": "1" } }));
    assert.equal(back.metadata.continualHarness.checkpoint, 1);
    assert.equal(back.metadata.continualHarness.rolledBack, 1);
    const again = await ch.onRequest({ ...ctx(), body: r.body }); // never double-inject
    assert.equal(again.body, undefined);
  });
  await rm(dir, { recursive: true });
});

test("continual-harness: rejects path-like session ids", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ch-"));
  await withConfig("continual-harness", { dataDir: dir }, async (ch) => {
    assert.equal(await ch.onRequest(ctx({ headers: { "x-dumbass-session": "../../etc/passwd" } })), undefined);
    await ch.onResponse({ ctx: { ...ctx({ headers: { "x-dumbass-session": "../x" } }), response: reply } });
    assert.deepEqual(await readdir(dir), []);
  });
  await rm(dir, { recursive: true });
});

test("reasoning-bank: non-streaming request writes one candidate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rb-"));
  await withConfig("reasoning-bank", { dataDir: dir }, async (rb) => {
    await rb.onRequest(ctx({ metadata: { retrievalPlanner: { arms: ["memory"] } } }));
    await rb.onResponse({ ctx: { ...ctx(), response: reply } });
    const [file] = await readdir(path.join(dir, "candidates"));
    const rec = JSON.parse((await readFile(path.join(dir, "candidates", file), "utf8")).trim());
    assert.equal(rec.outcome, "completed-unverified");
    assert.equal(rec.harness, "claude-code");
    assert.deepEqual(rec.retrieval.arms, ["memory"]);
    assert.equal(rec.usage.completion_tokens, 5);
  });
  await rm(dir, { recursive: true });
});

test("reasoning-bank: non-streaming 5xx response goes to failure_logs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rb-"));
  await withConfig("reasoning-bank", { dataDir: dir }, async (rb) => {
    await rb.onRequest(ctx({ requestId: "req-3" }));
    await rb.onResponse({ ctx: { ...ctx({ requestId: "req-3" }), response: { status: 503, data: { error: "x" }, streamed: false } } });
    assert.deepEqual(await readdir(dir), ["failure_logs"]);
  });
  await rm(dir, { recursive: true });
});

test("reasoning-bank: streamed response waits for onStreamComplete", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rb-"));
  await withConfig("reasoning-bank", { dataDir: dir }, async (rb) => {
    await rb.onRequest(ctx({ requestId: "req-4" }));
    await rb.onResponse({ ctx: { ...ctx({ requestId: "req-4" }), response: { status: 200, streamed: true } } });
    assert.deepEqual(await readdir(dir), []);
    await rb.onStreamComplete({ requestId: "req-4", status: 200, usage: { completion_tokens: 7 }, timing: { latencyMs: 900 } });
    const [f] = await readdir(path.join(dir, "candidates"));
    const rec = JSON.parse((await readFile(path.join(dir, "candidates", f), "utf8")).trim());
    assert.equal(rec.usage.completion_tokens, 7);
    assert.equal(rec.timing.latencyMs, 900);
  });
  await rm(dir, { recursive: true });
});

test("reasoning-bank: failed stream goes to failure_logs, never candidates", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rb-"));
  await withConfig("reasoning-bank", { dataDir: dir }, async (rb) => {
    await rb.onRequest(ctx({ requestId: "req-2" }));
    await rb.onStreamComplete({ requestId: "req-2", status: 502, errorCode: "upstream_error" });
    assert.equal((await readdir(dir)).includes("candidates"), false);
    const [file] = await readdir(path.join(dir, "failure_logs"));
    assert.equal(JSON.parse((await readFile(path.join(dir, "failure_logs", file), "utf8")).trim()).outcome, "failed");
  });
  await rm(dir, { recursive: true });
});

test("retrieval-planner: arm choice — none, one, several, all for long prompts", async () => {
  await withConfig("retrieval-planner", {}, async (rp) => {
    const cfg = await rp.settings();
    assert.deepEqual(rp.chooseArms("hi", cfg).arms, []);
    assert.deepEqual(rp.chooseArms("what calls requireAuth in src/server/auth.ts?", cfg).arms, ["code"]);
    assert.deepEqual(new Set(rp.chooseArms("remember what we decided in the architecture docs?", cfg).arms), new Set(["memory", "corpus"]));
    assert.deepEqual(rp.chooseArms("x".repeat(cfg.longPromptChars), cfg).arms.length, 3);
    assert.deepEqual(rp.chooseArms("does getUserById handle nulls?", cfg).arms, ["code"]); // camelCase still detected
  });
});

test("retrieval-planner: budget scales with model context, never negative", async () => {
  await withConfig("retrieval-planner", { modelContextTokens: { claude: 200000 } }, async (rp) => {
    const cfg = await rp.settings();
    assert.equal(rp.budgetTokens("anthropic/claude-sonnet", 4000, cfg), 50000);
    assert.equal(rp.budgetTokens("gpt-4o-mini", 4000, cfg), 32000);
    assert.equal(rp.budgetTokens("gpt-4o-mini", 600000, cfg), 0);
  });
});

test("retrieval-planner: fitToBudget interleaves arms and respects the budget", async () => {
  await withConfig("retrieval-planner", {}, async (rp) => {
    const r = { code: ["a".repeat(40), "b".repeat(40)], memory: ["c".repeat(40)] };
    assert.deepEqual(rp.fitToBudget(r, ["code", "memory"], 30), { code: ["a".repeat(40), "b".repeat(40)], memory: ["c".repeat(40)] });
    assert.deepEqual(rp.fitToBudget(r, ["code", "memory"], 20), { code: ["a".repeat(40)], memory: ["c".repeat(40)] });
  });
});

test("retrieval-planner: arm failures are reported, request still passes", async () => {
  await withConfig("retrieval-planner", { timeoutMs: 300, mem0: { url: "http://127.0.0.1:9", apiKey: "k" } }, async (rp) => {
    const out = await rp.onRequest(ctx());
    assert.ok(out.metadata.retrievalPlanner.errors.memory);
    assert.equal(out.body, undefined);
  });
});
