//! The Node face of the engine.
//!
//! One `Engine` object per store. Every method that touches the store is
//! `async` and does its work on a blocking thread, because the engine is
//! CPU-bound — an embedding forward pass, an index load — and Node has one
//! event loop that must never wait on it. A mutex serialises engine access;
//! SQLite is serialising underneath anyway.
//!
//! Results cross as plain objects via serde, so the shapes here are the
//! `zeromem_core::types` shapes and the TypeScript side validates them with
//! zod rather than trusting the `.d.ts` alone.

use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi::tokio::task::spawn_blocking;
use napi_derive::napi;
use zeromem_core::curation::finders::{CandidateKind, FinderOptions};
use zeromem_core::curation::{CurationAction, CuratorConfig, TurnSelector, UndoTarget};
use zeromem_core::dense::{EmbedderChoice, EmbedderSpec, RemoteSpec};
use zeromem_core::viz;
use zeromem_core::{Detail, OpenOptions, QueryOptions, TurnInput, ZeroMem};

/// An OpenAI-compatible endpoint, as the seed for a fresh store or the
/// target of a forced switch when `embedder` is `openai`.
#[napi(object)]
#[derive(Default, Clone)]
pub struct RemoteEmbedderOptions {
    /// Base URL up to `/v1`, e.g. `http://npu-box:8080/v1`.
    pub url: String,
    pub model: String,
    /// Vector length; learned from the first response when omitted.
    pub dim: Option<u32>,
    #[napi(js_name = "query_prefix")]
    pub query_prefix: Option<String>,
    #[napi(js_name = "document_prefix")]
    pub document_prefix: Option<String>,
    #[napi(js_name = "timeout_ms")]
    pub timeout_ms: Option<u32>,
    #[napi(js_name = "max_chars")]
    pub max_chars: Option<u32>,
}

impl From<RemoteEmbedderOptions> for RemoteSpec {
    fn from(o: RemoteEmbedderOptions) -> Self {
        let defaults = RemoteSpec::default();
        RemoteSpec {
            url: o.url,
            model: o.model,
            dim: o.dim.map(|d| d as usize),
            api_key: None,
            query_prefix: o.query_prefix.unwrap_or_default(),
            document_prefix: o.document_prefix.unwrap_or_default(),
            timeout_ms: o.timeout_ms.map(u64::from).unwrap_or(defaults.timeout_ms),
            max_chars: o.max_chars.map(|m| m as usize).unwrap_or(defaults.max_chars),
        }
    }
}

#[napi(object)]
#[derive(Default)]
pub struct EngineOpenOptions {
    /// `auto` (default), `onnx`, `hash`, `openai` or `none`. A store records
    /// its own embedder and is followed whatever this says; the choice seeds a
    /// fresh store, or forces a switch under `allow_embedder_switch`.
    pub embedder: Option<String>,
    /// Allow opening a store built by a different embedder; every vector is dropped and re-made.
    #[napi(js_name = "allow_embedder_switch")]
    pub allow_embedder_switch: Option<bool>,
    /// The endpoint `openai` refers to.
    pub remote: Option<RemoteEmbedderOptions>,
    /// Bearer token for a remote endpoint; overrides the key stored in the store.
    #[napi(js_name = "api_key")]
    pub api_key: Option<String>,
    /// When false this process never talks to a remote endpoint and leaves
    /// embedding to whoever does (default true).
    #[napi(js_name = "follow_remote")]
    pub follow_remote: Option<bool>,
}

impl TryFrom<EngineOpenOptions> for OpenOptions {
    type Error = Error;
    fn try_from(o: EngineOpenOptions) -> Result<Self> {
        let embedder = match o.embedder.as_deref() {
            None => EmbedderChoice::Auto,
            Some(name) => EmbedderChoice::parse(name).ok_or_else(|| {
                Error::from_reason(format!("unknown embedder `{name}`: use auto, onnx, hash, openai or none"))
            })?,
        };
        let remote = o.remote.map(RemoteSpec::from);
        if embedder == EmbedderChoice::OpenAi && remote.is_none() {
            return Err(Error::from_reason("embedder `openai` needs `remote` with a url and a model"));
        }
        Ok(OpenOptions {
            embedder,
            allow_embedder_switch: o.allow_embedder_switch.unwrap_or(false),
            remote,
            api_key: o.api_key.filter(|k| !k.trim().is_empty()),
            follow_remote: o.follow_remote.unwrap_or(true),
        })
    }
}

