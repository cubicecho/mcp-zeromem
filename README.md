# mcp-zeromem

Conversational memory for agents that costs zero tokens to maintain, over MCP.

Every turn an agent sees goes into one SQLite store. Recall over that store —
entity graph, temporal hierarchy, lexical and dense search — runs with no LLM
in the loop, so remembering is free and the only tokens spent are the ones the
model spends reading what came back. The method follows the
[zeromem paper](https://github.com/ptaranat/zeromem); the implementation here
is a clean-room rewrite in Rust, loaded in-process by a Node MCP server, with
persistent indexes so opening a large store does not mean rebuilding it.

**Status: Parts 1 and 2 complete.** The engine stores turns with their
entity spans, tokens and embeddings in one transaction, keeps the entity
graph, temporal hierarchy and lexical statistics on disk stamped with a
generation counter, and recalls over four views (lexical, entity, dense,
recent) fused by reciprocal rank and calibrated into a primary/supporting
evidence set. The Node server exposes six MCP tools over Streamable HTTP and
stdio plus a REST API. The admin UI shows the store's structure, not just its
counts: an entity graph, a timeline of the temporal hierarchy, a session
inspector with entity spans, a retrieval trace for any query, an embedding
map, a side-by-side compare, growth and health charts, and the eval history.
Quality is gated by a labeled eval set; a 50k-turn store opens in under
300 ms.

## Quick start

```bash
cp .env.example .env
# Fill in MCP_ZEROMEM_TOKEN:  openssl rand -hex 32
docker compose up -d --build
curl -s localhost:3200/api/status | jq .
```

Then point a client at `http://localhost:3200/mcp` with
`Authorization: Bearer $MCP_ZEROMEM_TOKEN`. For Claude Code:

```bash
claude mcp add --transport http zeromem http://localhost:3200/mcp \
  --header "Authorization: Bearer $MCP_ZEROMEM_TOKEN"
```

The admin UI is at `http://localhost:3200/`; it asks for the same token.

Locally, without Docker (needs a Rust toolchain and Node 26):

```bash
npm install
npm run build:native      # builds the addon; rerun after any Rust change
SECURE_LOCAL_NET=true npm run dev
```

## Writing to the store

Three ways in, all landing in the same `./data/zeromem.db`:

- **MCP write tools** (`zeromem_remember`, `zeromem_ingest`), for an agent to
  store what it decides is worth keeping.
- **`zm` inside the container**, for hooks and bulk loads with no server hop:

  ```bash
  printf '{"session_id":"s1","speaker":"user","text":"we chose postgres"}\n' \
    | docker compose exec -T mcp-zeromem zm ingest
  ```

- **`zm` on the host**, pointed at the bind-mounted directory
  (`ZEROMEM_HOME=./data zm ingest`). The store is SQLite in WAL mode, so a host
  writer and the server coexist; the server notices new turns on its next read.

Turns are deduplicated by content (or by an explicit `uuid`), so re-ingesting a
transcript is idempotent and reports `duplicates` rather than double-counting.

### Remembering Claude Code sessions automatically

`zm hook` reads a Claude Code hook event (`{"transcript_path", "session_id"}`)
from stdin and remembers the transcript's user and assistant turns. Wire it to
`Stop` and `SessionEnd` in `~/.claude/settings.json`. Two ways to run it:

- **Host `zm`** (simplest; needs `cargo install --path crates/zeromem-core`):

  ```json
  { "hooks": { "Stop": [{ "hooks": [{ "type": "command",
      "command": "ZEROMEM_HOME=$HOME/mcp-zeromem/data zm --embedder none hook" }] }] } }
  ```

  `--embedder none` keeps the hook from loading a model or calling an
  endpoint: the turns land without vectors and the server embeds them with
  the store's embedder on its next read (they are searchable lexically in the
  meantime). Leave the flag off to have the hook embed inline with whatever
  the store uses, which needs `ZEROMEM_MODELS` pointing at `data/models` for
  the ONNX model — or run it in the container:

- **`zm` in the container**, with the transcripts mounted read-only and the
  path prefix mapped:

  ```yaml
  # docker-compose.override.yml
  services:
    mcp-zeromem:
      volumes:
        - ~/.claude:/host-claude:ro
      environment:
        ZEROMEM_HOOK_MAP: /home/me/.claude=/host-claude
  ```

  ```json
  { "type": "command", "command": "docker compose -f ~/mcp-zeromem/docker-compose.yml exec -T mcp-zeromem zm hook" }
  ```

  `ZEROMEM_HOOK_MAP` rewrites the host path in the event to where the
  container sees it; without it the hook fails with "reading transcript".

