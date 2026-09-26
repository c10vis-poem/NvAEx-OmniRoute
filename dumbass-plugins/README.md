# D.U.M.B.A.S.S. OmniRoute plugins

Server-side plugins (see `docs/frameworks/PLUGIN_MARKETPLACE.md`) implementing the orchestration
contract in `c10vis-poem/aesop-xi` `protocol/orchestration-contract.md`.

| Plugin | Hooks | What it does |
|---|---|---|
| `continual-harness` | onRequest, onResponse | Per-session checkpoints (`x-dumbass-session`); rollback via `x-dumbass-checkpoint: <n>` |
| `retrieval-planner` | onRequest | Picks arms (mem0 / Terrestrial Brain / code-review-graph `cross_repo_search_tool` over every registered repo — any, all, none), queries in parallel, injects under a context-scaled budget |
| `reasoning-bank` | onRequest, onResponse, onStreamComplete | JSONL trajectory candidates; failures to `failure_logs/` |

Settings: each plugin reads `config.json` beside its `index.mjs` (the loader does not inject
`ctx.config`). Tests: `node --test dumbass-plugins/test/plugins.test.mjs`.

Known upstream loader gaps these plugins work around: `ctx.config` never populated; `onResponse`
payload arrives nested as `{ ctx: { ...ctx, response } }`; `onError` is not delivered to disk
plugins (wrapper expects two arguments, is called with one); on boot hooks run in plugin-name order
(`src/lib/db/plugins.ts` `ORDER BY name`), so `reasoning-bank` runs before `retrieval-planner` and
receives the planner's metadata through a per-request file in `/app/data/dumbass/handoff/`.