fn parse_spec(spec: serde_json::Value) -> Result<EmbedderSpec> {
    serde_json::from_value(spec).map_err(|e| Error::from_reason(format!("bad embedder spec: {e}")))
}

#[napi(object)]
#[derive(Default)]
pub struct RecallOptions {
    /// How many evidence items at most; default 5, capped at 50.
    #[napi(js_name = "top_k")]
    pub top_k: Option<u32>,
    /// Leave out this session, typically the one asking.
    #[napi(js_name = "exclude_session")]
    pub exclude_session: Option<String>,
    /// Only this session.
    pub session: Option<String>,
    /// Only turns at or after this timestamp (ms).
    pub since: Option<i64>,
    /// Only turns at or before this timestamp (ms).
    pub until: Option<i64>,
    /// `compact` (default) or `full`.
    pub detail: Option<String>,
    /// Include turns curation hid; they come back flagged `hidden`.
    #[napi(js_name = "include_hidden")]
    pub include_hidden: Option<bool>,
    /// Attach this many same-session turns either side of each hit; default
    /// 0, capped at 10. They fill `before`/`after` and never join the ranking.
    pub context: Option<u32>,
}

impl TryFrom<RecallOptions> for QueryOptions {
    type Error = Error;
    fn try_from(o: RecallOptions) -> Result<Self> {
        let detail = match o.detail.as_deref() {
            None | Some("compact") => None,
            Some("full") => Some(Detail::Full),
            Some(other) => return Err(Error::from_reason(format!("unknown detail `{other}`: use compact or full"))),
        };
        Ok(QueryOptions {
            top_k: o.top_k,
            exclude_session: o.exclude_session,
            session: o.session,
            since: o.since,
            until: o.until,
            detail,
            include_hidden: o.include_hidden,
            context: o.context,
        })
    }
}

#[napi(object)]
#[derive(Clone)]
pub struct Turn {
    /// Named to match the JSONL ingest format and every result shape, which are all snake_case.
    #[napi(js_name = "session_id")]
    pub session_id: String,
    pub speaker: String,
    pub text: String,
    /// Milliseconds since the Unix epoch; "now" when omitted.
    pub ts: Option<i64>,
    /// Dedup key; derived from the content when omitted.
    pub uuid: Option<String>,
}

impl From<Turn> for TurnInput {
    fn from(t: Turn) -> Self {
        TurnInput { session_id: t.session_id, speaker: t.speaker, text: t.text, ts: t.ts, uuid: t.uuid }
    }
}

