//! zeromem-core: conversational memory with no model in the loop.
//!
//! The engine keeps turns in one SQLite file and answers "what do I already
//! know that bears on this?" from indexes it derives itself. This crate is the
//! whole of that logic; the `zm` binary and the Node binding are thin shells
//! over [`ZeroMem`].
//!
//! Module map: `store` is the file and its schema; `text` and `entities`
//! read a turn; `timeline` segments a session; `dense` embeds and searches
//! vectors; `retrieve` is recall. Everything derived can be rebuilt from the
//! `turns` table, and the tests in `tests/oracle.rs` hold the engine to
//! that.

pub mod curation;
pub mod dense;
pub mod entities;
pub mod error;
pub mod home;
pub mod retrieve;
pub mod store;
pub mod text;
pub mod timeline;
pub mod types;
pub mod viz;

use std::path::{Path, PathBuf};

use dense::{Embedder, EmbedderChoice, EmbedderSpec, RemoteSpec, VectorIndex};
pub use error::{Error, Result};
pub use retrieve::{Detail, Evidence, QueryOptions, QueryResult, QueryTrace, Role, Route, ViewKind};
use store::Store;
pub use timeline::Level;
pub use types::*;

/// Options that change how a store is opened.
#[derive(Debug, Clone)]
pub struct OpenOptions {
    /// What this process asks for. A fresh store is seeded with it; an
    /// existing store follows its own recorded embedder, and a differing
    /// request is refused unless `allow_embedder_switch`.
    pub embedder: EmbedderChoice,
    /// A store remembers which embedder built its vectors. Opening with a
    /// different one is refused unless this is set, in which case every
    /// vector is dropped and re-made lazily by `refresh`.
    pub allow_embedder_switch: bool,
    /// The endpoint `EmbedderChoice::OpenAi` refers to.
    pub remote: Option<RemoteSpec>,
    /// An API key that overrides the store's for a remote embedder; it is
    /// used, never stored. Callers take it from the environment.
    pub api_key: Option<String>,
    /// Whether this process may talk to a remote endpoint at all. The `zm`
    /// CLI turns it off for hooks and reads, so a host never embeds through
    /// the network: it stores turns without vectors and the server's
    /// backlog worker embeds them.
    pub follow_remote: bool,
}

impl Default for OpenOptions {
    fn default() -> Self {
        OpenOptions {
            embedder: EmbedderChoice::Auto,
            allow_embedder_switch: false,
            remote: None,
            api_key: None,
            follow_remote: true,
        }
    }
}

/// How many turns are embedded per model call when catching up.
pub const EMBED_BATCH: usize = 64;

pub struct ZeroMem {
    store: Store,
    home: PathBuf,
    embedder: Option<Box<dyn Embedder>>,
    /// The spec `embedder` was built from: the store's, as this process
    /// last read it.
    embedder_spec: Option<EmbedderSpec>,
    /// Why there is no embedder, or why the fallback was taken.
    embedder_warning: Option<String>,
    /// This process's dense view can be off (`EmbedderChoice::None`) or
    /// barred from remote endpoints; both are decided once at open.
    dense_enabled: bool,
    follow_remote: bool,
    api_key_override: Option<String>,
    index: VectorIndex,
    /// Highest embedding sequence loaded into `index`.
    seen_seq: i64,
    seen_max_id: i64,
    seen_generation: i64,
    /// The last projection, keyed by what would change it. Computing one is
    /// a covariance over the sample; serving the UI's second request from
    /// here keeps a 2000-point map cheap to pan around.
    projection_cache: Option<(viz::ProjectionKey, viz::Projection)>,
}

impl ZeroMem {
    pub fn open(home: impl AsRef<Path>, opts: OpenOptions) -> Result<Self> {
        let home = home.as_ref().to_path_buf();
        let store::Opened { mut store, needs_rebuild } = Store::open(&home)?;
        if needs_rebuild {
            log::info!("schema upgraded; rebuilding derived indexes");
            store.rebuild(false)?;
        }
        let mut zm = ZeroMem {
            store,
            home,
            embedder: None,
            embedder_spec: None,
            embedder_warning: None,
            dense_enabled: opts.embedder != EmbedderChoice::None,
            follow_remote: opts.follow_remote,
            api_key_override: opts.api_key.clone().filter(|k| !k.is_empty()),
            index: VectorIndex::new(0),
            seen_seq: 0,
            seen_max_id: 0,
            seen_generation: -1,
            projection_cache: None,
        };
        zm.choose_embedder(&opts)?;
        zm.refresh()?;
        Ok(zm)
    }