Set `ZEROMEM_SESSION_ID` on the server (or pass `exclude_session`) so recall
does not hand the current conversation back to itself.

## Tools

| Tool | What it does |
| --- | --- |
| `zeromem_recall` | `{query, top_k, exclude_session?, session?, since?, until?, detail, format?, context?, max_chars?}` — evidence turns with score, role (`primary`/`supporting`) and, with `detail: full`, the route taken and each turn's sources; `format: text` returns one block per hit instead, for pasting into a prompt |
| `zeromem_read_session` | `{session_id? \| around_turn?, before?, after?, limit?, offset?, format?}` — stored turns in the order they were said, either a whole session or a window centred on one turn; reports `total` and `truncated` |
| `zeromem_remember` | `{session_id, turns[{speaker, text, ts?, uuid?}]}` — reports `indexed` / `duplicates` |
| `zeromem_ingest` | Bulk JSON Lines, inline (`jsonl`) or from a file under the data directory (`path`) |
| `zeromem_stats` | Counts (turns, sessions, entities, edges, windows, episodes, embeddings), the embedder in use and whether it is the fallback; `include_sessions` adds the session list |
| `zeromem_forget_session` | Deletes a session's turns; requires `confirm: true` |

Set `ZEROMEM_READ_ONLY=true` to drop the three write tools from the listing
entirely.