#[napi(object)]
pub struct Page {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

// --- options for the visualisation reads -------------------------------------

#[napi(object)]
#[derive(Default)]
pub struct GraphOptions {
    /// At most this many nodes; default 200, capped at 2000.
    pub limit: Option<u32>,
    /// Drop edges seen in fewer turns than this; default 1.
    #[napi(js_name = "min_weight")]
    pub min_weight: Option<u32>,
    /// Start from this entity and expand `hops` steps instead of taking the most-mentioned entities.
    pub focus: Option<String>,
    /// Default 1, capped at 3.
    pub hops: Option<u32>,
    /// Only entities of this kind (`name`, `date`, `quantity`, `path`, `symbol`, `env`).
    pub kind: Option<String>,
}

impl From<GraphOptions> for viz::GraphOptions {
    fn from(o: GraphOptions) -> Self {
        viz::GraphOptions { limit: o.limit, min_weight: o.min_weight, focus: o.focus, hops: o.hops, kind: o.kind }
    }
}

#[napi(object)]
#[derive(Default)]
pub struct HierarchyOptions {
    /// Sessions per page; default 50, capped at 500.
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    /// Only sessions active at or after this (ms).
    pub since: Option<i64>,
    /// Only sessions active at or before this (ms).
    pub until: Option<i64>,
    /// Just this one session.
    pub session: Option<String>,
}

impl From<HierarchyOptions> for viz::HierarchyOptions {
    fn from(o: HierarchyOptions) -> Self {
        viz::HierarchyOptions { limit: o.limit, offset: o.offset, since: o.since, until: o.until, session: o.session }
    }
}

#[napi(object)]
#[derive(Default)]
pub struct ProjectionOptions {
    /// At most this many points; default 2000, capped at 10000.
    pub limit: Option<u32>,
    /// Only this session's turns.
    pub session: Option<String>,
    /// Drop this text onto the plane and mark its nearest turns.
    pub query: Option<String>,
}

#[napi(object)]
#[derive(Default)]
pub struct TimeRange {
    pub since: Option<i64>,
    pub until: Option<i64>,
}

/// The curator settings to store. Every field is required: the settings
/// page sends the whole object.
#[napi(object)]
pub struct CuratorConfigInput {
    #[napi(js_name = "max_per_call")]
    pub max_per_call: u32,
    #[napi(js_name = "max_per_run")]
    pub max_per_run: u32,
    #[napi(js_name = "min_age_ms")]
    pub min_age_ms: i64,
    /// At least 16 characters; empty or absent clears it.
    pub token: Option<String>,
    #[napi(js_name = "expose_to_all")]
    pub expose_to_all: bool,
}

impl From<CuratorConfigInput> for CuratorConfig {
    fn from(c: CuratorConfigInput) -> Self {
        CuratorConfig {
            max_per_call: c.max_per_call,
            max_per_run: c.max_per_run,
            min_age_ms: c.min_age_ms,
            token: c.token,
            expose_to_all: c.expose_to_all,
        }
    }
}

/// Exactly one of the two.
#[napi(object)]
pub struct UndoInput {
    #[napi(js_name = "action_id")]
    pub action_id: Option<i64>,
    #[napi(js_name = "run_id")]
    pub run_id: Option<String>,
}

#[napi(object)]
#[derive(Default)]
pub struct CandidateOptions {
    /// Look only at turns after this id; defaults to the run cursor.
    #[napi(js_name = "since_turn_id")]
    pub since_turn_id: Option<i64>,
    /// Candidates per page; default 20, at most 100.
    pub limit: Option<u32>,
    /// For aliases and consolidation: skip this many ranked candidates.
    pub offset: Option<u32>,
}

/// Which turns to read: by id, a whole session, or those mentioning an entity.
#[napi(object)]
#[derive(Default)]
pub struct CurationSelector {
    #[napi(js_name = "turn_ids")]
    pub turn_ids: Option<Vec<i64>>,
    #[napi(js_name = "session_id")]
    pub session_id: Option<String>,
    pub entity: Option<String>,
}

/// Which turns of a conversation to read: the whole session, or a window
/// centred on one turn. Clamping lives in the engine so `zm` and this agree.
#[napi(object)]
#[derive(Default)]
pub struct SessionWindowOptions {
    /// Required unless `around_turn` names the turn to take the session from.
    #[napi(js_name = "session_id")]
    pub session_id: Option<String>,
    /// Centre the window on this turn id — the id a recall hit carries.
    #[napi(js_name = "around_turn")]
    pub around_turn: Option<i64>,
    /// With `around_turn`: turns before it; default 5.
    pub before: Option<u32>,
    /// With `around_turn`: turns after it; default 5.
    pub after: Option<u32>,
    /// Without `around_turn`: how many turns; default 50, at most 200.
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

impl From<SessionWindowOptions> for zeromem_core::SessionWindowOptions {
    fn from(o: SessionWindowOptions) -> Self {
        Self {
            session_id: o.session_id,
            around_turn: o.around_turn,
            before: o.before,
            after: o.after,
            limit: o.limit,
            offset: o.offset,
        }
    }
}

type Shared = Arc<Mutex<ZeroMem>>;

#[napi]
pub struct Engine {
    inner: Shared,
    home: String,
}

fn to_napi<E: std::fmt::Display>(err: E) -> Error {
    Error::from_reason(err.to_string())
}

/// Run `f` against the engine on a blocking thread and hand its serde
/// serialisable result back as a JS object.
async fn with_engine<T, F>(inner: &Shared, f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&mut ZeroMem) -> zeromem_core::Result<T> + Send + 'static,
{
    let inner = Arc::clone(inner);
    spawn_blocking(move || {
        let mut guard = inner.lock().map_err(|_| Error::from_reason("engine mutex poisoned"))?;
        f(&mut guard).map_err(to_napi)
    })
    .await
    .map_err(to_napi)?
}

#[napi]
impl Engine {
    /// Open (creating if needed) the store at `home`.
    #[napi(factory)]
    pub fn open(home: String, opts: Option<EngineOpenOptions>) -> Result<Engine> {
        let opts: OpenOptions = opts.unwrap_or_default().try_into()?;
        let zm = ZeroMem::open(&home, opts).map_err(to_napi)?;
        Ok(Engine { inner: Arc::new(Mutex::new(zm)), home })
    }

