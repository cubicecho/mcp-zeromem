# AGENTS.md — mcp-zeromem

mcp-zeromem is conversational memory for agents that costs zero tokens to maintain. A **turn** is
one utterance (`session_id`, `speaker`, `text`, `ts`); the **store** is one SQLite file holding
every turn plus the indexes derived from them; **recall** is retrieval over those indexes with no
LLM in the loop. The engine is a Rust crate loaded in-process by a Node server via napi-rs; the
server exposes the engine as MCP (Streamable HTTP at `/mcp`, and a stdio bin), a small REST API
for the admin UI, and serves that UI. The same engine ships as the `zm` CLI so host-side hooks can
write into the store without going through the server.

Read [`README.md`](README.md) first — it holds the design decisions this file only summarises.

Two toolchains, one repo. Cargo workspace: `crates/zeromem-core` (the engine + `zm`),
`crates/zeromem-harness` (the seeded corpus generator, its labeled queries and the retrieval
metrics; the engine's tests depend on it, never the reverse), `crates/zeromem-node` (the napi-rs
addon, published into the npm workspace as `@mcp-zeromem/native`). npm workspaces: `shared/` (zod DTOs — the contract), `crates/zeromem-node`,
`server/` (Express 5 + MCP SDK), `app/` (React + Vite + shadcn/ui).

## Clean-room policy

**Nothing from `github.com/ptaranat/zeromem` enters this repo.** Not source, not scripts, not
fixtures, not schema DDL, not a test corpus. The spec is *behaviour*: the paper, upstream's public
README, and black-box observation of the pristine upstream binary. Upstream source files are not
opened while implementing the corresponding module here. Upstream is only ever built in a
throwaway CI stage and invoked as a binary for the comparison metrics; compatibility with its
store format or CLI is a non-goal. MCP tool names stay `zeromem_*` — a name is not code. Every PR
that touches `crates/` confirms this in its description.

## Commands

All from the workspace root. `npm run build:native` must have run once before anything in
`server/` will typecheck, test, or start — it produces the gitignored `index.js`/`index.d.ts`
loader and the `.node` artifact under `crates/zeromem-node/`.

```bash
# Dev
npm run build:native     # cargo build (release) of the addon; rerun after any Rust change
npm run dev              # server (watch, port 3001) + Vite dev server (port 3000), concurrently
npm run dev:server       # Express + MCP only
npm run dev:app          # Vite only (proxies /api + /mcp to 3001)

# Quality — run all of these before every commit; CI fails otherwise
npm run lint             # biome check + cargo fmt --check + cargo clippy -D warnings
npm run format           # biome check --write + cargo fmt
npm run typecheck        # tsc --noEmit for shared, server, app
npm test                 # vitest run (server + shared + app projects)
npm run test:rust        # cargo test --workspace (oracle, properties, golden, eval, reference vectors)
npm run fixtures:gen     # regenerate crates/zeromem-harness/fixtures/ after changing the generator
npm run bench            # cold open / RSS / recall latency at 1k, 10k, 50k turns → target/bench/
scripts/record-eval.sh   # run the eval harness and append a row per corpus × embedder to docs/eval/history.jsonl
npm run routes:gen -w app # regenerate app/src/routeTree.gen.ts (also done by the Vite plugin in dev)
scripts/rank.sh large    # our ranked answers to the labeled queries, for `zm-harness compare`

# Build / run
npm run build            # build:native → shared typecheck → server tsc → app vite build
npm start                # node server/dist/index.js
npm run stdio            # node server/dist/stdio.js (stdio MCP)
npm run build:docker     # docker build -t mcp-zeromem .
docker compose up        # ./data mounted at /data, port 3200 on the host
```

## Tech stack

| Choice | Why |
| --- | --- |
| **Rust engine + napi-rs** | Retrieval is CPU-bound and index rebuilds are linear in store size; a child process would need a supervisor and a spool protocol, a TS port would be 5–10x slower on the hot path. In-process is zero-cost and one `Mutex` serialises access. |
| **Every addon method is `async`** | Runs on the libuv threadpool via `spawn_blocking`; the event loop never waits on SQLite or an embedding forward pass. |
| **`serde_json::Value` across the boundary, zod on the TS side** | The addon's `.d.ts` is hand-written and unchecked; `server/src/engine/` validates every result with the `shared/` schemas so a renamed Rust field fails at the first call, not in a UI card. |
| **rusqlite `bundled`, WAL** | No system libsqlite3 in the image; WAL so the server, `zm` hooks and a stdio session can share one file. |
| **Stateless Streamable HTTP** | A fresh `McpServer` per request; nothing session-scoped, nothing to reap. |
| **Node 26 type stripping** | `server/` and `shared/` run as `.ts` in dev; `tsc` emits `server/dist` for prod — so **use `.ts` extensions in all relative imports** there. |

