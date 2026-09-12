//! The SQLite file. Everything the engine knows lives here; every other
//! module's state can be rebuilt from the `turns` table alone.
//!
//! Two tiers of derived data. Per-turn artifacts — entity mentions, the
//! full-text index, the embedding — are written in the same transaction as
//! the turn and never recomputed. Aggregates — entity statistics, the
//! co-occurrence graph, the session segmentation — are maintained
//! incrementally on insert and recomputed on delete, so the file is always
//! self-consistent and only in-memory caches need to notice a change;
//! `generation` is the signal for those.
//!
//! WAL mode with a busy timeout so a hook process appending turns and a
//! long-running server reading them can share the file without either
//! seeing `SQLITE_BUSY`.
//!
//! The store owns the embedder: `meta` holds the spec that built the
//! vectors and every writer checks, inside its write transaction, that the
//! model it embedded with is still the store's. A writer that lost that
//! race stores its turns without vectors and reports `EmbedderChanged`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use sha2::{Digest, Sha256};

use crate::dense::{self, EmbedderSpec};
use crate::entities::{self, EntityKind, Mention};
use crate::error::{Error, Result};
use crate::timeline::{self, Level, Segment, TurnRef};
use crate::types::{
    EdgeRow, EmbeddingRow, EntityStat, IngestOutcome, MentionRow, SegmentRow, SessionSummary, Turn, TurnInput, TurnKind,
};

/// v5 changed extraction (paths, code symbols and env vars became kinds),
/// so a store below it re-derives its entity tables once on open; v4 added curation (`turns.kind`, the flag, alias, blocklist and note
/// tables, the action log); v3 gave `embeddings` an insertion sequence so
/// backfilled vectors are picked up by readers; v2 was the last change to a
/// derived table.
pub const SCHEMA_VERSION: i64 = 5;
const REBUILD_BELOW: i64 = 5;
const DB_FILE: &str = "zeromem.db";

/// One stored vector with its position in insertion order.
pub type EmbeddingAt = (i64, i64, Vec<f32>);

/// One outcome per input, plus whether the vectors were dropped because
/// the store's embedder is no longer the one they came from.
pub struct Inserted {
    pub outcomes: Vec<Result<IngestOutcome>>,
    pub embedder_changed: bool,
}

/// Sampled `(turn_id, vector)` pairs and the size of the population they
/// were drawn from.
pub type EmbeddingSample = (Vec<(i64, Vec<f32>)>, u64);

pub struct Store {
    pub(crate) conn: Connection,
    path: PathBuf,
}

/// What `open` found and did.
pub struct Opened {
    pub store: Store,
    /// True when the schema was upgraded and derived tables must be rebuilt.
    pub needs_rebuild: bool,
}

impl Store {
    /// Open (creating if needed) the database under `home`.
    pub fn open(home: &Path) -> Result<Opened> {
        std::fs::create_dir_all(home).map_err(|e| Error::Home(home.to_path_buf(), e))?;
        let path = home.join(DB_FILE);
        let conn = Connection::open(&path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let store = Store { conn, path };
        let needs_rebuild = store.migrate()?;
        Ok(Opened { store, needs_rebuild })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn migrate(&self) -> Result<bool> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS turns (
                id         INTEGER PRIMARY KEY,
                uuid       TEXT    NOT NULL UNIQUE,
                session_id TEXT    NOT NULL,
                speaker    TEXT    NOT NULL,
                text       TEXT    NOT NULL,
                ts         INTEGER NOT NULL,
                created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS turns_session_ts ON turns (session_id, ts, id);
             CREATE INDEX IF NOT EXISTS turns_ts ON turns (ts, id);

             CREATE TABLE IF NOT EXISTS turn_entities (
                turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
                entity  TEXT    NOT NULL,
                kind    TEXT    NOT NULL,
                start   INTEGER NOT NULL,
                end     INTEGER NOT NULL,
                surface TEXT    NOT NULL
             );
             CREATE INDEX IF NOT EXISTS turn_entities_entity ON turn_entities (entity, turn_id);
             CREATE INDEX IF NOT EXISTS turn_entities_turn ON turn_entities (turn_id);

             CREATE TABLE IF NOT EXISTS entity_stats (
                entity   TEXT PRIMARY KEY,
                kind     TEXT    NOT NULL,
                turns    INTEGER NOT NULL,
                first_ts INTEGER NOT NULL,
                last_ts  INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS entity_edges (
                a     TEXT    NOT NULL,
                b     TEXT    NOT NULL,
                turns INTEGER NOT NULL,
                PRIMARY KEY (a, b)
             );
             CREATE INDEX IF NOT EXISTS entity_edges_b ON entity_edges (b, a);

             CREATE TABLE IF NOT EXISTS embeddings (
                seq     INTEGER PRIMARY KEY AUTOINCREMENT,
                turn_id INTEGER NOT NULL UNIQUE REFERENCES turns(id) ON DELETE CASCADE,
                model   TEXT    NOT NULL,
                vec     BLOB    NOT NULL
             );

             CREATE TABLE IF NOT EXISTS segments (
                id            INTEGER PRIMARY KEY,
                session_id    TEXT    NOT NULL,
                level         TEXT    NOT NULL,
                start_ts      INTEGER NOT NULL,
                end_ts        INTEGER NOT NULL,
                first_turn_id INTEGER NOT NULL,
                last_turn_id  INTEGER NOT NULL,
                turns         INTEGER NOT NULL,
                entities      TEXT    NOT NULL
             );
             CREATE INDEX IF NOT EXISTS segments_session ON segments (session_id, level, start_ts);

             CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
                text, content='turns', content_rowid='id', tokenize='porter unicode61'
             );
             CREATE TRIGGER IF NOT EXISTS turns_fts_insert AFTER INSERT ON turns BEGIN
                INSERT INTO turns_fts(rowid, text) VALUES (new.id, new.text);
             END;
             CREATE TRIGGER IF NOT EXISTS turns_fts_delete AFTER DELETE ON turns BEGIN
                INSERT INTO turns_fts(turns_fts, rowid, text) VALUES ('delete', old.id, old.text);
             END;

             CREATE TABLE IF NOT EXISTS curation_actions (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id    TEXT    NOT NULL,
                actor     TEXT    NOT NULL,
                ts        INTEGER NOT NULL,
                op        TEXT    NOT NULL,
                payload   TEXT    NOT NULL,
                reason    TEXT    NOT NULL,
                undone_at INTEGER,
                undone_by TEXT
             );
             CREATE INDEX IF NOT EXISTS curation_actions_run ON curation_actions (run_id, id);
             CREATE TABLE IF NOT EXISTS turn_flags (
                turn_id       INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
                hidden        INTEGER NOT NULL DEFAULT 0,
                superseded_by INTEGER REFERENCES turns(id) ON DELETE SET NULL,
                action_id     INTEGER
             );
             CREATE TABLE IF NOT EXISTS entity_aliases (
                alias     TEXT PRIMARY KEY,
                canonical TEXT    NOT NULL,
                action_id INTEGER
             );
             CREATE TABLE IF NOT EXISTS entity_blocklist (
                entity    TEXT PRIMARY KEY,
                action_id INTEGER
             );
             CREATE TABLE IF NOT EXISTS note_sources (
                note_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
                turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
                PRIMARY KEY (note_id, turn_id)
             );
             CREATE INDEX IF NOT EXISTS note_sources_turn ON note_sources (turn_id);",
        )?;
        self.migrate_embeddings_to_v3()?;
        self.migrate_turn_kind()?;
        let stored = self.meta_i64("schema_version")?;
        let mut needs_rebuild = false;
        if stored == 0 {
            self.set_meta("schema_version", &SCHEMA_VERSION.to_string())?;
        } else if stored < SCHEMA_VERSION {
            self.set_meta("schema_version", &SCHEMA_VERSION.to_string())?;
            needs_rebuild = stored < REBUILD_BELOW;
        }
        if self.meta("generation")?.is_none() {
            self.set_meta("generation", "0")?;
        }
        Ok(needs_rebuild)
    }

    /// A v2 `embeddings` table is keyed by turn id alone. Recreate it with
    /// the sequence column, keeping every vector in turn order. Decided by
    /// the table's shape, not the version stamp, so it is safe to rerun.
    fn migrate_embeddings_to_v3(&self) -> Result<()> {
        let has_seq: bool = {
            let mut stmt = self.conn.prepare("PRAGMA table_info(embeddings)")?;
            let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
            let names: Vec<String> = names.collect::<rusqlite::Result<_>>()?;
            names.iter().any(|n| n == "seq")
        };
        if has_seq {
            return Ok(());
        }
        log::info!("upgrading the embeddings table to schema v3");
        self.conn.execute_batch(
            "BEGIN IMMEDIATE;
             CREATE TABLE embeddings_v3 (
                seq     INTEGER PRIMARY KEY AUTOINCREMENT,
                turn_id INTEGER NOT NULL UNIQUE REFERENCES turns(id) ON DELETE CASCADE,
                model   TEXT    NOT NULL,
                vec     BLOB    NOT NULL
             );
             INSERT INTO embeddings_v3 (turn_id, model, vec)
                SELECT turn_id, model, vec FROM embeddings ORDER BY turn_id;
             DROP TABLE embeddings;
             ALTER TABLE embeddings_v3 RENAME TO embeddings;
             COMMIT;",
        )?;
        Ok(())
    }

    /// v4 gave `turns` a `kind`. Decided by the table's shape, like v3.
    fn migrate_turn_kind(&self) -> Result<()> {
        let has_kind: bool = {
            let mut stmt = self.conn.prepare("PRAGMA table_info(turns)")?;
            let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
            let names: Vec<String> = names.collect::<rusqlite::Result<_>>()?;
            names.iter().any(|n| n == "kind")
        };
        if !has_kind {
            log::info!("adding turns.kind for schema v4");
            self.conn.execute_batch("ALTER TABLE turns ADD COLUMN kind TEXT NOT NULL DEFAULT 'turn';")?;
        }
        Ok(())
    }

    // --- meta ---------------------------------------------------------------

    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self.conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn meta_i64(&self, key: &str) -> Result<i64> {
        Ok(self.meta(key)?.and_then(|v| v.parse().ok()).unwrap_or(0))
    }

    pub fn generation(&self) -> Result<i64> {
        self.meta_i64("generation")
    }

    /// The spec that built this store's vectors. A store from before specs
    /// were recorded is read through its `embedder` name.
    pub fn embedder_spec(&self) -> Result<Option<EmbedderSpec>> {
        if let Some(json) = self.meta("embedder_spec")? {
            return Ok(Some(serde_json::from_str(&json)?));
        }
        Ok(self.meta("embedder")?.and_then(|name| EmbedderSpec::from_legacy_name(&name)))
    }

    /// Record the embedder of a store that has none yet. No vectors exist
    /// to drop and no reader's index to invalidate, so the generation is
    /// left alone.
    pub fn seed_embedder(&mut self, spec: &EmbedderSpec) -> Result<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::write_embedder_meta(&tx, spec)?;
        tx.commit()?;
        Ok(())
    }