    #[napi(getter)]
    pub fn home(&self) -> String {
        self.home.clone()
    }

    /// Counts for the store, the embedder in use and whether it is the fallback.
    #[napi(ts_return_type = "Promise<Stats>")]
    pub async fn stats(&self) -> Result<serde_json::Value> {
        with_engine(&self.inner, |zm| zm.stats().map(|s| serde_json::to_value(s).unwrap())).await
    }

    /// Remember one turn. Returns `{ outcome: 'indexed' | 'duplicate', id }`.
    #[napi(ts_return_type = "Promise<IngestOutcome>")]
    pub async fn ingest_turn(&self, turn: Turn) -> Result<serde_json::Value> {
        let input: TurnInput = turn.into();
        with_engine(&self.inner, move |zm| zm.ingest_turn(&input).map(|o| serde_json::to_value(o).unwrap())).await
    }

    /// Remember many turns. Returns `{ indexed, duplicates, rejected }`.
    #[napi(ts_return_type = "Promise<IngestReport>")]
    pub async fn ingest_many(&self, turns: Vec<Turn>) -> Result<serde_json::Value> {
        let inputs: Vec<TurnInput> = turns.into_iter().map(Into::into).collect();
        with_engine(&self.inner, move |zm| zm.ingest_many(&inputs).map(|r| serde_json::to_value(r).unwrap())).await
    }

    /// Sessions, most recently active first.
    #[napi(ts_return_type = "Promise<SessionSummary[]>")]
    pub async fn list_sessions(&self, page: Option<Page>) -> Result<serde_json::Value> {
        let (limit, offset) = page_bounds(page);
        with_engine(&self.inner, move |zm| zm.list_sessions(limit, offset).map(|s| serde_json::to_value(s).unwrap()))
            .await
    }

    /// One session's turns in time order.
    #[napi(ts_return_type = "Promise<StoredTurn[]>")]
    pub async fn session_turns(&self, session_id: String, page: Option<Page>) -> Result<serde_json::Value> {
        let (limit, offset) = page_bounds(page);
        with_engine(&self.inner, move |zm| {
            zm.session_turns(&session_id, limit, offset).map(|s| serde_json::to_value(s).unwrap())
        })
        .await
    }

    /// One conversation in order: the whole session, or a window around one
    /// turn. For expanding a recall hit that came back clipped or reads like
    /// a fragment.
    #[napi(ts_return_type = "Promise<SessionWindow>")]
    pub async fn session_window(&self, opts: SessionWindowOptions) -> Result<serde_json::Value> {
        let opts: zeromem_core::SessionWindowOptions = opts.into();
        with_engine(&self.inner, move |zm| zm.session_window(&opts).map(|w| serde_json::to_value(w).unwrap())).await
    }

    /// Delete a session's turns; resolves to how many were removed.
    #[napi]
    pub async fn delete_session(&self, session_id: String) -> Result<u32> {
        with_engine(&self.inner, move |zm| zm.delete_session(&session_id)).await
    }

    /// Notice turns written by other processes since the last call.
    #[napi]
    pub async fn refresh(&self) -> Result<u32> {
        with_engine(&self.inner, |zm| zm.refresh()).await
    }

    /// Recall: the evidence that bears on `query`, best first.
    #[napi(ts_return_type = "Promise<QueryResult>")]
    pub async fn query(&self, query: String, opts: Option<RecallOptions>) -> Result<serde_json::Value> {
        let opts: QueryOptions = opts.unwrap_or_default().try_into()?;
        with_engine(&self.inner, move |zm| zm.query(&query, &opts).map(|r| serde_json::to_value(r).unwrap())).await
    }