## Key conventions

**`DATA_DIR` is `ZEROMEM_HOME`.** The server, the in-container `zm`, and a host-side `zm` must all
resolve the same store or recall is quietly incomplete. `config.ts` refuses to start if the two
env vars disagree, and `zm` refuses to fall back to the working directory when neither is set.

**Snake_case at the engine boundary.** Turn and result shapes are `session_id`, `schema_version`,
… in JSONL, in the CLI, in the addon and in `shared/`. Do not camel-case one layer.

**`refresh()` before reads.** Other processes append to the store; every read goes through
`refresh()`, which embeds one batch of the turns that arrived without a vector, loads new vectors
by their `seq` cursor, and reloads everything when the `generation` stamp moved (a `forget` or an
embedder switch somewhere). A hook's write is visible to the next recall without a restart.

**The store owns the embedder.** `meta.embedder_spec` (JSON) and `meta.embedder` (its name:
`bge-small-en-v1.5`, `hash-384`, `openai:<model>@<dim>`) record which embedder built the vectors.
`ZEROMEM_EMBEDDER` seeds a new store; on an existing one `auto` follows the store and any other
explicit choice must match it unless `ZEROMEM_ALLOW_EMBEDDER_SWITCH=true`. A switch — at boot,
from the Settings page (`PUT /api/settings/embedder`) or `zm embedder set` — is one transaction:
spec written, `embeddings` emptied, `generation` bumped; every other process notices on its next
`refresh()` and rebuilds its embedder from the spec. Writers guard against staleness: a vector
write re-reads `meta.embedder` inside its transaction and returns `Error::EmbedderChanged`
instead of overwriting newer vectors, and `Error::StoreChanged` when the `generation` moved since
it read its backlog (after `clear_memory` turn ids are reused, so an old vector could land on a new
turn). `reembed()` (Settings, `zm embedder reembed`) probes the stored embedder and then empties
`embeddings` like a switch; `clear_embeddings()` and `clear_memory()` (Settings → Stored data,
`POST /api/settings/clear`) keep `meta`. A process that cannot build the store's embedder runs with
`embedder_active: false` and a warning, never a silent hash fallback; `auto` on a **fresh** store
falls back to `hash-384` loudly (`embedder_is_fallback`, a banner in the UI). `--embedder none`
(`followRemote: false` in the binding) means "this process has no dense view": host hooks and the
stdio server use it for remote endpoints so they never hold a request open on the network.

**The backlog is a job, not a read.** Turns without a vector are counted by `embedding_backlog()`
and drained by `embed_backlog(limit)`; `refresh()` takes one batch so a recall is never blocked
by a corpus-wide re-embed. Only the HTTP server runs `EmbedWorker`
(`server/src/engine/embed-worker.ts`), kicked after open and after every switch; headless hosts
run `zm embedder drain`. The remote embedder (`dense/remote.rs`, `ureq`) never probes at
construction — only `probe_embedder`/`set_embedder` fail fast — and trips a breaker for 30 s after
three failures so a query under the engine mutex never pays the timeout per call. The API key in
the spec is stored in plain text; `ZEROMEM_EMBEDDING_API_KEY` overrides it and the API only ever
reports `api_key_source`.

Tests and CI boots use `hash` so nothing downloads; `tests/common/mock_embeddings.rs` is the
endpoint for the remote tests. The model lives under `ZEROMEM_MODELS` (`<DATA_DIR>/models`;
`target/models` in the Rust tests, cached in CI). `ZEROMEM_SKIP_ONNX=1` skips the ONNX halves of
the reference-vector and eval tests.

**Write tools are gated, not stubbed.** Under `ZEROMEM_READ_ONLY` the write tools are dropped from
the listing entirely — an agent should never see a tool it cannot call.

**A hit is a turn, not the answer; recall never hands back a fragment silently.** `context: N`
attaches up to `MAX_CONTEXT` same-session turns either side of a hit as `before`/`after`, and
`zeromem_read_session` (`session_window` in the engine) reads a session in conversation order for
any agent, not just the curator. Neighbours are *attached to* evidence, never ranked *with* it —
`evidence` must be byte-identical with and without `context`, or the eval floors in `tests/eval.rs`
and the goldens move; `tests/context.rs::context_does_not_change_the_ranking` is the tripwire.
`format: text` keeps line breaks and clips only past `ZEROMEM_RECALL_TEXT_LIMIT` (`max_chars` per
call), and a clip always carries the `zeromem_read_session` call that returns the rest, because a
model handed an unmarked fragment concludes memory is incomplete and searches the web instead.