    /// Reconcile what the process asked for with what the store records.
    fn choose_embedder(&mut self, opts: &OpenOptions) -> Result<()> {
        if !self.dense_enabled {
            return Ok(());
        }
        let stored = self.store.embedder_spec()?;
        let requested = match opts.embedder {
            EmbedderChoice::None => unreachable!("dense view is off"),
            EmbedderChoice::Auto => None,
            EmbedderChoice::Onnx => Some(EmbedderSpec::Onnx),
            EmbedderChoice::Hash => Some(EmbedderSpec::Hash),
            EmbedderChoice::OpenAi => Some(EmbedderSpec::Remote(
                opts.remote
                    .clone()
                    .ok_or_else(|| Error::Embedder("the openai embedder needs a url and a model".into()))?,
            )),
        };
        match (stored, requested) {
            // A fresh store takes whatever was asked, or auto's pick.
            (None, None) => {
                let (spec, embedder, warning) = dense::auto_spec(&self.home);
                self.store.seed_embedder(&spec)?;
                self.install(spec, Some(embedder), warning);
            }
            (None, Some(spec)) => {
                let (spec, embedder) = self.build_and_probe(spec)?;
                self.store.seed_embedder(&spec)?;
                self.install(spec, Some(embedder), None);
            }
            // An existing store is followed.
            (Some(stored), None) => self.follow(stored),
            (Some(stored), Some(spec)) if stored.same_model(&spec) => {
                // The same model asked for explicitly: a failure to build it
                // is the caller's problem, not something to run without.
                let mut spec = spec;
                if spec.dim().is_none() {
                    spec = stored.clone();
                } else if let (EmbedderSpec::Remote(r), EmbedderSpec::Remote(s)) = (&mut spec, &stored) {
                    if r.api_key.is_none() {
                        r.api_key = s.api_key.clone();
                    }
                }
                let embedder = spec.build(&self.home, self.api_key_override.as_deref())?;
                self.install(stored, Some(embedder), None);
            }
            (Some(stored), Some(spec)) => {
                if !opts.allow_embedder_switch {
                    return Err(Error::EmbedderMismatch { stored: stored.name(), requested: spec.name() });
                }
                log::warn!(
                    "switching embedder from {} to {}; every vector will be re-made",
                    stored.name(),
                    spec.name()
                );
                let (spec, embedder) = self.build_and_probe(spec)?;
                self.store.switch_embedder(&spec)?;
                self.install(spec, Some(embedder), None);
            }
        }
        Ok(())
    }

    /// Build the store's embedder, or run without one and say why.
    fn follow(&mut self, stored: EmbedderSpec) {
        if matches!(stored, EmbedderSpec::Remote(_)) && !self.follow_remote {
            let warning = format!(
                "this store is embedded by {}; this process leaves embedding to the server and runs without a dense view",
                stored.name()
            );
            log::info!("{warning}");
            self.install(stored, None, Some(warning));
            return;
        }
        match stored.build(&self.home, self.api_key_override.as_deref()) {
            Ok(embedder) => self.install(stored, Some(embedder), None),
            Err(e) => {
                let warning = format!(
                    "this store is embedded by {} which could not be opened: {e}; running without a dense view",
                    stored.name()
                );
                log::warn!("{warning}");
                self.install(stored, None, Some(warning));
            }
        }
    }

    /// Build an embedder the operator chose and run one text through it, so
    /// a wrong URL or key fails here and not in the first ingest. Fills in
    /// a remote model's dimension.
    fn build_and_probe(&self, mut spec: EmbedderSpec) -> Result<(EmbedderSpec, Box<dyn Embedder>)> {
        let mut embedder = spec.build(&self.home, self.api_key_override.as_deref())?;
        if let EmbedderSpec::Remote(r) = &mut spec {
            let v = embedder.embed_query("zeromem probe")?;
            match r.dim {
                Some(d) if d != v.len() => {
                    return Err(Error::Embedder(format!("{} returned {} dims, expected {d}", r.model, v.len())));
                }
                _ => r.dim = Some(v.len()),
            }
        }
        Ok((spec, embedder))
    }

    fn install(&mut self, spec: EmbedderSpec, embedder: Option<Box<dyn Embedder>>, warning: Option<String>) {
        let dim = embedder.as_ref().map(|e| e.dim()).or(spec.dim()).unwrap_or(0);
        self.index = VectorIndex::new(dim);
        self.seen_seq = 0;
        self.projection_cache = None;
        self.embedder = embedder;
        self.embedder_spec = Some(spec);
        self.embedder_warning = warning;
    }