    /// The same run as `query` with every stage kept.
    #[napi(ts_return_type = "Promise<QueryTrace>")]
    pub async fn query_trace(&self, query: String, opts: Option<RecallOptions>) -> Result<serde_json::Value> {
        let opts: QueryOptions = opts.unwrap_or_default().try_into()?;
        with_engine(&self.inner, move |zm| zm.query_trace(&query, &opts).map(|r| serde_json::to_value(r).unwrap()))
            .await
    }

    /// Recompute every derived index from the turns. Embeddings are kept.
    #[napi]
    pub async fn rebuild(&self) -> Result<()> {
        with_engine(&self.inner, |zm| zm.rebuild()).await
    }

    // --- the embedder ---------------------------------------------------------

    /// The store's embedder (key redacted), what this process can do with it, and the backlog.
    #[napi(ts_return_type = "Promise<EmbedderSettings>")]
    pub async fn embedder_settings(&self) -> Result<serde_json::Value> {
        with_engine(&self.inner, |zm| zm.embedder_settings().map(|s| serde_json::to_value(s).unwrap())).await
    }

    /// Build `spec` and run one text through it; the store is not touched.
    /// `keep_stored_key` fills a remote spec's missing key from the store.
    #[napi(ts_return_type = "Promise<EmbedderProbe>")]
    pub async fn probe_embedder(
        &self,
        #[napi(ts_arg_type = "EmbedderSpec")] spec: serde_json::Value,
        keep_stored_key: Option<bool>,
    ) -> Result<serde_json::Value> {
        let spec = parse_spec(spec)?;
        let keep = keep_stored_key.unwrap_or(false);
        with_engine(&self.inner, move |zm| zm.probe_embedder(spec, keep).map(|r| serde_json::to_value(r).unwrap()))
            .await
    }

    /// Change the store's embedder. The new one is probed first and the store
    /// is untouched on failure; on success every vector of a different model
    /// is dropped and the turns wait in the backlog. `keep_stored_key` leaves
    /// the stored API key in place when the spec carries none.
    #[napi(ts_return_type = "Promise<EmbedderSwitch>")]
    pub async fn set_embedder(
        &self,
        #[napi(ts_arg_type = "EmbedderSpec")] spec: serde_json::Value,
        keep_stored_key: Option<bool>,
    ) -> Result<serde_json::Value> {
        let spec = parse_spec(spec)?;
        let keep = keep_stored_key.unwrap_or(false);
        with_engine(&self.inner, move |zm| zm.set_embedder(spec, keep).map(|r| serde_json::to_value(r).unwrap())).await
    }

    /// Turns with no vector under the store's embedder.
    #[napi]
    pub async fn embedding_backlog(&self) -> Result<i64> {
        with_engine(&self.inner, |zm| zm.embedding_backlog().map(|n| n as i64)).await
    }

    /// Embed up to `limit` turns from the backlog (default 256); resolves to
    /// how many are left. Fails when the embedder is unreachable, so the
    /// caller decides how to back off.
    #[napi]
    pub async fn embed_backlog(&self, limit: Option<u32>) -> Result<i64> {
        let limit = limit.unwrap_or(256).max(1) as usize;
        with_engine(&self.inner, move |zm| zm.embed_backlog(limit).map(|n| n as i64)).await
    }

    /// Drop every vector and re-make them with the store's embedder. It is
    /// probed first and the vectors are kept when it fails; on success every
    /// turn waits in the backlog.
    #[napi(ts_return_type = "Promise<EmbedderSwitch>")]
    pub async fn reembed(&self) -> Result<serde_json::Value> {
        with_engine(&self.inner, |zm| zm.reembed().map(|r| serde_json::to_value(r).unwrap())).await
    }

    /// Drop every vector without probing the embedder; every turn joins the backlog.
    #[napi(ts_return_type = "Promise<ClearReport>")]
    pub async fn clear_embeddings(&self) -> Result<serde_json::Value> {
        with_engine(&self.inner, |zm| zm.clear_embeddings().map(|r| serde_json::to_value(r).unwrap())).await
    }