**Curation never deletes.** The curator (an outside agent; `docs/curator-playbook.md`, served as
the `zeromem_curate` MCP prompt) hides, supersedes, aliases, blocks and writes notes, each an
action in `curation_actions` with a reason, undone by replaying its inverse. Turns stay immutable;
flags, aliases, the blocklist and note sources live beside them and cascade on turn delete. Payloads
name turns by uuid, so the log survives a `rebuild`. Hide and supersede advance `meta.curation_seq`
and `refresh()` reloads only the flag set, keeping the vector index; alias and block changes re-derive
the entity tables and bump `generation`; a note is an ordinary turn (`kind = 'note'`) and undoing one
deletes it and bumps `generation`. The settings (limits, token, exposure) are `meta.curator_config`,
changed on the Settings page; `MCP_ZEROMEM_CURATOR_TOKEN` overrides the stored token and the API only
reports `token_source`. The curator token opens `/mcp` with the curator scope (the default tools
plus the curator tools and prompt) and nothing under `/api`; `expose_to_all` (or `ZEROMEM_CURATOR`
for stdio) gives every client that scope. New `Turn` and `Evidence` fields are skipped when empty, so
the goldens do not move. In recall a superseded turn hands its fused score to its replacement (`retrieve::hand_over`), pulling it in when no view nominated it; the oracle curator in `tests/eval.rs` must raise nDCG on the large corpus, so a change that makes curation hurt ranking fails there.

**Tests use a real store.** `server/src/test-support.ts` opens the engine in a temp directory;
nothing mocks the addon or SQLite. App tests mock only `src/lib/api.ts` (`vi.spyOn(api, …)`);
pages that use `Link` render through `app/src/test-support.tsx`'s `renderPage`, a one-route
memory router.

**Visualisation reads are capped and cached.** `viz.rs` in the engine serves the graph,
hierarchy, session turns with mentions, projection, growth and the query trace; every one takes a
`limit` and reports `truncated`/`total` so a 50k-turn store never crosses the boundary whole. The
projection basis is cached per `generation`. `query` is `query_trace` shrunk by `retrieve::to_result`, so the trace
cannot drift from the ranking it explains. Mention offsets
are UTF-8 bytes; the UI splits with `TextEncoder` (`app/src/lib/mentions.ts`), never `slice`.

**Charts follow the `dataviz` skill.** Colours come from the fixed slots in `app/src/index.css`
(`--viz-series-1..8`, sequential, status) through `app/src/lib/viz.ts`; a series keeps its slot
when a filter drops its neighbours (`SlotMap`), a ninth folds into "Other", entity kinds and
retrieval views have fixed slots. One axis per chart, a legend for two or more series, every chart
inside a `ChartCard` with a table twin, and `placeholderData` keeps the last render at reduced
opacity during a refetch. Canvas views resolve CSS variables with `resolveColor` so they follow
the theme.

**Health is in-process; eval is a file.** `server/src/metrics.ts` counts recalls, errors and
ingests per minute for the last hour; nothing is persisted. The Eval page reads the committed
`docs/eval/history.jsonl` (`EVAL_HISTORY` overrides), appended by `scripts/record-eval.sh`.

**The harness comes before the feature.** `crates/zeromem-core/tests/oracle.rs` asserts that a
store loaded from disk equals one rebuilt from the same turns, and `properties.rs` holds the
proptest invariants (order independence, idempotent ingest, delete-then-reingest). Every derived
index is added to `Snapshot` when it lands, so those tests cover it with no new code. The
fixtures under `crates/zeromem-harness/fixtures/` are generated, not hand-written: change
`corpus.rs`, run `npm run fixtures:gen`, commit both — `fixtures_are_fresh` fails otherwise.
Labeled queries carry graded relevance (2 = states the current value, 1 = a superseded one);
`zeromem_harness::eval` turns a ranked list into recall@k / MRR / nDCG, and `tests/eval.rs`
holds the floors — the quality gate. Raise a floor when retrieval improves; never lower one
without saying why in the commit. `tests/golden.rs` snapshots full results for the small corpus
(`UPDATE_GOLDEN=1` rewrites them after an intended ranking change). `zm-harness compare`
scores two rankers' answers against the labels and each other (top-k overlap, Spearman); that
is how the upstream binary is compared, tracked and never gated.

## Standards

This repo follows [`ai_tools/standards/`](../../standards/). In particular:

- [Project shape](../../standards/conventions/project-shape.md)
- [TypeScript and npm scripts](../../standards/conventions/typescript-and-scripts.md) — this image
  uses the type-stripping runtime model
- [Code style](../../standards/conventions/code-style.md)
- [Errors, logging and configuration](../../standards/conventions/errors-logging-config.md)
- [Testing](../../standards/conventions/testing.md)
- [Git and release](../../standards/conventions/git-and-release.md) — Conventional Commits,
  **never rebase**, and **no AI attribution trailers**
- [Docker and CI](../../standards/conventions/docker-and-ci.md)
- [MCP servers](../../standards/conventions/mcp-servers.md)

## Finding code

Prefer an LSP (definitions, references) over grep when navigating.