    /// Change the embedder: record the spec, drop every vector and bump the
    /// generation, in one transaction, so no reader can see the new name
    /// with the old vectors or the other way round.
    pub fn switch_embedder(&mut self, spec: &EmbedderSpec) -> Result<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::write_embedder_meta(&tx, spec)?;
        tx.execute("DELETE FROM embeddings", [])?;
        Self::bump_generation(&tx)?;
        tx.commit()?;
        Ok(())
    }

    /// Update the spec of the embedder already in use — a new key, a new
    /// timeout — without touching the vectors. The name must not change.
    pub fn update_embedder_spec(&mut self, spec: &EmbedderSpec) -> Result<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if Self::stored_embedder_name(&tx)?.as_deref() != Some(spec.name().as_str()) {
            return Err(Error::EmbedderChanged(spec.name()));
        }
        Self::write_embedder_meta(&tx, spec)?;
        tx.commit()?;
        Ok(())
    }

    fn write_embedder_meta(tx: &Transaction<'_>, spec: &EmbedderSpec) -> Result<()> {
        let upsert = "INSERT INTO meta (key, value) VALUES (?1, ?2)
                      ON CONFLICT(key) DO UPDATE SET value = excluded.value";
        tx.execute(upsert, params!["embedder", spec.name()])?;
        tx.execute(upsert, params!["embedder_spec", serde_json::to_string(spec)?])?;
        Ok(())
    }

    fn stored_embedder_name(tx: &Transaction<'_>) -> Result<Option<String>> {
        Ok(tx.query_row("SELECT value FROM meta WHERE key = 'embedder'", [], |r| r.get(0)).optional()?)
    }

    pub(crate) fn stored_generation(tx: &Transaction<'_>) -> Result<i64> {
        Ok(tx
            .query_row("SELECT value FROM meta WHERE key = 'generation'", [], |r| r.get::<_, String>(0))
            .optional()?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0))
    }

    pub(crate) fn bump_generation(tx: &Transaction<'_>) -> Result<i64> {
        let next = Self::stored_generation(tx)? + 1;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES ('generation', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [next.to_string()],
        )?;
        Ok(next)
    }

    // --- writes -------------------------------------------------------------

    /// Insert a batch in one transaction. `vectors[i]` is the embedding for
    /// `inputs[i]` when the caller has one. Returns one outcome per input in
    /// order, `Err(InvalidTurn)` entries included. The vectors are kept only
    /// if `model` is still the store's embedder; otherwise the turns land
    /// without them and `embedder_changed` says so.
    pub fn insert_batch(
        &mut self,
        inputs: &[TurnInput],
        vectors: &[Option<Vec<f32>>],
        model: Option<&str>,
    ) -> Result<Inserted> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let embedder_changed = match model {
            Some(model) => Self::stored_embedder_name(&tx)?.as_deref() != Some(model),
            None => false,
        };
        let model = if embedder_changed { None } else { model };
        let mut outcomes = Vec::with_capacity(inputs.len());
        let mut touched_sessions = BTreeSet::new();
        let map = EntityMap::load(&tx)?;
        for (i, input) in inputs.iter().enumerate() {
            let vector = vectors.get(i).and_then(|v| v.as_deref());
            match insert_one(&tx, input, vector, model, TurnKind::Turn, &map) {
                Ok(outcome) => {
                    if matches!(outcome, IngestOutcome::Indexed { .. }) {
                        touched_sessions.insert(input.session_id.clone());
                    }
                    outcomes.push(Ok(outcome));
                }
                Err(e @ Error::InvalidTurn(_)) => outcomes.push(Err(e)),
                Err(e) => return Err(e),
            }
        }
        for session in touched_sessions {
            resegment(&tx, &session)?;
        }
        tx.commit()?;
        Ok(Inserted { outcomes, embedder_changed })
    }

    pub fn delete_session(&mut self, session_id: &str) -> Result<u32> {
        let tx = self.conn.transaction()?;
        let removed = tx.execute("DELETE FROM turns WHERE session_id = ?1", [session_id])?;
        if removed > 0 {
            tx.execute("DELETE FROM segments WHERE session_id = ?1", [session_id])?;
            rebuild_aggregates(&tx)?;
            Self::bump_generation(&tx)?;
        }
        tx.commit()?;
        Ok(removed as u32)
    }

    /// Throw away every derived table and recompute it from `turns`. The
    /// embeddings survive unless `clear_embeddings` — they are the one thing
    /// that is expensive to make again. Curation is state, not derived: it
    /// survives, and the aliases and blocklist are applied again.
    pub fn rebuild(&mut self, clear_embeddings: bool) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute_batch("INSERT INTO turns_fts(turns_fts) VALUES ('rebuild');")?;
        if clear_embeddings {
            tx.execute("DELETE FROM embeddings", [])?;
        }
        rederive_entities(&tx)?;
        Self::bump_generation(&tx)?;
        tx.commit()?;
        Ok(())
    }

    /// Drop every vector and bump the generation, in one transaction. The
    /// embedder is left as it is, so every turn joins its backlog. Returns
    /// how many vectors went.
    pub fn clear_embeddings(&mut self) -> Result<u64> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let removed = tx.execute("DELETE FROM embeddings", [])?;
        Self::bump_generation(&tx)?;
        tx.commit()?;
        Ok(removed as u64)
    }

    /// Forget everything: every turn and every row derived from one, in one
    /// transaction with a generation bump. `meta` stays (the embedder, its
    /// key, the schema version), so the store takes new turns at once.
    pub fn clear_memory(&mut self) -> Result<crate::types::ClearReport> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let sessions: i64 = tx.query_row("SELECT COUNT(DISTINCT session_id) FROM turns", [], |r| r.get(0))?;
        let vectors = tx.execute("DELETE FROM embeddings", [])?;
        tx.execute_batch(
            "DELETE FROM turn_entities;
             DELETE FROM segments;
             DELETE FROM entity_stats;
             DELETE FROM entity_edges;
             DELETE FROM turn_flags;
             DELETE FROM note_sources;
             DELETE FROM entity_aliases;
             DELETE FROM entity_blocklist;
             DELETE FROM curation_actions;
             DELETE FROM meta WHERE key = 'curation_cursor';",
        )?;
        // The delete trigger keeps turns_fts in step, row by row.
        let turns = tx.execute("DELETE FROM turns", [])?;
        crate::curation::bump_curation_seq(&tx)?;
        Self::bump_generation(&tx)?;
        tx.commit()?;
        Ok(crate::types::ClearReport {
            turns_removed: turns as u64,
            sessions_removed: sessions as u64,
            vectors_removed: vectors as u64,
            turns_to_embed: 0,
        })
    }

    /// Store vectors for turns that were ingested without one. Refused,
    /// writing nothing, when `model` is no longer the store's embedder — a
    /// writer holding a pre-switch backlog must not overwrite new vectors —
    /// or when the generation moved since the caller read its backlog at
    /// `generation`: after a clear, a turn id can name a different turn.
    pub fn write_embeddings(&mut self, rows: &[(i64, Vec<f32>)], model: &str, generation: i64) -> Result<()> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if Self::stored_embedder_name(&tx)?.as_deref() != Some(model) {
            return Err(Error::EmbedderChanged(model.to_string()));
        }
        if Self::stored_generation(&tx)? != generation {
            return Err(Error::StoreChanged);
        }
        for (id, vec) in rows {
            tx.execute(
                "INSERT OR REPLACE INTO embeddings (turn_id, model, vec) VALUES (?1, ?2, ?3)",
                params![id, model, dense::to_blob(vec)],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    // --- reads: turns -------------------------------------------------------

    pub fn turn(&self, id: i64) -> Result<Option<Turn>> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, uuid, session_id, speaker, text, ts, kind FROM turns WHERE id = ?1",
                [id],
                row_to_turn,
            )
            .optional()?)
    }

    pub fn turns_by_ids(&self, ids: &[i64]) -> Result<BTreeMap<i64, Turn>> {
        let mut stmt =
            self.conn.prepare("SELECT id, uuid, session_id, speaker, text, ts, kind FROM turns WHERE id = ?1")?;
        let mut out = BTreeMap::new();
        for id in ids {
            if let Some(t) = stmt.query_row([id], row_to_turn).optional()? {
                out.insert(*id, t);
            }
        }
        Ok(out)
    }

    pub fn count_turns(&self) -> Result<u64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM turns", [], |r| r.get::<_, i64>(0))? as u64)
    }

    pub fn count_sessions(&self) -> Result<u64> {
        Ok(self.conn.query_row("SELECT COUNT(DISTINCT session_id) FROM turns", [], |r| r.get::<_, i64>(0))? as u64)
    }

    pub fn max_turn_id(&self) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COALESCE(MAX(id), 0) FROM turns", [], |r| r.get(0))?)
    }

    pub fn count_turns_after(&self, id: i64) -> Result<u32> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM turns WHERE id > ?1", [id], |r| r.get::<_, i64>(0))? as u32)
    }

    pub fn latest_ts(&self) -> Result<i64> {
        Ok(self.conn.query_row("SELECT COALESCE(MAX(ts), 0) FROM turns", [], |r| r.get(0))?)
    }

    pub fn list_sessions(&self, limit: u32, offset: u32) -> Result<Vec<SessionSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id, COUNT(*), MIN(ts), MAX(ts) FROM turns
             GROUP BY session_id
             ORDER BY MAX(ts) DESC, session_id
             LIMIT ?1 OFFSET ?2",
        )?;
        let rows = stmt.query_map(params![limit, offset], |r| {
            Ok(SessionSummary { session_id: r.get(0)?, turns: r.get(1)?, first_ts: r.get(2)?, last_ts: r.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn session_turns(&self, session_id: &str, limit: u32, offset: u32) -> Result<Vec<Turn>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, uuid, session_id, speaker, text, ts, kind FROM turns
             WHERE session_id = ?1 ORDER BY ts, id LIMIT ?2 OFFSET ?3",
        )?;
        let rows = stmt.query_map(params![session_id, limit, offset], row_to_turn)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The turns immediately before and after `turn` in its own session,
    /// both oldest first. Two seeks on `turns_session_ts`, never a scan of
    /// the session. The `(ts, id)` tie-break matches
    /// [`Self::session_turns`], so a window and a session read never
    /// disagree about turns that share a millisecond — a transcript ingest
    /// writes many of those.
    pub fn session_neighbours(&self, turn: &Turn, before: u32, after: u32) -> Result<(Vec<Turn>, Vec<Turn>)> {
        let mut earlier = Vec::new();
        if before > 0 {
            let mut stmt = self.conn.prepare(
                "SELECT id, uuid, session_id, speaker, text, ts, kind FROM turns
                 WHERE session_id = ?1 AND (ts < ?2 OR (ts = ?2 AND id < ?3))
                 ORDER BY ts DESC, id DESC LIMIT ?4",
            )?;
            let rows = stmt.query_map(params![turn.session_id, turn.ts, turn.id, before], row_to_turn)?;
            earlier = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            earlier.reverse();
        }
        let mut later = Vec::new();
        if after > 0 {
            let mut stmt = self.conn.prepare(
                "SELECT id, uuid, session_id, speaker, text, ts, kind FROM turns
                 WHERE session_id = ?1 AND (ts > ?2 OR (ts = ?2 AND id > ?3))
                 ORDER BY ts, id LIMIT ?4",
            )?;
            let rows = stmt.query_map(params![turn.session_id, turn.ts, turn.id, after], row_to_turn)?;
            later = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        }
        Ok((earlier, later))
    }

    pub fn count_session_turns(&self, session_id: &str) -> Result<u32> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM turns WHERE session_id = ?1", [session_id], |r| r.get::<_, i64>(0))?
            as u32)
    }

    /// How many of the session's turns come before `turn` in `ts, id` order
    /// — a window's `offset` into its session.
    pub fn session_turn_rank(&self, turn: &Turn) -> Result<u32> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM turns WHERE session_id = ?1 AND (ts < ?2 OR (ts = ?2 AND id < ?3))",
            params![turn.session_id, turn.ts, turn.id],
            |r| r.get::<_, i64>(0),
        )? as u32)
    }

    /// Every turn, ordered by uuid.
    pub fn all_turns(&self) -> Result<Vec<Turn>> {
        let mut stmt =
            self.conn.prepare("SELECT id, uuid, session_id, speaker, text, ts, kind FROM turns ORDER BY uuid")?;
        let rows = stmt.query_map([], row_to_turn)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // --- reads: retrieval views ---------------------------------------------

    /// BM25 over the full-text index. `terms` are OR-ed; the score is
    /// positive, larger is better.
    /// Hidden turns are left out unless `include_hidden`.
    pub fn lexical_search(&self, terms: &[String], limit: usize, include_hidden: bool) -> Result<Vec<(i64, f64)>> {
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let query = terms.iter().map(|t| format!("\"{}\"", t.replace('"', ""))).collect::<Vec<_>>().join(" OR ");
        let mut stmt = self.conn.prepare(
            "SELECT rowid, -bm25(turns_fts) AS score FROM turns_fts
             WHERE turns_fts MATCH ?1
               AND (?3 OR rowid NOT IN (SELECT turn_id FROM turn_flags WHERE hidden = 1))
             ORDER BY score DESC, rowid DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![query, limit as i64, include_hidden], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Turns mentioning any of `keys`, with the count of distinct keys each
    /// mentions. Larger counts first.
    pub fn turns_mentioning(&self, keys: &[String], limit: usize, include_hidden: bool) -> Result<Vec<(i64, u32)>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = keys.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT turn_id, COUNT(DISTINCT entity) AS n FROM turn_entities
             WHERE entity IN ({placeholders})
               AND (? OR turn_id NOT IN (SELECT turn_id FROM turn_flags WHERE hidden = 1))
             GROUP BY turn_id ORDER BY n DESC, turn_id DESC LIMIT ?"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let mut args: Vec<rusqlite::types::Value> = keys.iter().map(|k| k.clone().into()).collect();
        args.push(i64::from(include_hidden).into());
        args.push((limit as i64).into());
        let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as u32)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Which of `candidates` the store already holds as entity keys.
    ///
    /// Keys found in more than `max_turns` turns are discarded: one that
    /// appears across most of the corpus does not narrow anything down, and
    /// the junk the shape rules do produce (`see`, `todo`, `o`) is exactly
    /// what sits up there. `entity_stats.entity` is the primary key, so this
    /// is one indexed lookup however many candidates a question yields —
    /// deliberately not `all_entity_stats`, which would put a full table
    /// read on the recall path.
    pub fn known_entities(&self, candidates: &[String], max_turns: u32) -> Result<Vec<String>> {
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = candidates.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("SELECT entity FROM entity_stats WHERE entity IN ({placeholders}) AND turns <= ?");
        let mut stmt = self.conn.prepare(&sql)?;
        let mut args: Vec<rusqlite::types::Value> = candidates.iter().map(|c| c.clone().into()).collect();
        args.push(i64::from(max_turns).into());
        let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| r.get::<_, String>(0))?;
        let found: std::collections::HashSet<String> = rows.collect::<rusqlite::Result<_>>()?;
        // Back into the caller's order, which is longest n-gram first.
        Ok(candidates.iter().filter(|c| found.contains(*c)).cloned().collect())
    }

    /// Strongest co-occurring entities of `key`, most shared turns first.
    pub fn neighbours(&self, key: &str, limit: usize) -> Result<Vec<(String, u32)>> {
        let mut stmt = self.conn.prepare(
            "SELECT other, turns FROM (
                SELECT b AS other, turns FROM entity_edges WHERE a = ?1
                UNION ALL
                SELECT a AS other, turns FROM entity_edges WHERE b = ?1
             ) ORDER BY turns DESC, other LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![key, limit as i64], |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as u32)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn entity_stat(&self, key: &str) -> Result<Option<EntityStat>> {
        Ok(self
            .conn
            .query_row(
                "SELECT entity, kind, turns, first_ts, last_ts FROM entity_stats WHERE entity = ?1",
                [key],
                row_to_stat,
            )
            .optional()?)
    }

    pub fn top_entities(&self, limit: usize) -> Result<Vec<EntityStat>> {
        let mut stmt = self.conn.prepare(
            "SELECT entity, kind, turns, first_ts, last_ts FROM entity_stats ORDER BY turns DESC, entity LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], row_to_stat)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn count_entities(&self) -> Result<u64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM entity_stats", [], |r| r.get::<_, i64>(0))? as u64)
    }

    pub fn count_edges(&self) -> Result<u64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM entity_edges", [], |r| r.get::<_, i64>(0))? as u64)
    }

    pub fn count_segments(&self, level: Level) -> Result<u64> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM segments WHERE level = ?1", [level.as_str()], |r| r.get::<_, i64>(0))?
            as u64)
    }

    pub fn count_embeddings(&self) -> Result<u64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM embeddings", [], |r| r.get::<_, i64>(0))? as u64)
    }

    /// Mentions of one turn in text order.
    pub fn mentions(&self, turn_id: i64) -> Result<Vec<Mention>> {
        let mut stmt = self
            .conn
            .prepare("SELECT entity, kind, start, end, surface FROM turn_entities WHERE turn_id = ?1 ORDER BY start")?;
        let rows = stmt.query_map([turn_id], |r| {
            Ok(Mention {
                key: r.get(0)?,
                kind: EntityKind::parse(&r.get::<_, String>(1)?).unwrap_or(EntityKind::Name),
                start: r.get::<_, i64>(2)? as usize,
                end: r.get::<_, i64>(3)? as usize,
                surface: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Segments of one session at one level, in time order.
    pub fn segments(&self, session_id: &str, level: Level) -> Result<Vec<Segment>> {
        let mut stmt = self.conn.prepare(
            "SELECT level, start_ts, end_ts, first_turn_id, last_turn_id, turns, entities FROM segments
             WHERE session_id = ?1 AND level = ?2 ORDER BY start_ts, first_turn_id",
        )?;
        let rows = stmt.query_map(params![session_id, level.as_str()], row_to_segment)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // --- reads: for the visualisations ---------------------------------------

    /// Sessions whose activity overlaps `[since, until]`, most recently
    /// active first. Either bound may be open.
    pub fn list_sessions_between(
        &self,
        since: Option<i64>,
        until: Option<i64>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<SessionSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT session_id, COUNT(*), MIN(ts), MAX(ts) FROM turns
             GROUP BY session_id
             HAVING (?1 IS NULL OR MAX(ts) >= ?1) AND (?2 IS NULL OR MIN(ts) <= ?2)
             ORDER BY MAX(ts) DESC, session_id
             LIMIT ?3 OFFSET ?4",
        )?;
        let rows = stmt.query_map(params![since, until, limit, offset], |r| {
            Ok(SessionSummary { session_id: r.get(0)?, turns: r.get(1)?, first_ts: r.get(2)?, last_ts: r.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// How many sessions overlap `[since, until]`.
    pub fn count_sessions_between(&self, since: Option<i64>, until: Option<i64>) -> Result<u64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM (
                SELECT session_id FROM turns GROUP BY session_id
                HAVING (?1 IS NULL OR MAX(ts) >= ?1) AND (?2 IS NULL OR MIN(ts) <= ?2)
             )",
            params![since, until],
            |r| r.get::<_, i64>(0).map(|n| n as u64),
        )?)
    }

    /// One session's summary, if it has any turns.
    pub fn session(&self, session_id: &str) -> Result<Option<SessionSummary>> {
        Ok(self
            .conn
            .query_row(
                "SELECT session_id, COUNT(*), MIN(ts), MAX(ts) FROM turns WHERE session_id = ?1 GROUP BY session_id",
                [session_id],
                |r| {
                    Ok(SessionSummary {
                        session_id: r.get(0)?,
                        turns: r.get(1)?,
                        first_ts: r.get(2)?,
                        last_ts: r.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    /// How many edges touch `key` in the whole graph.
    pub fn degree(&self, key: &str) -> Result<u32> {
        Ok(self.conn.query_row(
            "SELECT (SELECT COUNT(*) FROM entity_edges WHERE a = ?1) + (SELECT COUNT(*) FROM entity_edges WHERE b = ?1)",
            [key],
            |r| r.get::<_, i64>(0).map(|n| n as u32),
        )?)
    }

    /// Entities of one kind, most mentioned first.
    pub fn top_entities_of_kind(&self, kind: &str, limit: usize) -> Result<Vec<EntityStat>> {
        let mut stmt = self.conn.prepare(
            "SELECT entity, kind, turns, first_ts, last_ts FROM entity_stats WHERE kind = ?1
             ORDER BY turns DESC, entity LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![kind, limit as i64], row_to_stat)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Turns per calendar day (UTC), oldest first, plus how many sessions
    /// were active that day. `since`/`until` bound the range.
    pub fn turns_per_day(&self, since: Option<i64>, until: Option<i64>) -> Result<Vec<(String, u32, u32)>> {
        let mut stmt = self.conn.prepare(
            "SELECT date(ts / 1000, 'unixepoch') AS day, COUNT(*), COUNT(DISTINCT session_id) FROM turns
             WHERE (?1 IS NULL OR ts >= ?1) AND (?2 IS NULL OR ts <= ?2)
             GROUP BY day ORDER BY day",
        )?;
        let rows = stmt.query_map(params![since, until], |r| {
            Ok((r.get(0)?, r.get::<_, i64>(1)? as u32, r.get::<_, i64>(2)? as u32))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// A deterministic sample of at most `limit` vectors from `model`: every
    /// `stride`-th turn id, so the same store gives the same sample. Filters
    /// to one session when asked. Returns the sample and the population size.
    pub fn embeddings_sample(
        &self,
        model: &str,
        dim: usize,
        session: Option<&str>,
        limit: usize,
    ) -> Result<EmbeddingSample> {
        let total: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM embeddings e JOIN turns t ON t.id = e.turn_id
             WHERE e.model = ?1 AND (?2 IS NULL OR t.session_id = ?2)",
            params![model, session],
            |r| r.get(0),
        )?;
        let stride = (total as usize).checked_div(limit).unwrap_or(1).max(1) as i64;
        let mut stmt = self.conn.prepare(
            "SELECT e.turn_id, e.vec FROM embeddings e JOIN turns t ON t.id = e.turn_id
             WHERE e.model = ?1 AND (?2 IS NULL OR t.session_id = ?2) AND (e.turn_id % ?3) = 0
             ORDER BY e.turn_id LIMIT ?4",
        )?;
        let rows = stmt.query_map(params![model, session, stride, limit as i64], |r| {
            Ok((r.get(0)?, dense::from_blob(&r.get::<_, Vec<u8>>(1)?)))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, vec) = row?;
            if vec.len() == dim {
                out.push((id, vec));
            }
        }
        Ok((out, total as u64))
    }

    /// The ids of the turns in the most recent window of the store, across
    /// sessions, for temporal queries.
    pub fn recent_turn_ids(&self, limit: usize, include_hidden: bool) -> Result<Vec<i64>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM turns
             WHERE ?2 OR id NOT IN (SELECT turn_id FROM turn_flags WHERE hidden = 1)
             ORDER BY ts DESC, id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64, include_hidden], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // --- reads: embeddings --------------------------------------------------

    /// Vectors written after sequence `after`, in write order, as
    /// `(seq, turn_id, vector)`. `model` filters out rows a different
    /// embedder wrote and `dim` any of the wrong length. Ordering by write
    /// sequence rather than turn id is what lets a vector backfilled for an
    /// old turn reach a reader that has moved on.
    pub fn embeddings_after(&self, after: i64, model: &str, dim: usize) -> Result<Vec<EmbeddingAt>> {
        let mut stmt =
            self.conn.prepare("SELECT seq, turn_id, vec FROM embeddings WHERE seq > ?1 AND model = ?2 ORDER BY seq")?;
        let rows = stmt.query_map(params![after, model], |r| {
            Ok((r.get(0)?, r.get(1)?, dense::from_blob(&r.get::<_, Vec<u8>>(2)?)))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, id, vec) = row?;
            if vec.len() == dim {
                out.push((seq, id, vec));
            }
        }
        Ok(out)
    }

    /// How many turns have no vector from `model`.
    pub fn count_backlog(&self, model: &str) -> Result<u64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM turns t
             LEFT JOIN embeddings e ON e.turn_id = t.id AND e.model = ?1
             WHERE e.turn_id IS NULL",
            [model],
            |r| r.get::<_, i64>(0),
        )? as u64)
    }

    /// Turns with no vector from `model`, oldest first, capped.
    pub fn turns_without_embedding(&self, model: &str, limit: usize) -> Result<Vec<(i64, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.text FROM turns t
             LEFT JOIN embeddings e ON e.turn_id = t.id AND e.model = ?1
             WHERE e.turn_id IS NULL ORDER BY t.id LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![model, limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // --- reads: snapshot ----------------------------------------------------

    pub fn all_mentions(&self) -> Result<Vec<MentionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.uuid, e.entity, e.kind, e.start, e.end FROM turn_entities e
             JOIN turns t ON t.id = e.turn_id ORDER BY t.uuid, e.start, e.entity",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(MentionRow {
                uuid: r.get(0)?,
                entity: r.get(1)?,
                kind: r.get(2)?,
                start: r.get::<_, i64>(3)? as u32,
                end: r.get::<_, i64>(4)? as u32,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn all_entity_stats(&self) -> Result<Vec<EntityStat>> {
        let mut stmt =
            self.conn.prepare("SELECT entity, kind, turns, first_ts, last_ts FROM entity_stats ORDER BY entity")?;
        let rows = stmt.query_map([], row_to_stat)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn all_edges(&self) -> Result<Vec<EdgeRow>> {
        let mut stmt = self.conn.prepare("SELECT a, b, turns FROM entity_edges ORDER BY a, b")?;
        let rows =
            stmt.query_map([], |r| Ok(EdgeRow { a: r.get(0)?, b: r.get(1)?, turns: r.get::<_, i64>(2)? as u32 }))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn all_segments(&self) -> Result<Vec<SegmentRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT s.session_id, s.level, s.start_ts, s.end_ts, f.uuid, l.uuid, s.turns, s.entities FROM segments s
             JOIN turns f ON f.id = s.first_turn_id
             JOIN turns l ON l.id = s.last_turn_id
             ORDER BY s.session_id, s.level, s.start_ts, f.uuid",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SegmentRow {
                session_id: r.get(0)?,
                level: r.get(1)?,
                start_ts: r.get(2)?,
                end_ts: r.get(3)?,
                first_uuid: r.get(4)?,
                last_uuid: r.get(5)?,
                turns: r.get::<_, i64>(6)? as u32,
                entities: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default(),
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn all_embeddings(&self) -> Result<Vec<EmbeddingRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.uuid, e.model, e.vec FROM embeddings e JOIN turns t ON t.id = e.turn_id ORDER BY t.uuid",
        )?;
        let rows = stmt.query_map([], |r| {
            let vec = dense::from_blob(&r.get::<_, Vec<u8>>(2)?);
            Ok(EmbeddingRow { uuid: r.get(0)?, model: r.get(1)?, dim: vec.len() as u32, digest: vector_digest(&vec) })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

// --- write helpers ---------------------------------------------------------

pub(crate) fn insert_one(
    tx: &Transaction<'_>,
    input: &TurnInput,
    vector: Option<&[f32]>,
    model: Option<&str>,
    kind: TurnKind,
    map: &EntityMap,
) -> Result<IngestOutcome> {
    validate(input)?;
    let uuid = input.uuid.clone().unwrap_or_else(|| derived_uuid(input));
    let ts = input.ts.unwrap_or_else(now_ms);
    let created_at = now_ms();
    let inserted = tx.execute(
        "INSERT OR IGNORE INTO turns (uuid, session_id, speaker, text, ts, created_at, kind)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![uuid, input.session_id, input.speaker, input.text, ts, created_at, kind.as_str()],
    )?;
    if inserted != 1 {
        let id: i64 = tx.query_row("SELECT id FROM turns WHERE uuid = ?1", [&uuid], |r| r.get(0))?;
        return Ok(IngestOutcome::Duplicate { id });
    }
    let id = tx.last_insert_rowid();
    let mentions = map.apply(entities::extract(&input.text));
    write_mentions(tx, id, &mentions)?;
    add_to_aggregates(tx, ts, &mentions)?;
    if let (Some(vec), Some(model)) = (vector, model) {
        tx.execute(
            "INSERT INTO embeddings (turn_id, model, vec) VALUES (?1, ?2, ?3)",
            params![id, model, dense::to_blob(vec)],
        )?;
    }
    Ok(IngestOutcome::Indexed { id })
}

fn write_mentions(tx: &Transaction<'_>, turn_id: i64, mentions: &[Mention]) -> Result<()> {
    let mut stmt = tx.prepare_cached(
        "INSERT INTO turn_entities (turn_id, entity, kind, start, end, surface) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for m in mentions {
        stmt.execute(params![turn_id, m.key, m.kind.as_str(), m.start as i64, m.end as i64, m.surface])?;
    }
    Ok(())
}

/// The curator's entity aliases and blocklist, applied to mentions as they
/// are written: an alias is stored under its canonical key, a blocked key
/// is not stored at all. Surfaces and offsets are left as extracted.
#[derive(Debug, Default)]
pub(crate) struct EntityMap {
    aliases: HashMap<String, String>,
    blocked: HashSet<String>,
}

impl EntityMap {
    pub(crate) fn load(conn: &Connection) -> Result<Self> {
        let mut stmt = conn.prepare_cached("SELECT alias, canonical FROM entity_aliases")?;
        let aliases = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        let mut stmt = conn.prepare_cached("SELECT entity FROM entity_blocklist")?;
        let blocked = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<HashSet<_>>>()?;
        Ok(EntityMap { aliases, blocked })
    }

    /// Follow aliases to the end of the chain. Apply refuses chains, but an
    /// undo can recreate one; the hop cap guards against a cycle.
    pub(crate) fn canonical<'a>(&'a self, key: &'a str) -> &'a str {
        let mut key = key;
        for _ in 0..8 {
            match self.aliases.get(key) {
                Some(next) => key = next,
                None => break,
            }
        }
        key
    }

    pub(crate) fn apply(&self, mentions: Vec<Mention>) -> Vec<Mention> {
        if self.aliases.is_empty() && self.blocked.is_empty() {
            return mentions;
        }
        mentions
            .into_iter()
            .filter_map(|mut m| {
                if self.blocked.contains(&m.key) {
                    return None;
                }
                let canonical = self.canonical(&m.key);
                if self.blocked.contains(canonical) {
                    return None;
                }
                if canonical != m.key {
                    m.key = canonical.to_string();
                }
                Some(m)
            })
            .collect()
    }
}

/// Recompute every mention, aggregate and segment from the turns' text
/// through the current `EntityMap`. What `rebuild` does short of FTS and
/// vectors, and what an alias or blocklist change does.
pub(crate) fn rederive_entities(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch("DELETE FROM turn_entities; DELETE FROM segments;")?;
    let map = EntityMap::load(tx)?;
    let turns: Vec<(i64, String)> = {
        let mut stmt = tx.prepare("SELECT id, text FROM turns ORDER BY id")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, text) in &turns {
        write_mentions(tx, *id, &map.apply(entities::extract(text)))?;
    }
    rebuild_aggregates(tx)?;
    let sessions: Vec<String> = {
        let mut stmt = tx.prepare("SELECT DISTINCT session_id FROM turns ORDER BY session_id")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for session in &sessions {
        resegment(tx, session)?;
    }
    Ok(())
}

/// Distinct entity keys of one turn, sorted, with the kind first seen.
fn distinct_keys(mentions: &[Mention]) -> Vec<(&str, EntityKind)> {
    let mut seen: BTreeMap<&str, EntityKind> = BTreeMap::new();
    for m in mentions {
        seen.entry(m.key.as_str()).or_insert(m.kind);
    }
    seen.into_iter().collect()
}

fn add_to_aggregates(tx: &Transaction<'_>, ts: i64, mentions: &[Mention]) -> Result<()> {
    let keys = distinct_keys(mentions);
    let mut stat = tx.prepare_cached(
        "INSERT INTO entity_stats (entity, kind, turns, first_ts, last_ts) VALUES (?1, ?2, 1, ?3, ?3)
         ON CONFLICT(entity) DO UPDATE SET
            turns = turns + 1,
            first_ts = MIN(first_ts, excluded.first_ts),
            last_ts = MAX(last_ts, excluded.last_ts)",
    )?;
    for (key, kind) in &keys {
        stat.execute(params![key, kind.as_str(), ts])?;
    }
    let mut edge = tx.prepare_cached(
        "INSERT INTO entity_edges (a, b, turns) VALUES (?1, ?2, 1)
         ON CONFLICT(a, b) DO UPDATE SET turns = turns + 1",
    )?;
    for i in 0..keys.len() {
        for j in i + 1..keys.len() {
            edge.execute(params![keys[i].0, keys[j].0])?;
        }
    }
    Ok(())
}

/// Recompute `entity_stats` and `entity_edges` from `turn_entities`. Used
/// after deletes and by `rebuild`; the incremental path must agree with
/// this exactly, which the oracle tests check.
pub(crate) fn rebuild_aggregates(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        "DELETE FROM entity_stats;
         DELETE FROM entity_edges;
         INSERT INTO entity_stats (entity, kind, turns, first_ts, last_ts)
            SELECT e.entity, MIN(e.kind), COUNT(DISTINCT e.turn_id), MIN(t.ts), MAX(t.ts)
            FROM turn_entities e JOIN turns t ON t.id = e.turn_id
            GROUP BY e.entity;
         INSERT INTO entity_edges (a, b, turns)
            SELECT x.entity, y.entity, COUNT(*) FROM
               (SELECT DISTINCT turn_id, entity FROM turn_entities) x
               JOIN (SELECT DISTINCT turn_id, entity FROM turn_entities) y
               ON x.turn_id = y.turn_id AND x.entity < y.entity
            GROUP BY x.entity, y.entity;",
    )?;
    Ok(())
}

/// Replace one session's segments from its turns in time order.
pub(crate) fn resegment(tx: &Transaction<'_>, session_id: &str) -> Result<()> {
    tx.execute("DELETE FROM segments WHERE session_id = ?1", [session_id])?;
    let turns: Vec<TurnRef> = {
        let mut stmt = tx.prepare_cached(
            "SELECT t.id, t.ts, GROUP_CONCAT(DISTINCT e.entity) FROM turns t
             LEFT JOIN turn_entities e ON e.turn_id = t.id
             WHERE t.session_id = ?1 GROUP BY t.id ORDER BY t.ts, t.id",
        )?;
        let rows = stmt.query_map([session_id], |r| {
            let joined: Option<String> = r.get(2)?;
            let mut entities: Vec<String> =
                joined.map(|s| s.split(',').map(str::to_string).collect()).unwrap_or_default();
            entities.sort();
            Ok(TurnRef { id: r.get(0)?, ts: r.get(1)?, entities })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut insert = tx.prepare_cached(
        "INSERT INTO segments (session_id, level, start_ts, end_ts, first_turn_id, last_turn_id, turns, entities)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    for s in timeline::segment(&turns) {
        insert.execute(params![
            session_id,
            s.level.as_str(),
            s.start_ts,
            s.end_ts,
            s.first_turn_id,
            s.last_turn_id,
            s.turns,
            serde_json::to_string(&s.entities)?
        ])?;
    }
    Ok(())
}

// --- row mappers -----------------------------------------------------------

pub(crate) fn row_to_turn(r: &rusqlite::Row<'_>) -> rusqlite::Result<Turn> {
    Ok(Turn {
        id: r.get(0)?,
        uuid: r.get(1)?,
        session_id: r.get(2)?,
        speaker: r.get(3)?,
        text: r.get(4)?,
        ts: r.get(5)?,
        kind: TurnKind::parse(&r.get::<_, String>(6)?),
    })
}

fn row_to_stat(r: &rusqlite::Row<'_>) -> rusqlite::Result<EntityStat> {
    Ok(EntityStat {
        entity: r.get(0)?,
        kind: r.get(1)?,
        turns: r.get::<_, i64>(2)? as u32,
        first_ts: r.get(3)?,
        last_ts: r.get(4)?,
    })
}

fn row_to_segment(r: &rusqlite::Row<'_>) -> rusqlite::Result<Segment> {
    Ok(Segment {
        level: Level::parse(&r.get::<_, String>(0)?).unwrap_or(Level::Window),
        start_ts: r.get(1)?,
        end_ts: r.get(2)?,
        first_turn_id: r.get(3)?,
        last_turn_id: r.get(4)?,
        turns: r.get::<_, i64>(5)? as u32,
        entities: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or_default(),
    })
}

pub(crate) fn validate(input: &TurnInput) -> Result<()> {
    if input.session_id.trim().is_empty() {
        return Err(Error::InvalidTurn("session_id is empty".into()));
    }
    if input.speaker.trim().is_empty() {
        return Err(Error::InvalidTurn("speaker is empty".into()));
    }
    if input.text.trim().is_empty() {
        return Err(Error::InvalidTurn("text is empty".into()));
    }
    Ok(())
}

/// Content-derived id for turns that arrive without one. Includes the
/// timestamp when present, so the same words said twice in one session on
/// different occasions are two turns, while a re-ingested transcript is one.
fn derived_uuid(input: &TurnInput) -> String {
    let mut h = Sha256::new();
    h.update(input.session_id.as_bytes());
    h.update([0]);
    h.update(input.speaker.as_bytes());
    h.update([0]);
    h.update(input.text.as_bytes());
    h.update([0]);
    if let Some(ts) = input.ts {
        h.update(ts.to_le_bytes());
    }
    let digest = h.finalize();
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// A short, order-sensitive digest of a vector rounded to 1e-4, so two
/// snapshots agree when the vectors do and float noise below that is
/// ignored.
pub fn vector_digest(v: &[f32]) -> String {
    let mut h = Sha256::new();
    for x in v {
        h.update(((x * 10_000.0).round() as i32).to_le_bytes());
    }
    let digest = h.finalize();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(session: &str, text: &str, ts: i64) -> TurnInput {
        TurnInput { session_id: session.into(), speaker: "user".into(), text: text.into(), ts: Some(ts), uuid: None }
    }

    fn open() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap().store;
        (dir, store)
    }

    fn insert(store: &mut Store, t: &TurnInput) -> IngestOutcome {
        store.insert_batch(std::slice::from_ref(t), &[], None).unwrap().outcomes.remove(0).unwrap()
    }

    #[test]
    fn opens_fresh_with_schema_and_generation() {
        let (_dir, store) = open();
        assert_eq!(store.meta_i64("schema_version").unwrap(), SCHEMA_VERSION);
        assert_eq!(store.generation().unwrap(), 0);
        assert_eq!(store.count_turns().unwrap(), 0);
    }

    #[test]
    fn insert_dedups_on_derived_uuid() {
        let (_dir, mut store) = open();
        let t = turn("s", "hello", 1);
        let first = insert(&mut store, &t);
        let second = insert(&mut store, &t);
        assert!(matches!(first, IngestOutcome::Indexed { id: 1 }));
        assert_eq!(second, IngestOutcome::Duplicate { id: 1 });
        assert_eq!(store.count_turns().unwrap(), 1);
    }

    #[test]
    fn explicit_uuid_wins_over_content() {
        let (_dir, mut store) = open();
        let mut a = turn("s", "one", 1);
        a.uuid = Some("fixed".into());
        let mut b = turn("s", "two", 2);
        b.uuid = Some("fixed".into());
        insert(&mut store, &a);
        assert_eq!(insert(&mut store, &b), IngestOutcome::Duplicate { id: 1 });
    }

    #[test]
    fn rejects_blank_fields() {
        let (_dir, mut store) = open();
        let outcomes = store.insert_batch(&[turn("s", "  ", 1), turn(" ", "x", 1)], &[], None).unwrap().outcomes;
        assert!(outcomes.iter().all(|o| matches!(o, Err(Error::InvalidTurn(_)))));
        assert_eq!(store.count_turns().unwrap(), 0);
    }

    #[test]
    fn derived_artifacts_are_written_with_the_turn() {
        let (_dir, mut store) = open();
        insert(&mut store, &turn("s", "Maya Okafor owns the billing service on Project Heron.", 1));
        insert(&mut store, &turn("s", "Maya Okafor is based in Lisbon.", 2));
        assert_eq!(store.count_entities().unwrap(), 3);
        assert_eq!(store.entity_stat("maya okafor").unwrap().unwrap().turns, 2);
        assert_eq!(
            store.neighbours("maya okafor", 5).unwrap(),
            vec![("lisbon".into(), 1), ("project heron".into(), 1)]
        );
        assert_eq!(store.turns_mentioning(&["lisbon".into()], 10, false).unwrap(), vec![(2, 1)]);
        let hits = store.lexical_search(&["billing".into()], 10, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, 1);
        assert_eq!(store.count_segments(Level::Window).unwrap(), 1);
        assert_eq!(store.count_segments(Level::Episode).unwrap(), 1);
    }

    #[test]
    fn delete_session_removes_everything_and_bumps_generation() {
        let (_dir, mut store) = open();
        insert(&mut store, &turn("a", "Maya Okafor in Lisbon", 1));
        insert(&mut store, &turn("b", "Maya Okafor in Osaka", 2));
        assert_eq!(store.delete_session("a").unwrap(), 1);
        assert_eq!(store.generation().unwrap(), 1);
        assert_eq!(store.count_turns().unwrap(), 1);
        assert_eq!(store.entity_stat("maya okafor").unwrap().unwrap().turns, 1);
        assert!(store.entity_stat("lisbon").unwrap().is_none());
        assert!(store.lexical_search(&["lisbon".into()], 10, false).unwrap().is_empty());
        assert_eq!(store.count_segments(Level::Window).unwrap(), 1);
        assert_eq!(store.delete_session("nope").unwrap(), 0);
        assert_eq!(store.generation().unwrap(), 1, "an empty delete invalidates nothing");
    }

    #[test]
    fn rebuild_reproduces_incremental_state() {
        let (_dir, mut store) = open();
        insert(&mut store, &turn("a", "Maya Okafor owns Heron. Kenji Morimoto owns Basalt.", 1));
        insert(&mut store, &turn("a", "Kenji Morimoto is in Osaka.", 2));
        insert(&mut store, &turn("b", "Heron launch is on March 14.", 3));
        let before = (
            store.all_mentions().unwrap(),
            store.all_entity_stats().unwrap(),
            store.all_edges().unwrap(),
            store.all_segments().unwrap(),
        );
        store.rebuild(false).unwrap();
        let after = (
            store.all_mentions().unwrap(),
            store.all_entity_stats().unwrap(),
            store.all_edges().unwrap(),
            store.all_segments().unwrap(),
        );
        assert_eq!(before, after);
        assert_eq!(store.generation().unwrap(), 1);
    }

    #[test]
    fn embeddings_round_trip_and_backlog() {
        let (_dir, mut store) = open();
        store.seed_embedder(&EmbedderSpec::Hash).unwrap();
        assert_eq!(store.generation().unwrap(), 0, "seeding invalidates nothing");
        assert_eq!(store.embedder_spec().unwrap(), Some(EmbedderSpec::Hash));
        let v = dense::hash_embed("hello");
        let inserted = store
            .insert_batch(&[turn("s", "hello", 1), turn("s", "world", 2)], &[Some(v.clone()), None], Some("hash-384"))
            .unwrap();
        assert_eq!(inserted.outcomes.len(), 2);
        assert!(!inserted.embedder_changed);
        assert_eq!(store.embeddings_after(0, "hash-384", 384).unwrap(), vec![(1, 1, v)]);
        assert_eq!(store.turns_without_embedding("hash-384", 10).unwrap(), vec![(2, "world".into())]);
        assert_eq!(store.count_backlog("hash-384").unwrap(), 1);
        store.write_embeddings(&[(2, dense::hash_embed("world"))], "hash-384", store.generation().unwrap()).unwrap();
        assert!(store.turns_without_embedding("hash-384", 10).unwrap().is_empty());
        assert_eq!(store.embeddings_after(1, "hash-384", 384).unwrap().len(), 1);
        assert!(store.embeddings_after(0, "other", 384).unwrap().is_empty());
        assert!(store.embeddings_after(0, "hash-384", 8).unwrap().is_empty(), "the wrong length is skipped");
    }

    #[test]
    fn clears_keep_meta_and_a_writer_from_before_a_clear_is_refused() {
        let (_dir, mut store) = open();
        store.seed_embedder(&EmbedderSpec::Hash).unwrap();
        store
            .insert_batch(
                &[turn("a", "Maya Okafor in Lisbon", 1), turn("b", "Kenji in Osaka", 2)],
                &[Some(dense::hash_embed("x")), None],
                Some("hash-384"),
            )
            .unwrap();
        let stale = store.generation().unwrap();
        assert_eq!(store.clear_embeddings().unwrap(), 1);
        assert_eq!(store.count_backlog("hash-384").unwrap(), 2);
        assert!(matches!(
            store.write_embeddings(&[(2, dense::hash_embed("Kenji in Osaka"))], "hash-384", stale),
            Err(Error::StoreChanged)
        ));
        assert_eq!(store.count_backlog("hash-384").unwrap(), 2, "the refused write left nothing");

        let report = store.clear_memory().unwrap();
        assert_eq!((report.turns_removed, report.sessions_removed, report.vectors_removed), (2, 2, 0));
        assert_eq!(store.generation().unwrap(), stale + 2);
        assert_eq!(store.count_turns().unwrap(), 0);
        assert!(store.entity_stat("maya okafor").unwrap().is_none());
        assert!(store.lexical_search(&["lisbon".into()], 10, false).unwrap().is_empty());
        assert_eq!(store.count_segments(Level::Window).unwrap(), 0);
        assert_eq!(store.embedder_spec().unwrap(), Some(EmbedderSpec::Hash), "meta stays");
    }

    #[test]
    fn a_stale_writer_cannot_overwrite_after_a_switch() {
        let (_dir, mut store) = open();
        store.seed_embedder(&EmbedderSpec::Hash).unwrap();
        insert(&mut store, &turn("s", "hello", 1));
        let other = EmbedderSpec::Remote(dense::RemoteSpec {
            url: "http://x/v1".into(),
            model: "m".into(),
            dim: Some(8),
            ..Default::default()
        });
        store.switch_embedder(&other).unwrap();
        assert_eq!(store.generation().unwrap(), 1);
        assert_eq!(store.meta("embedder").unwrap().as_deref(), Some("openai:m@8"));
        assert_eq!(store.embedder_spec().unwrap(), Some(other.clone()));
        let err = store
            .write_embeddings(&[(1, dense::hash_embed("hello"))], "hash-384", store.generation().unwrap())
            .unwrap_err();
        assert!(matches!(err, Error::EmbedderChanged(_)), "{err}");
        assert_eq!(store.count_embeddings().unwrap(), 0);
        let inserted = store
            .insert_batch(&[turn("s", "again", 2)], &[Some(dense::hash_embed("again"))], Some("hash-384"))
            .unwrap();
        assert!(inserted.embedder_changed);
        assert_eq!(store.count_turns().unwrap(), 2);
        assert_eq!(store.count_embeddings().unwrap(), 0, "the turn landed without its stale vector");
        store
            .write_embeddings(&[(1, vec![1.0; 8]), (2, vec![0.5; 8])], "openai:m@8", store.generation().unwrap())
            .unwrap();
        assert_eq!(store.count_backlog("openai:m@8").unwrap(), 0);
        let err = store.update_embedder_spec(&EmbedderSpec::Hash).unwrap_err();
        assert!(matches!(err, Error::EmbedderChanged(_)));
    }

    #[test]
    fn backfilled_vectors_come_after_newer_ones_in_sequence() {
        let (_dir, mut store) = open();
        store.seed_embedder(&EmbedderSpec::Hash).unwrap();
        insert(&mut store, &turn("s", "one", 1));
        insert(&mut store, &turn("s", "two", 2));
        store.write_embeddings(&[(2, dense::hash_embed("two"))], "hash-384", store.generation().unwrap()).unwrap();
        let rows = store.embeddings_after(0, "hash-384", 384).unwrap();
        assert_eq!(rows.len(), 1);
        let seen = rows[0].0;
        store.write_embeddings(&[(1, dense::hash_embed("one"))], "hash-384", store.generation().unwrap()).unwrap();
        let later = store.embeddings_after(seen, "hash-384", 384).unwrap();
        assert_eq!(later.len(), 1);
        assert_eq!(later[0].1, 1, "the older turn's vector is visible past the cursor");
    }

    #[test]
    fn a_v2_embeddings_table_is_upgraded_with_its_vectors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DB_FILE);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO meta VALUES ('schema_version', '2'), ('generation', '4'), ('embedder', 'hash-384');
                 CREATE TABLE turns (
                    id INTEGER PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
                    speaker TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL, created_at INTEGER NOT NULL);
                 INSERT INTO turns VALUES (1, 'u1', 's', 'user', 'one', 1, 1), (2, 'u2', 's', 'user', 'two', 2, 2);
                 CREATE TABLE embeddings (
                    turn_id INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
                    model TEXT NOT NULL, vec BLOB NOT NULL);",
            )
            .unwrap();
            for id in [2, 1] {
                conn.execute(
                    "INSERT INTO embeddings (turn_id, model, vec) VALUES (?1, 'hash-384', ?2)",
                    params![id, dense::to_blob(&dense::hash_embed(&format!("t{id}")))],
                )
                .unwrap();
            }
        }
        let Opened { store, needs_rebuild } = Store::open(dir.path()).unwrap();
        assert!(needs_rebuild, "v5 changed extraction, so every older store re-derives its entities");
        assert_eq!(store.meta_i64("schema_version").unwrap(), SCHEMA_VERSION);
        assert!(store.all_turns().unwrap().iter().all(|t| t.kind == TurnKind::Turn), "old turns are ordinary turns");
        assert_eq!(store.generation().unwrap(), 4);
        assert_eq!(store.embedder_spec().unwrap(), Some(EmbedderSpec::Hash), "read through the legacy name");
        let rows = store.embeddings_after(0, "hash-384", 384).unwrap();
        assert_eq!(rows.iter().map(|r| r.1).collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(rows[0].2, dense::hash_embed("t1"));
        assert_eq!(store.count_backlog("hash-384").unwrap(), 0);
    }
}