    /// Delete every turn, session, derived index and vector; the embedder settings stay.
    #[napi(ts_return_type = "Promise<ClearReport>")]
    pub async fn clear_memory(&self) -> Result<serde_json::Value> {
        with_engine(&self.inner, |zm| zm.clear_memory().map(|r| serde_json::to_value(r).unwrap())).await
    }

    // --- curation ----------------------------------------------------------------

    /// The curator settings as stored, token included; the server redacts it.
    #[napi(ts_return_type = "Promise<CuratorConfig>")]
    pub async fn curator_config(&self) -> Result<serde_json::Value> {
        with_engine(&self.inner, |zm| zm.curator_config().map(|c| serde_json::to_value(c).unwrap())).await
    }

    /// Validate and store the curator settings; resolves to what was stored.
    #[napi(ts_return_type = "Promise<CuratorConfig>")]
    pub async fn set_curator_config(&self, config: CuratorConfigInput) -> Result<serde_json::Value> {
        let config = CuratorConfig::from(config);
        with_engine(&self.inner, move |zm| zm.set_curator_config(&config).map(|c| serde_json::to_value(c).unwrap()))
            .await
    }

    /// Apply a batch of reversible curation actions in one transaction.
    /// Each is checked on its own and a rejected one does not stop the rest;
    /// `dry_run` reports what would happen and changes nothing.
    #[napi(ts_return_type = "Promise<ApplyReport>")]
    pub async fn curate_apply(
        &self,
        run_id: String,
        actor: String,
        #[napi(ts_arg_type = "CurationAction[]")] actions: serde_json::Value,
        dry_run: Option<bool>,
    ) -> Result<serde_json::Value> {
        let actions: Vec<CurationAction> =
            serde_json::from_value(actions).map_err(|e| Error::from_reason(format!("bad curation actions: {e}")))?;
        let dry_run = dry_run.unwrap_or(false);
        with_engine(&self.inner, move |zm| {
            zm.curate_apply(&run_id, &actor, &actions, dry_run).map(|r| serde_json::to_value(r).unwrap())
        })
        .await
    }

    /// Undo one action or every live action of a run, newest first.
    #[napi(ts_return_type = "Promise<UndoReport>")]
    pub async fn curate_undo(&self, target: UndoInput, actor: String) -> Result<serde_json::Value> {
        let target = match (target.action_id, target.run_id) {
            (Some(id), None) => UndoTarget::Action(id),
            (None, Some(run)) => UndoTarget::Run(run),
            _ => return Err(Error::from_reason("undo needs exactly one of action_id or run_id")),
        };
        with_engine(&self.inner, move |zm| zm.curate_undo(&target, &actor).map(|r| serde_json::to_value(r).unwrap()))
            .await
    }

    /// One page of candidates of `kind` for the curator to judge.
    #[napi(ts_return_type = "Promise<CandidatePage>")]
    pub async fn curate_candidates(
        &self,
        #[napi(ts_arg_type = "CandidateKind")] kind: String,
        opts: Option<CandidateOptions>,
    ) -> Result<serde_json::Value> {
        let kind = CandidateKind::parse(&kind).ok_or_else(|| {
            Error::from_reason(format!(
                "unknown candidate kind `{kind}`: use duplicates, noise, aliases, supersession or consolidation"
            ))
        })?;
        let opts = opts.unwrap_or_default();
        let opts = FinderOptions { since_turn_id: opts.since_turn_id, limit: opts.limit, offset: opts.offset };
        with_engine(&self.inner, move |zm| zm.curate_candidates(kind, &opts).map(|r| serde_json::to_value(r).unwrap()))
            .await
    }

    /// Turns with their entity spans and everything curation says about them.
    #[napi(ts_return_type = "Promise<CuratedTurn[]>")]
    pub async fn curation_turns(&self, selector: CurationSelector, limit: Option<u32>) -> Result<serde_json::Value> {
        let selector =
            TurnSelector { turn_ids: selector.turn_ids, session_id: selector.session_id, entity: selector.entity };
        let limit = limit.unwrap_or(50).clamp(1, 500);
        with_engine(&self.inner, move |zm| {
            zm.curation_turns(&selector, limit).map(|r| serde_json::to_value(r).unwrap())
        })
        .await
    }