A client holding the curator token also gets five `zeromem_curate_*` tools and
the `zeromem_curate` prompt; see [Curation](#curation).

### How recall answers

A hit is one turn, and one turn is rarely the whole answer — the question that
prompted it and the sentence that finished it are the turns either side.
`context: N` attaches up to N same-session turns on each side of every hit, as
`before` and `after` (and as `[before]` / `[after]` lines under `format: text`).
Neighbours are **attached to** evidence, never ranked **with** it: `evidence` is
identical with and without `context`, so a neighbour never takes a slot from a
real hit, and a turn that is already ranked is not repeated as another hit's
context. Hidden turns stay hidden, leaving a gap rather than being backfilled.

`format: text` keeps a turn's line breaks — a numbered list stays a list — and
cuts a turn only past `max_chars` (default `ZEROMEM_RECALL_TEXT_LIMIT`, 2000
characters). A real cut is marked, and the marker names the call that returns the
rest: `… [clipped: 2000 of 6120 characters — zeromem_read_session {around_turn:
418}]`. That matters because a model handed a fragment with no marker concludes
its memory is incomplete and goes looking elsewhere; `zeromem_read_session`
never clips, since it is what the marker points at. `format: json` has never
truncated.

The same operations are on the REST API the UI uses (`/api/status`,
`/api/sessions`, `/api/sessions/:id/turns`, `/api/recall`, `/api/recall/trace`,
`/api/ingest`), under the same bearer token.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_ZEROMEM_TOKEN` | — | Bearer token for `/mcp`. The HTTP server refuses to start without one unless `SECURE_LOCAL_NET=true` |
| `SECURE_LOCAL_NET` | — | `true` disables auth: for a trusted network only |
| `ZEROMEM_READ_ONLY` | `false` | Hide the write tools |
| `ZEROMEM_RECALL_TEXT_LIMIT` | `2000` | Characters per turn before `format: text` clips and marks the cut; `max_chars` overrides it per call (100–20000) |
| `MCP_ZEROMEM_CURATOR_TOKEN` | — | Bearer token for `/mcp` that adds the curator tools. Overrides a token set from the Settings page (see [Curation](#curation)) |
| `ZEROMEM_CURATOR` | `false` | Stdio server only: serve the curator tools |
| `DATA_DIR` | `/data` in the image, `./data` on the host | Where the store lives. Also exported to the engine as `ZEROMEM_HOME`; if both are set they must agree |
| `ZEROMEM_EMBEDDER` | `auto` | The embedder for a **new** store: `auto` loads bge-small-en-v1.5 over ONNX and falls back to a hashed embedder, loudly, if it cannot; `onnx` refuses to start instead; `hash` never downloads anything; `openai` uses the endpoint below; `none` gives this process no dense view. An existing store keeps the embedder it was built with (see [Choosing an embedder](#choosing-an-embedder)) |
| `ZEROMEM_ALLOW_EMBEDDER_SWITCH` | `false` | Force an existing store onto `ZEROMEM_EMBEDDER` at boot: drops every vector and re-embeds in the background |
| `ZEROMEM_EMBEDDING_URL` | — | Base URL of an OpenAI-compatible embeddings API, e.g. `http://npu-box:11434/v1`; required with `ZEROMEM_EMBEDDER=openai` |
| `ZEROMEM_EMBEDDING_MODEL` | — | Model name sent to that endpoint, e.g. `nomic-embed-text` |
| `ZEROMEM_EMBEDDING_API_KEY` | — | Bearer token for the endpoint. Overrides a key saved from the Settings page; never returned by the API |
| `ZEROMEM_EMBEDDING_QUERY_PREFIX`, `ZEROMEM_EMBEDDING_DOCUMENT_PREFIX` | `""` | Prepended to queries and to stored turns, for models that want them (`query: ` / `passage: ` for E5) |
| `ZEROMEM_EMBEDDING_TIMEOUT_MS` | `5000` | Per-request timeout for the endpoint |
| `ZEROMEM_MODELS` | `<DATA_DIR>/models` | Where the model is downloaded to (≈130 MB, once) |
| `ZEROMEM_SESSION_ID` | — | Session left out of `zeromem_recall` by default |
| `EVAL_HISTORY` | `docs/eval/history.jsonl` | The eval runs the Eval page charts |
| `PORT` | `3000` | Listen port inside the container (published as 3200) |

`GET /api/status` is unauthenticated liveness and is what the healthcheck polls.
It carries `embedder`, `embedder_is_fallback`, `embedder_active` and
`embedding_backlog`; the UI shows a banner when the fallback is in use, because
hashed vectors make dense recall a spelling match rather than a meaning match,
and a progress line while turns are waiting for a vector.

### Choosing an embedder

**The store owns the embedder.** The first process to open a store writes the
embedder it was started with into the store's `meta`; from then on every
process that opens it — the server, a stdio MCP session, a host-side `zm` —
follows the store, and a differing `ZEROMEM_EMBEDDER` is logged and ignored.
That is what keeps recall coherent when three processes share one file.

Three kinds of embedder are available:

| Kind | Name in `meta` | Notes |
| --- | --- | --- |
| Built-in BGE-small (ONNX) | `bge-small-en-v1.5` | 384 dims, in-process, ≈130 MB download on first use |
| Hash fallback | `hash-384` | Deterministic bag-of-words, no download; a spelling match, not a meaning match |
| OpenAI-compatible endpoint | `openai:<model>@<dim>` | Anything serving `POST /v1/embeddings` — Ollama, llama.cpp, vLLM, LM Studio, a box with an NPU, or the hosted API. The dimension is learned from the first response |

Change it from the **Settings** page: pick the kind, fill in the endpoint,
**Test connection** (reports the dimension and latency without touching the
store), then **Apply**. The switch is one transaction — spec written, vectors
dropped, generation bumped — and the server's embed worker re-embeds every
turn in the background in batches of 256. Recall keeps answering from the
lexical and entity views while the backlog drains; the progress bar on
Settings, the Overview and the Embeddings page shows how far along it is.
Headless hosts do the same with the CLI:

```bash
zm embedder show
zm embedder test --kind openai --url http://npu-box:11434/v1 --model nomic-embed-text
zm embedder set  --kind openai --url http://npu-box:11434/v1 --model nomic-embed-text --api-key-stdin < key.txt
zm embedder reembed    # drop every vector and re-make them with the current embedder
zm embedder drain      # re-embed the backlog now instead of waiting for the server
```

When a switch stalled half way, or the model behind an endpoint was replaced
under the same name, **Re-embed all turns** on the Settings page (or
`zm embedder reembed`) starts over with the embedder the store already names.
It is tested first, as a switch is, so an endpoint that still fails is
reported and no vector is dropped. The **Stored data** card below it clears
the store: **Clear vectors** drops every vector without testing anything
(the worker re-embeds them), and **Clear all memory** forgets every turn,
session, entity and summary, after you type `clear`. Both keep the embedder
settings, bump the generation so every other process reloads, and are
refused under `ZEROMEM_READ_ONLY` (`POST /api/settings/embedder/reembed`,
`POST /api/settings/clear` with `{"scope": "embeddings" | "memory"}`).

An API key entered on the Settings page is saved in the store's `meta` table
**in plain text**, so the stdio process and a host `zm` can use the same
endpoint. `ZEROMEM_EMBEDDING_API_KEY` in the environment overrides it wherever
it is set; the page says which one is in use and the API never returns either.
Leave the key field blank to keep the stored one.

If a process cannot build the store's embedder — no model files at hand, the
endpoint is down — it runs **without a dense view and says so**
(`embedder_active: false`, `embedder_warning` in the status), storing new turns
vectorless for the worker rather than silently substituting the hash embedder.
A remote endpoint that starts failing trips a breaker for 30 s so a recall
under load never waits out the timeout call after call.

## Seeing the store

The admin UI at `/` (same port as `/mcp`) has a page per structure the engine
keeps. Each chart has a table twin, so every number on screen can be read as
text.

| Page | What it shows | Read behind it |
| --- | --- | --- |
| Overview | Counts, embedder, turns per day and the running total | `/api/status`, `/api/viz/growth` |
| Sessions → inspect | A session's turns in order with entity spans highlighted; click one to follow it across the session, or jump to it in the graph | `/api/viz/sessions/:id/turns` |
| Graph | Force-directed entity graph: node size is degree, edge weight is shared turns; focus an entity and expand N hops; click a node for its neighbours and the turns recall finds for it | `/api/viz/graph` |
| Timeline | Sessions as lanes, windows as bands, episodes as inner segments; brush a range for the turns beneath it | `/api/viz/hierarchy` |
| Recall → Trace | One query through every stage: profile, the views it was routed to with their raw candidates, the fused list, what calibration dropped and why, the evidence | `/api/recall/trace` |
| Embeddings | 2-D PCA of the dense vectors, coloured by session; drop a query on the map to ring its nearest turns. Under the hash fallback the structure collapses, which is the point | `/api/viz/projection` |
| Compare | The same query with two settings side by side (top-k, session filters); pin side A, change B, and read the diff of the evidence sets | `/api/recall` |
| Eval | recall@k / MRR / nDCG per commit, one line per corpus × embedder | `/api/viz/eval` |
| Health | Recall latency percentiles and throughput per minute for the last hour, cold-open time, errors, then the raw status payload | `/api/viz/health` |
| Settings | The store's embedder: current name, kind and dimension, the re-embed progress, a form to test and switch to the ONNX model, the hash fallback or an OpenAI-compatible endpoint, re-embedding with the current one; and clearing the vectors or the whole memory | `/api/settings/embedder`, `/api/settings/clear` |
| Curation | Curator runs with the actions each took and why; undo one action or a whole run; the aliases and blocklist in force | `/api/curation/runs`, `/api/curation/actions`, `/api/curation/aliases` |

Every snapshot endpoint is capped (`limit`) so a 50k-turn store never lands
whole in a browser tab; the graph page says when it cut at the node cap. The
projection is computed in Rust and cached per generation. Health counters are
in-process and reset with the server.

The eval page reads `docs/eval/history.jsonl` (override with `EVAL_HISTORY`).
`scripts/record-eval.sh [label]` runs the harness and appends one line per
corpus × embedder, stamped with the commit; commit the file with the change
that moved the numbers.

## Curation

The store only grows: near-duplicates, pasted tool output and "ok, thanks" compete
in recall, one person is split across "Maya" and "Maya Okafor", and an old fact
ranks level with the one that replaced it. A **curator** is any MCP client, most
usefully an LLM agent on a schedule, that cleans this up. The engine stays
deterministic: it finds candidates cheaply and applies reversible operations. The
judgement, the only part that costs tokens, lives in the agent.

**Curation never deletes.** Turns are immutable; every action is logged with its
reason and can be undone from the Curation page. Purging is left to a human
(`zeromem_forget_session`, Settings → Stored data).

| Op | Effect on recall |
| --- | --- |
| `hide` / `unhide` | The turn is left out of recall (still shown, flagged, in session reads) |
| `supersede` | The old turn hands its score to its replacement, which is recalled in its place even when it shares few words with the question; the old turn is halved and folds away when both make the answer. Temporal questions ("what did … used to …") are left alone |
| `alias` / `unalias` | Mentions of the alias count as the canonical entity in the graph and entity stats |
| `block` / `unblock` | The name is not an entity at all |
| `note` | A new turn (`kind: note`, speaker `zeromem-curator`) summarising source turns; when both make the list the sources fold under the note |
| `run_end` | Records the run's summary and advances the cursor the finders start from |

### The curator surface

| Tool | What it does |
| --- | --- |
| `zeromem_curate_runs` | Past runs, their action counts and summaries, the cursor, and the limits in force |
| `zeromem_curate_candidates` | `{kind, since_turn_id?, limit?, offset?}`: candidates of one kind (`duplicates`, `noise`, `aliases`, `supersession`, `consolidation`), each with a score, a reason and a suggested op; `scanned_through` is the cursor to hand to `run_end` |
| `zeromem_curate_read` | `{turn_ids? \| session_id? \| entity?}`: turns with their flags, supersession links and covering notes |
| `zeromem_curate_apply` | `{run_id, actions[{op, …, reason}], dry_run?}`: applies a batch; each action is accepted or rejected on its own |
| `zeromem_curate_undo` | `{action_id? \| run_id?}` |

The `zeromem_curate` prompt carries the procedure
([`docs/curator-playbook.md`](docs/curator-playbook.md)), so a client gets it from the
server: orient, gather candidates since the cursor, judge (when unsure, skip), dry
run, apply in batches, finish with `run_end`. Its optional `focus` argument limits a
run to some kinds.

### Access and limits

Settings → Curator holds all of it:

- **The curator token.** Generate one (shown once) or paste your own. A request to
  `/mcp` bearing it gets the normal tools plus the curator surface; the normal token
  never sees them, so an ordinary agent keeps its six-tool budget. The token opens
  `/mcp` only, not the REST API. `MCP_ZEROMEM_CURATOR_TOKEN` overrides the stored one,
  and the page then says so and will not change it.
- **Serve the curator tools to every client.** Off by default; on, every `/mcp`
  client and the stdio server get them, token or not.
- **Limits.** Actions per call (default 100), actions per run (300), and a minimum
  turn age (24 h) so a live conversation is never curated under the user. A reason
  is required on every action.

`ZEROMEM_READ_ONLY` drops the curator's write tools like the others. For the stdio
server, `ZEROMEM_CURATOR=true` serves the curator tools.

### Scheduling a curator

The server runs no agent. Anything that speaks MCP can be the curator, from this
machine or another; it needs the `/mcp` URL and the curator token, no shared disk.
Notes it writes are embedded by this server.

A Claude Code scheduled task, or `claude -p` under cron, with an MCP config that
points at the store:

```json
{
  "mcpServers": {
    "zeromem": {
      "type": "http",
      "url": "http://memory-host:3200/mcp",
      "headers": { "Authorization": "Bearer ${ZEROMEM_CURATOR_TOKEN}" }
    }
  }
}
```

```cron
# Nightly at 03:30: run the playbook the server serves as its zeromem_curate prompt.
30 3 * * * claude -p "/mcp__zeromem__zeromem_curate" --mcp-config /etc/zeromem/curator.json --allowedTools "mcp__zeromem__*"
```

An Agent SDK script does the same from code: fetch the prompt, hand it to the agent
as its task, and let it call the tools.

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = 'http://memory-host:3200/mcp';
const headers = { Authorization: `Bearer ${process.env.ZEROMEM_CURATOR_TOKEN}` };

const client = new Client({ name: 'curator', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
const { messages } = await client.getPrompt({ name: 'zeromem_curate' });
await client.close();
const playbook = messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');

for await (const message of query({
  prompt: playbook,
  options: {
    mcpServers: { zeromem: { type: 'http', url, headers } },
    allowedTools: ['mcp__zeromem__*'],
  },
})) {
  if (message.type === 'result') console.log(message.subtype);
}
```

Review a run on the Curation page. Undoing a run restores recall to what it was.

## How recall works

Ingest writes, in one transaction, the turn, its entity spans (names, dates,
quantities, paths, code symbols and env vars found by shape, no model), its FTS5 tokens and its embedding —
or no embedding, when the writer has no dense view; every read then embeds
one batch of the backlog first, and the server's worker drains the rest.
The entity co-occurrence graph and the temporal hierarchy (sessions → windows
→ episodes, split on silences and on entity drift between windows) are
persisted next to them; appends update them incrementally, `forget` rebuilds
the aggregates from the per-turn artifacts and bumps a `generation` stamp so
every other process holding the store reloads. Opening a store is a read,
never a recomputation.

A query is profiled (tokens, entities, temporal cues, question form), routed
to the views that can answer it, and each view's ranked candidates are fused
by reciprocal rank. The fused list is calibrated: candidates under 0.35 are
dropped, those at 0.7 or above are `primary`, the rest `supporting`. With
`detail: full` the result carries the route and per-turn sources; the
`/api/recall/trace` endpoint (and `zm query --trace`) returns every stage.

## Numbers

Hash embedder, one core, `npm run bench` (`cargo run --release --example
bench`); CI keeps the JSON as an artifact.

| turns | ingest | cold open | RSS after open | recall p50 | recall p95 | store |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1k | 19k turns/s | 4 ms | 19 MB | 2.2 ms | 4.1 ms | 2.4 MB |
| 10k | 14k turns/s | 58 ms | 53 MB | 18 ms | 32 ms | 24 MB |
| 50k | 9.2k turns/s | 281 ms | 126 MB | 83 ms | 121 ms | 121 MB |

Recall is linear in store size (brute-force cosine over every vector plus a
full lexical scan); an ANN index is the follow-up when stores pass 100k turns.

Eval (`cargo test -p zeromem-core --test eval`, recall@5 / MRR / nDCG@5 over
the labeled fixtures):

| corpus | hash-384 | bge-small-en-v1.5 |
| --- | --- | --- |
| small (10 queries) | 0.90 / 0.83 / 0.84 | 0.90 / 0.90 / 0.90 |
| large (323 queries) | 0.71 / 0.90 / 0.67 | 0.88 / 0.97 / 0.82 |

The floors in `tests/eval.rs` sit a little under these; raising them is how
retrieval improvements are locked in. With `ZEROMEM_EMBEDDING_URL` and
`ZEROMEM_EMBEDDING_MODEL` set the eval also scores that endpoint, recorded but
never gated, so `scripts/record-eval.sh` gives your model its own line on the
Eval page.

### Comparing against upstream

The upstream binary is a black box here (see the clean-room policy). To
compare rankings, run both over the same fixture turns and score the lists:

```bash
scripts/rank.sh large 5 > ours.jsonl          # our answers, one {"id","ranked":[uuid…]} per line
# …run the other ranker over crates/zeromem-harness/fixtures/large/turns.jsonl
#    and emit the same shape as theirs.jsonl
cargo run -q -p zeromem-harness -- compare large ours.jsonl theirs.jsonl
```

That prints both sides' metrics against the labels, plus top-k overlap and
Spearman rank agreement. The adapter that drives upstream's binary is not in
this repo yet; CI uploads `ours.jsonl` for every commit so it can be run
against any version. The comparison is tracked, never gated: the labels are
the gate.

## Layout

```
crates/zeromem-core/   the engine (Rust lib) + the `zm` CLI; tests/ holds the oracle + properties
crates/zeromem-harness/ corpus generator, labeled queries, eval metrics; fixtures/ is generated
crates/zeromem-node/   napi-rs addon → @mcp-zeromem/native
shared/src/            zod DTOs shared by server and app
server/src/            Express 5: /api routes (viz/ for the charts), /mcp gateway, stdio bin, metrics.ts
app/src/               React admin UI; routes/ is one file per page, components/viz/ the chart kit
docs/eval/             history.jsonl, the recorded eval runs the Eval page reads
scripts/               smoke-stdio.sh, rank.sh, record-eval.sh
```

## Development

```bash
npm run lint && npm run typecheck && npm test && npm run test:rust
npm run build            # addon → shared → server → app
./scripts/smoke-stdio.sh # JSON-RPC over the stdio bin
npm run bench            # cold open / RSS / recall latency at 1k, 10k, 50k turns
scripts/record-eval.sh   # append this commit's eval metrics to docs/eval/history.jsonl
npm run routes:gen -w app # regenerate app/src/routeTree.gen.ts after adding a route file
```

Charts follow the `dataviz` house rules: a fixed eight-slot categorical
palette (`--viz-series-1..8` in `app/src/index.css`, validated for both
themes) that is never cycled, one axis per chart, thin marks, a legend for
two or more series, a table view for every chart, and the previous render
held at reduced opacity while a refetch is in flight.

`npm run test:rust` downloads the embedding model into `target/models` on
first run (set `ZEROMEM_SKIP_ONNX=1` to skip the ONNX halves of the
reference-vector and eval tests). `UPDATE_GOLDEN=1` rewrites the retrieval
snapshots under `crates/zeromem-core/tests/golden/` after an intended ranking
change; review the diff.

The repo is a clean-room rewrite: no code, scripts, fixtures or schema from the
upstream project are used, and none may be added. See the policy in
[`AGENTS.md`](AGENTS.md).