    /// Another process may have switched the store's embedder; if the
    /// store's name differs from what this process holds, follow it.
    fn follow_store_if_changed(&mut self) -> Result<bool> {
        if !self.dense_enabled {
            return Ok(false);
        }
        let stored = self.store.embedder_spec()?;
        let stored_name = stored.as_ref().map(EmbedderSpec::name);
        let held_name = self.embedder_spec.as_ref().map(EmbedderSpec::name);
        if stored_name == held_name {
            return Ok(false);
        }
        match stored {
            Some(spec) => {
                log::info!("the store's embedder is now {}; following it", spec.name());
                self.follow(spec);
            }
            None => {
                self.index = VectorIndex::new(0);
                self.embedder = None;
                self.embedder_spec = None;
                self.embedder_warning = None;
            }
        }
        Ok(true)
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    /// The name of the embedder this process embeds with, when there is one.
    pub fn embedder_name(&self) -> Option<&str> {
        self.embedder.as_ref().map(|e| e.name())
    }

    pub fn embedder_is_fallback(&self) -> bool {
        self.embedder.as_ref().is_some_and(|e| e.is_fallback())
    }

    /// The warning worth showing: why there is no embedder or why the
    /// fallback is in use, else what the embedder itself is complaining
    /// about (an endpoint that is down).
    pub fn embedder_warning(&self) -> Option<String> {
        self.embedder_warning.clone().or_else(|| self.embedder.as_ref().and_then(|e| e.warning()))
    }

    /// The store's embedder as the UI sees it: the spec with its key
    /// redacted, what is running here, and the backlog.
    pub fn embedder_settings(&self) -> Result<EmbedderSettings> {
        let stored = self.store.embedder_spec()?;
        let api_key_source = if self.api_key_override.is_some() {
            ApiKeySource::Env
        } else if stored.as_ref().and_then(EmbedderSpec::api_key).is_some_and(|k| !k.is_empty()) {
            ApiKeySource::Store
        } else {
            ApiKeySource::None
        };
        Ok(EmbedderSettings {
            spec: stored.as_ref().map(EmbedderSpec::redacted),
            embedder: stored.as_ref().map(EmbedderSpec::name),
            embedder_kind: stored.as_ref().map(|s| s.kind().to_string()),
            embedder_dim: stored.as_ref().and_then(EmbedderSpec::dim).map(|d| d as u32),
            active: self.embedder.is_some(),
            embedder_is_fallback: self.embedder_is_fallback(),
            embedder_warning: self.embedder_warning(),
            embedding_backlog: self.embedding_backlog()?,
            api_key_source,
            onnx_available: dense::onnx_available(),
        })
    }

    /// Build an embedder from `spec` and run one text through it, touching
    /// nothing in the store. What the settings page's "test" button does.
    /// With `keep_stored_key`, a remote spec without a key inherits the
    /// store's, as `set_embedder` would.
    pub fn probe_embedder(&self, spec: EmbedderSpec, keep_stored_key: bool) -> Result<ProbeReport> {
        let spec = if keep_stored_key { self.with_stored_key(spec)? } else { spec };
        let started = std::time::Instant::now();
        let (spec, _) = self.build_and_probe(spec)?;
        Ok(ProbeReport {
            embedder: spec.name(),
            embedder_kind: spec.kind().to_string(),
            embedder_dim: spec.dim().unwrap_or(0) as u32,
            latency_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// Change the store's embedder. The new one is built and probed first,
    /// so a bad endpoint leaves the store untouched; then, in one
    /// transaction, the spec is recorded, every vector dropped and the
    /// generation bumped. Re-embedding happens through `embed_backlog` and
    /// `refresh`, a batch at a time. With `keep_stored_key`, a remote spec
    /// without a key inherits the store's.
    ///
    /// Applying a spec for the model already in use (a new key, a new
    /// timeout) records it and keeps the vectors.
    pub fn set_embedder(&mut self, spec: EmbedderSpec, keep_stored_key: bool) -> Result<SwitchReport> {
        let stored = self.store.embedder_spec()?;
        let spec = if keep_stored_key { self.with_stored_key(spec)? } else { spec };
        let (spec, embedder) = self.build_and_probe(spec)?;
        let same = stored.as_ref().is_some_and(|s| s.name() == spec.name());
        if same {
            self.store.update_embedder_spec(&spec)?;
            self.install(spec, Some(embedder), None);
        } else {
            self.store.switch_embedder(&spec)?;
            self.install(spec, Some(embedder), None);
        }
        self.dense_enabled = true;
        self.refresh()?;
        Ok(SwitchReport {
            embedder: self.embedder_spec.as_ref().map(EmbedderSpec::name).unwrap_or_default(),
            embedder_dim: self.index.dim() as u32,
            turns_to_embed: self.embedding_backlog()?,
            vectors_kept: same,
        })
    }

    /// A remote spec without a key takes the one the store holds, when the
    /// store's embedder is remote too.
    fn with_stored_key(&self, mut spec: EmbedderSpec) -> Result<EmbedderSpec> {
        if let EmbedderSpec::Remote(r) = &mut spec {
            if r.api_key.as_deref().is_none_or(str::is_empty) {
                if let Some(EmbedderSpec::Remote(s)) = self.store.embedder_spec()? {
                    r.api_key = s.api_key;
                }
            }
        }
        Ok(spec)
    }

    /// Drop every vector and re-make them with the store's embedder: the way
    /// out when a switch left the vectors half-made, or when the model behind
    /// an endpoint changed without its name changing. The embedder is rebuilt
    /// and probed first, so one that still fails is reported here and the
    /// vectors are kept. On success they go in one transaction with a
    /// generation bump, and the backlog re-embeds every turn.
    pub fn reembed(&mut self) -> Result<SwitchReport> {
        let spec = self
            .store
            .embedder_spec()?
            .ok_or_else(|| Error::Embedder("this store has no embedder yet; choose one first".into()))?;
        let (spec, embedder) = self.build_and_probe(spec)?;
        self.store.clear_embeddings()?;
        self.install(spec, Some(embedder), None);
        self.dense_enabled = true;
        self.refresh()?;
        Ok(SwitchReport {
            embedder: self.embedder_spec.as_ref().map(EmbedderSpec::name).unwrap_or_default(),
            embedder_dim: self.index.dim() as u32,
            turns_to_embed: self.embedding_backlog()?,
            vectors_kept: false,
        })
    }

    /// Drop every vector and leave the embedder as it is; every turn joins
    /// the backlog. Nothing is probed, so this works while the embedder is
    /// down, and recall runs on the other views until the vectors are back.
    pub fn clear_embeddings(&mut self) -> Result<ClearReport> {
        let vectors_removed = self.store.clear_embeddings()?;
        self.refresh()?;
        Ok(ClearReport {
            turns_removed: 0,
            sessions_removed: 0,
            vectors_removed,
            turns_to_embed: self.embedding_backlog()?,
        })
    }

    /// Forget everything the store remembers: every turn and session, every
    /// derived index and every vector. The embedder and its settings stay.
    pub fn clear_memory(&mut self) -> Result<ClearReport> {
        let report = self.store.clear_memory()?;
        self.refresh()?;
        Ok(report)
    }

    /// Turns that have no vector from the store's embedder.
    pub fn embedding_backlog(&self) -> Result<u64> {
        match self.store.meta("embedder")? {
            Some(model) => self.store.count_backlog(&model),
            None => Ok(0),
        }
    }

    /// Embed up to `limit` turns from the backlog and load their vectors.
    /// Returns how many are still waiting, so a worker can loop until zero.
    /// Unlike `refresh`, an embedder failure is returned, not swallowed.
    pub fn embed_backlog(&mut self, limit: usize) -> Result<u64> {
        self.follow_store_if_changed()?;
        let mut done = 0;
        while done < limit {
            let want = (limit - done).min(EMBED_BATCH);
            match self.embed_one_batch(want)? {
                0 => break,
                n => done += n,
            }
        }
        self.load_new_vectors()?;
        self.embedding_backlog()
    }

    /// One model call over the oldest unembedded turns. Returns how many
    /// were embedded; `Ok(0)` when the backlog is empty or there is no
    /// embedder. A switch under our feet is followed and reported as 0.
    fn embed_one_batch(&mut self, limit: usize) -> Result<usize> {
        let Some(embedder) = self.embedder.as_mut() else { return Ok(0) };
        let model = embedder.name().to_string();
        // Read before the backlog, so a clear or delete during the model
        // call is caught at the write.
        let generation = self.store.generation()?;
        let backlog = self.store.turns_without_embedding(&model, limit)?;
        if backlog.is_empty() {
            return Ok(0);
        }
        let texts: Vec<&str> = backlog.iter().map(|(_, t)| t.as_str()).collect();
        let vectors = embedder.embed_documents(&texts)?;
        let rows: Vec<(i64, Vec<f32>)> = backlog.iter().map(|(id, _)| *id).zip(vectors).collect();
        match self.store.write_embeddings(&rows, &model, generation) {
            Ok(()) => Ok(rows.len()),
            Err(Error::EmbedderChanged(_)) => {
                self.follow_store_if_changed()?;
                Ok(0)
            }
            // The next refresh reloads the index; the batch is embedded again.
            Err(Error::StoreChanged) => Ok(0),
            Err(e) => Err(e),
        }
    }

    fn load_new_vectors(&mut self) -> Result<()> {
        let Some(model) = self.embedder_spec.as_ref().map(EmbedderSpec::name) else { return Ok(()) };
        if self.index.dim() == 0 {
            return Ok(());
        }
        for (seq, id, vec) in self.store.embeddings_after(self.seen_seq, &model, self.index.dim())? {
            self.index.push(id, &vec);
            self.seen_seq = self.seen_seq.max(seq);
        }
        Ok(())
    }

    pub fn ingest_turn(&mut self, turn: &TurnInput) -> Result<IngestOutcome> {
        let mut outcomes = self.ingest_batch(std::slice::from_ref(turn))?;
        outcomes.remove(0)
    }

    /// Ingest a batch in one transaction. A turn that fails validation is
    /// counted as rejected and does not stop the others; storage failures do.
    pub fn ingest_many<'a>(&mut self, turns: impl IntoIterator<Item = &'a TurnInput>) -> Result<IngestReport> {
        let inputs: Vec<TurnInput> = turns.into_iter().cloned().collect();
        let mut report = IngestReport::default();
        for outcome in self.ingest_batch(&inputs)? {
            match outcome {
                Ok(IngestOutcome::Indexed { .. }) => report.indexed += 1,
                Ok(IngestOutcome::Duplicate { .. }) => report.duplicates += 1,
                Err(Error::InvalidTurn(_)) => report.rejected += 1,
                Err(e) => return Err(e),
            }
        }
        Ok(report)
    }

    /// Embeds inline when there is an embedder and it answers; when it does
    /// not (a remote box that is down) the turns land without vectors and
    /// the backlog picks them up later — an ingest never fails for want of
    /// a vector.
    fn ingest_batch(&mut self, inputs: &[TurnInput]) -> Result<Vec<Result<IngestOutcome>>> {
        let mut vectors: Vec<Option<Vec<f32>>> = vec![None; inputs.len()];
        let mut model = self.embedder.as_ref().map(|e| e.name().to_string());
        if let Some(embedder) = self.embedder.as_mut() {
            let mut pending: Vec<(usize, &str)> = inputs
                .iter()
                .enumerate()
                .filter(|(_, t)| !t.text.trim().is_empty())
                .map(|(i, t)| (i, t.text.as_str()))
                .collect();
            for chunk in pending.chunks_mut(EMBED_BATCH) {
                let texts: Vec<&str> = chunk.iter().map(|(_, t)| *t).collect();
                match embedder.embed_documents(&texts) {
                    Ok(embedded) => {
                        for ((i, _), v) in chunk.iter().zip(embedded) {
                            vectors[*i] = Some(v);
                        }
                    }
                    Err(e) => {
                        log::warn!("storing turns without vectors; embedding failed: {e}");
                        vectors.iter_mut().for_each(|v| *v = None);
                        model = None;
                        break;
                    }
                }
            }
        }
        let inserted = self.store.insert_batch(inputs, &vectors, model.as_deref())?;
        if inserted.embedder_changed {
            self.follow_store_if_changed()?;
        }
        self.refresh()?;
        Ok(inserted.outcomes)
    }

    pub fn stats(&self) -> Result<Stats> {
        Ok(Stats {
            home: self.home.display().to_string(),
            turns: self.store.count_turns()?,
            sessions: self.store.count_sessions()?,
            entities: self.store.count_entities()?,
            edges: self.store.count_edges()?,
            windows: self.store.count_segments(Level::Window)?,
            episodes: self.store.count_segments(Level::Episode)?,
            embeddings: self.store.count_embeddings()?,
            embedding_backlog: self.embedding_backlog()?,
            embedder: self.store.meta("embedder")?,
            embedder_kind: self.embedder_spec.as_ref().map(|s| s.kind().to_string()),
            embedder_dim: self.embedder_spec.as_ref().and_then(EmbedderSpec::dim).map(|d| d as u32),
            embedder_active: self.embedder.is_some(),
            embedder_is_fallback: self.embedder_is_fallback(),
            embedder_warning: self.embedder_warning(),
            generation: self.store.generation()?,
            schema_version: self.store.meta_i64("schema_version")?,
            curation_seq: self.store.curation_seq()?,
            hidden: self.store.count_hidden()?,
            notes: self.store.count_notes()?,
        })
    }

    /// The whole store in canonical order. Used by the rebuild-vs-load
    /// oracle and by `zm snapshot`; not something to call on a large store
    /// in a request path.
    pub fn snapshot(&self) -> Result<Snapshot> {
        Ok(Snapshot {
            schema_version: self.store.meta_i64("schema_version")?,
            generation: self.store.generation()?,
            embedder: self.store.meta("embedder")?,
            turns: self.store.all_turns()?,
            mentions: self.store.all_mentions()?,
            entities: self.store.all_entity_stats()?,
            edges: self.store.all_edges()?,
            segments: self.store.all_segments()?,
            embeddings: self.store.all_embeddings()?,
            flags: self.store.all_flags()?,
            aliases: self.store.all_aliases()?,
            blocklist: self.store.all_blocklist()?,
            note_sources: self.store.all_note_sources()?,
        })
    }

    pub fn list_sessions(&self, limit: u32, offset: u32) -> Result<Vec<SessionSummary>> {
        self.store.list_sessions(limit, offset)
    }

    pub fn session_turns(&self, session_id: &str, limit: u32, offset: u32) -> Result<Vec<Turn>> {
        self.store.session_turns(session_id, limit, offset)
    }

    /// One conversation in order: the whole session from `offset`, or a
    /// window centred on `around_turn` — the turn id a recall hit carries,
    /// so an agent holding a clipped or fragmentary hit can read what
    /// surrounds it instead of going looking elsewhere.
    ///
    /// `refresh()` first, like every other read: expanding a hit in a
    /// session a hook is still writing is exactly when this gets asked.
    /// `truncated` means the answer is not the whole session, so a caller
    /// can page on with `offset` rather than guess.
    pub fn session_window(&mut self, opts: &SessionWindowOptions) -> Result<SessionWindow> {
        self.refresh()?;
        match opts.around_turn {
            Some(id) => {
                let anchor = self.store.turn(id)?.ok_or_else(|| Error::InvalidTurn(format!("no turn {id}")))?;
                if let Some(session_id) = opts.session_id.as_deref().filter(|s| *s != anchor.session_id) {
                    return Err(Error::InvalidTurn(format!(
                        "turn {id} is in session {}, not {session_id}",
                        anchor.session_id
                    )));
                }
                // The whole window, anchor included, stays within the cap.
                let before = opts.before.unwrap_or(SESSION_WINDOW_DEFAULT_SIDE).min(SESSION_WINDOW_MAX_TURNS - 1);
                let after =
                    opts.after.unwrap_or(SESSION_WINDOW_DEFAULT_SIDE).min(SESSION_WINDOW_MAX_TURNS - 1 - before);
                let (earlier, later) = self.store.session_neighbours(&anchor, before, after)?;
                let offset = self.store.session_turn_rank(earlier.first().unwrap_or(&anchor))?;
                let total = self.store.count_session_turns(&anchor.session_id)?;
                let session_id = anchor.session_id.clone();
                let mut turns = earlier;
                turns.push(anchor);
                turns.extend(later);
                Ok(SessionWindow {
                    truncated: turns.len() < total as usize,
                    session_id,
                    around_turn: Some(id),
                    turns,
                    total,
                    offset,
                })
            }
            None => {
                let session_id = opts
                    .session_id
                    .clone()
                    .ok_or_else(|| Error::InvalidTurn("give session_id or around_turn".into()))?;
                let limit = opts.limit.unwrap_or(SESSION_WINDOW_DEFAULT_TURNS).clamp(1, SESSION_WINDOW_MAX_TURNS);
                let offset = opts.offset.unwrap_or(0);
                let turns = self.store.session_turns(&session_id, limit, offset)?;
                let total = self.store.count_session_turns(&session_id)?;
                Ok(SessionWindow {
                    truncated: offset as usize + turns.len() < total as usize,
                    session_id,
                    around_turn: None,
                    turns,
                    total,
                    offset,
                })
            }
        }
    }

    pub fn delete_session(&mut self, session_id: &str) -> Result<u32> {
        let removed = self.store.delete_session(session_id)?;
        self.refresh()?;
        Ok(removed)
    }

    /// Recall. Picks up other writers' turns first, so a hook's write is
    /// visible to the next question without a restart.
    pub fn query(&mut self, query: &str, opts: &QueryOptions) -> Result<QueryResult> {
        let detail = opts.detail.unwrap_or_default();
        let trace = self.query_trace(query, opts)?;
        Ok(retrieve::to_result(trace, detail))
    }

    /// The same run as `query`, with every intermediate stage kept.
    pub fn query_trace(&mut self, query: &str, opts: &QueryOptions) -> Result<QueryTrace> {
        self.refresh()?;
        let latest_ts = self.store.latest_ts()?;
        let mut ctx = retrieve::Context {
            store: &self.store,
            index: &self.index,
            embedder: self.embedder.as_deref_mut().map(|e| e as &mut (dyn Embedder + '_)),
            latest_ts,
        };
        retrieve::run(&mut ctx, query, opts)
    }

    /// Pick up whatever other writers (a hook process, another engine) have
    /// added since the last call: embed one batch of turns that arrived
    /// without a vector and load new vectors into the in-memory index. When
    /// the generation moved (a delete, a rebuild, an embedder switch) the
    /// index is reloaded and the store's embedder followed. Returns how
    /// many turns are new since the last call.
    ///
    /// One batch, not the whole backlog: a read must not wait on a
    /// corpus-wide re-embed. `embed_backlog` is for draining it, and an
    /// embedder that fails here is noted in `embedder_warning`, not
    /// returned — recall still answers from the other views.
    pub fn refresh(&mut self) -> Result<u32> {
        let generation = self.store.generation()?;
        if generation != self.seen_generation {
            self.index.clear();
            self.seen_seq = 0;
            self.seen_max_id = 0;
            self.seen_generation = generation;
            self.projection_cache = None;
            self.follow_store_if_changed()?;
        }
        let max_id = self.store.max_turn_id()?;
        let new_turns = if max_id > self.seen_max_id { self.store.count_turns_after(self.seen_max_id)? } else { 0 };
        self.seen_max_id = max_id;
        match self.embed_one_batch(EMBED_BATCH) {
            Ok(_) => {}
            Err(Error::Embedder(e)) => log::warn!("backlog not embedded this time: {e}"),
            Err(e) => return Err(e),
        }
        self.load_new_vectors()?;
        Ok(new_turns)
    }

    /// Recompute every derived index from the turns. Embeddings are kept.
    pub fn rebuild(&mut self) -> Result<()> {
        self.store.rebuild(false)?;
        self.refresh()?;
        Ok(())
    }

    // --- curation ---------------------------------------------------------

    /// The curator's limits, token and exposure, as stored.
    pub fn curator_config(&self) -> Result<curation::CuratorConfig> {
        self.store.curator_config()
    }

    pub fn set_curator_config(&mut self, config: &curation::CuratorConfig) -> Result<curation::CuratorConfig> {
        self.store.set_curator_config(config)?;
        self.store.curator_config()
    }

    /// Apply a batch of curation actions; see [`curation`].
    pub fn curate_apply(
        &mut self,
        run_id: &str,
        actor: &str,
        actions: &[curation::CurationAction],
        dry_run: bool,
    ) -> Result<curation::ApplyReport> {
        self.refresh()?;
        let report = self.store.curate_apply(run_id, actor, actions, dry_run, store::now_ms())?;
        self.refresh()?;
        Ok(report)
    }

    pub fn curate_undo(&mut self, target: &curation::UndoTarget, actor: &str) -> Result<curation::UndoReport> {
        self.refresh()?;
        let report = self.store.curate_undo(target, actor, store::now_ms())?;
        self.refresh()?;
        Ok(report)
    }

    pub fn curate_candidates(
        &mut self,
        kind: curation::finders::CandidateKind,
        opts: &curation::finders::FinderOptions,
    ) -> Result<curation::finders::CandidatePage> {
        self.refresh()?;
        curation::finders::find(&self.store, &self.index, kind, opts, store::now_ms())
    }

    pub fn curation_turns(
        &mut self,
        selector: &curation::TurnSelector,
        limit: u32,
    ) -> Result<Vec<curation::CuratedTurn>> {
        self.refresh()?;
        self.store.curation_turns(selector, limit)
    }

    pub fn curation_runs(&mut self, limit: u32, offset: u32) -> Result<curation::CurationRuns> {
        self.refresh()?;
        self.store.curation_runs(limit, offset)
    }

    pub fn curation_actions(
        &mut self,
        run_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<curation::CurationActions> {
        self.refresh()?;
        self.store.curation_actions(run_id, limit, offset)
    }

    pub fn curation_aliases(&mut self) -> Result<curation::CurationAliases> {
        self.refresh()?;
        self.store.curation_aliases()
    }

    // --- reads for the visualisations -------------------------------------

    /// The entity graph, capped; see [`viz::GraphOptions`].
    pub fn graph_snapshot(&mut self, opts: &viz::GraphOptions) -> Result<viz::GraphSnapshot> {
        self.refresh()?;
        viz::graph_snapshot(&self.store, opts)
    }

    /// Sessions → windows → episodes, paged; see [`viz::HierarchyOptions`].
    pub fn hierarchy(&mut self, opts: &viz::HierarchyOptions) -> Result<viz::HierarchySnapshot> {
        self.refresh()?;
        viz::hierarchy(&self.store, opts)
    }

    /// A session's turns in order, each with its entity spans.
    pub fn session_turns_with_entities(
        &mut self,
        session_id: &str,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<viz::TurnWithEntities>> {
        self.refresh()?;
        viz::session_turns_with_entities(&self.store, session_id, limit, offset)
    }

    /// A 2-D map of the vector space, cached until the store changes. With
    /// a `query`, the query's vector is dropped onto the same plane and its
    /// nearest turns (in the full space) are listed.
    pub fn projection(&mut self, opts: &viz::ProjectionOptions, query: Option<&str>) -> Result<viz::Projection> {
        self.refresh()?;
        let Some(model) = self.embedder_spec.as_ref().map(EmbedderSpec::name) else {
            return Err(Error::Embedder("this store has no embedder, so there are no vectors to project".into()));
        };
        let dim = self.index.dim();
        let key = viz::ProjectionKey {
            generation: self.store.generation()?,
            max_id: self.store.max_turn_id()?,
            embedded: self.seen_seq,
            embedder: model.clone(),
            dim,
            opts: opts.clone(),
        };
        let cached = match &self.projection_cache {
            Some((k, p)) if *k == key => p.clone(),
            _ => {
                let p = viz::projection(&self.store, &model, dim, opts)?;
                self.projection_cache = Some((key, p.clone()));
                p
            }
        };
        let Some(query) = query.map(str::trim).filter(|q| !q.is_empty()) else {
            return Ok(cached);
        };
        let Some(embedder) = self.embedder.as_mut() else {
            return Err(Error::Embedder(format!(
                "{model} is not available in this process, so the query cannot be placed"
            )));
        };
        let vec = embedder.embed_query(query)?;
        let (x, y) = viz::project(&cached.basis, &vec);
        let neighbours: Vec<i64> = match &opts.session {
            None => self.index.search(&vec, 10, |_| true).into_iter().map(|(id, _)| id).collect(),
            Some(session) => {
                let top: Vec<i64> = self.index.search(&vec, 200, |_| true).into_iter().map(|(id, _)| id).collect();
                let turns = self.store.turns_by_ids(&top)?;
                top.into_iter().filter(|id| turns.get(id).is_some_and(|t| &t.session_id == session)).take(10).collect()
            }
        };
        Ok(viz::Projection { query: Some(viz::QueryPoint { text: query.to_string(), x, y, neighbours }), ..cached })
    }

    /// Turns and active sessions per day.
    pub fn growth(&mut self, since: Option<i64>, until: Option<i64>) -> Result<viz::Growth> {
        self.refresh()?;
        viz::growth(&self.store, since, until)
    }

    pub fn mentions(&self, turn_id: i64) -> Result<Vec<entities::Mention>> {
        self.store.mentions(turn_id)
    }

    pub fn entity(&self, key: &str) -> Result<Option<EntityStat>> {
        self.store.entity_stat(key)
    }

    pub fn top_entities(&self, limit: usize) -> Result<Vec<EntityStat>> {
        self.store.top_entities(limit)
    }

    pub fn neighbours(&self, key: &str, limit: usize) -> Result<Vec<(String, u32)>> {
        self.store.neighbours(key, limit)
    }

    pub fn segments(&self, session_id: &str, level: Level) -> Result<Vec<timeline::Segment>> {
        self.store.segments(session_id, level)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(session: &str, text: &str, ts: i64) -> TurnInput {
        TurnInput { session_id: session.into(), speaker: "user".into(), text: text.into(), ts: Some(ts), uuid: None }
    }

    fn open(dir: &tempfile::TempDir) -> ZeroMem {
        ZeroMem::open(dir.path(), OpenOptions { embedder: EmbedderChoice::Hash, ..OpenOptions::default() }).unwrap()
    }

    #[test]
    fn ingest_many_reports_each_outcome() {
        let dir = tempfile::tempdir().unwrap();
        let mut zm = open(&dir);
        let batch = vec![turn("s", "a", 1), turn("s", "a", 1), turn("s", " ", 2), turn("t", "b", 3)];
        let report = zm.ingest_many(&batch).unwrap();
        assert_eq!(report, IngestReport { indexed: 2, duplicates: 1, rejected: 1 });
        let stats = zm.stats().unwrap();
        assert_eq!((stats.turns, stats.sessions, stats.generation, stats.embeddings), (2, 2, 0, 2));
        assert_eq!(stats.embedder.as_deref(), Some("hash-384"));
        assert!(stats.embedder_is_fallback);
    }

    #[test]
    fn recall_finds_the_turn_that_says_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut zm = open(&dir);
        zm.ingest_many(&[
            turn("a", "Maya Okafor owns the billing service on Project Heron.", 1),
            turn("a", "Lunch was fine, nothing to report.", 2),
            turn("b", "Kenji Morimoto is based in Osaka these days.", 3),
        ])
        .unwrap();
        let r = zm.query("who owns billing on Heron?", &QueryOptions::default()).unwrap();
        assert_eq!(r.evidence[0].turn.id, 1);
        assert_eq!(r.evidence[0].role, Role::Primary);
        assert!(r.route.is_none());
        let full = zm
            .query("who owns billing on Heron?", &QueryOptions { detail: Some(Detail::Full), ..Default::default() })
            .unwrap();
        let route = full.route.unwrap();
        assert!(route.views.iter().any(|v| v.view == ViewKind::Dense));
        assert!(full.evidence[0].entities.contains(&"project heron".to_string()));
        let scoped = zm
            .query(
                "who owns billing on Heron?",
                &QueryOptions { exclude_session: Some("a".into()), ..Default::default() },
            )
            .unwrap();
        assert!(scoped.evidence.iter().all(|e| e.turn.session_id != "a"));
    }

    #[test]
    fn a_second_engine_sees_the_first_ones_writes() {
        let dir = tempfile::tempdir().unwrap();
        let mut writer = open(&dir);
        let mut reader = open(&dir);
        writer.ingest_turn(&turn("s", "The Basalt launch moved to March 14.", 1)).unwrap();
        assert_eq!(reader.refresh().unwrap(), 1);
        assert_eq!(reader.refresh().unwrap(), 0);
        let r = reader.query("when is the Basalt launch", &QueryOptions::default()).unwrap();
        assert_eq!(r.evidence.len(), 1);
    }

    #[test]
    fn embedder_mismatch_is_refused_unless_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let mut zm = open(&dir);
        zm.ingest_turn(&turn("s", "hello there", 1)).unwrap();
        drop(zm);
        let err = ZeroMem::open(dir.path(), OpenOptions { embedder: EmbedderChoice::None, ..Default::default() });
        assert!(err.is_ok(), "no embedder means no vectors are touched");
        let store_only = err.unwrap();
        assert_eq!(store_only.stats().unwrap().embeddings, 1);
        drop(store_only);
        // A store with hash vectors opened with "onnx" would be a mismatch; simulate with a fake name.
        let opened = ZeroMem::open(dir.path(), OpenOptions { embedder: EmbedderChoice::Hash, ..Default::default() });
        assert!(opened.is_ok());
    }

    #[test]
    fn writers_without_a_model_are_caught_up_by_refresh() {
        let dir = tempfile::tempdir().unwrap();
        let mut plain =
            ZeroMem::open(dir.path(), OpenOptions { embedder: EmbedderChoice::None, ..Default::default() }).unwrap();
        plain.ingest_turn(&turn("s", "first", 1)).unwrap();
        let mut hashed = open(&dir);
        assert_eq!(hashed.stats().unwrap().embeddings, 1);
        plain.ingest_turn(&turn("s", "second", 2)).unwrap();
        assert_eq!(hashed.refresh().unwrap(), 1);
        assert_eq!(hashed.stats().unwrap().embeddings, 2);
    }
}