    /// Curation runs, newest first, with the cursor the next run starts from.
    #[napi(ts_return_type = "Promise<CurationRuns>")]
    pub async fn curation_runs(&self, page: Option<Page>) -> Result<serde_json::Value> {
        let (limit, offset) = page_bounds(page);
        with_engine(&self.inner, move |zm| zm.curation_runs(limit, offset).map(|r| serde_json::to_value(r).unwrap()))
            .await
    }

    /// The action log, newest first; one run's actions when `run_id` is given.
    #[napi(ts_return_type = "Promise<CurationActions>")]
    pub async fn curation_actions(&self, run_id: Option<String>, page: Option<Page>) -> Result<serde_json::Value> {
        let (limit, offset) = page_bounds(page);
        with_engine(&self.inner, move |zm| {
            zm.curation_actions(run_id.as_deref(), limit, offset).map(|r| serde_json::to_value(r).unwrap())
        })
        .await
    }

    /// Live entity aliases and the blocklist.
    #[napi(ts_return_type = "Promise<CurationAliases>")]
    pub async fn curation_aliases(&self) -> Result<serde_json::Value> {
        with_engine(&self.inner, |zm| zm.curation_aliases().map(|r| serde_json::to_value(r).unwrap())).await
    }

    // --- reads for the visualisations ---------------------------------------

    /// The entity graph: top entities by mentions, or a neighbourhood around `focus`.
    #[napi(ts_return_type = "Promise<GraphSnapshot>")]
    pub async fn graph_snapshot(&self, opts: Option<GraphOptions>) -> Result<serde_json::Value> {
        let opts: viz::GraphOptions = opts.unwrap_or_default().into();
        with_engine(&self.inner, move |zm| zm.graph_snapshot(&opts).map(|r| serde_json::to_value(r).unwrap())).await
    }

    /// Sessions with their windows and episodes, paged and range-filtered.
    #[napi(ts_return_type = "Promise<HierarchySnapshot>")]
    pub async fn hierarchy(&self, opts: Option<HierarchyOptions>) -> Result<serde_json::Value> {
        let opts: viz::HierarchyOptions = opts.unwrap_or_default().into();
        with_engine(&self.inner, move |zm| zm.hierarchy(&opts).map(|r| serde_json::to_value(r).unwrap())).await
    }

    /// One session's turns in order, each with its entity spans.
    #[napi(ts_return_type = "Promise<TurnWithEntities[]>")]
    pub async fn session_turns_with_entities(
        &self,
        session_id: String,
        page: Option<Page>,
    ) -> Result<serde_json::Value> {
        let (limit, offset) = page_bounds(page);
        with_engine(&self.inner, move |zm| {
            zm.session_turns_with_entities(&session_id, limit, offset).map(|s| serde_json::to_value(s).unwrap())
        })
        .await
    }

    /// A 2-D PCA of a deterministic sample of turn vectors, cached until the store changes.
    #[napi(ts_return_type = "Promise<Projection>")]
    pub async fn projection(&self, opts: Option<ProjectionOptions>) -> Result<serde_json::Value> {
        let opts = opts.unwrap_or_default();
        let query = opts.query.filter(|q| !q.trim().is_empty());
        let popts = viz::ProjectionOptions { limit: opts.limit, session: opts.session };
        with_engine(&self.inner, move |zm| {
            zm.projection(&popts, query.as_deref()).map(|r| serde_json::to_value(r).unwrap())
        })
        .await
    }

    /// Turns and active sessions per UTC day.
    #[napi(ts_return_type = "Promise<Growth>")]
    pub async fn growth(&self, range: Option<TimeRange>) -> Result<serde_json::Value> {
        let range = range.unwrap_or_default();
        with_engine(&self.inner, move |zm| {
            zm.growth(range.since, range.until).map(|r| serde_json::to_value(r).unwrap())
        })
        .await
    }
}

fn page_bounds(page: Option<Page>) -> (u32, u32) {
    let page = page.unwrap_or(Page { limit: None, offset: None });
    (page.limit.unwrap_or(100).clamp(1, 1000), page.offset.unwrap_or(0))
}
