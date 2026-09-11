//! Curation: reversible edits to how the store is recalled, made by an
//! external agent on a schedule or by a person in the admin UI.
//!
//! Turns are never rewritten and never deleted here. A curator hides a
//! turn, marks it superseded by a newer one, aliases one entity key to
//! another, blocks a key, or writes a note that stands for a run of turns.
//! Every change is a row in `curation_actions` with the actor, the run it
//! belongs to and a reason, and every change can be undone.
//!
//! The log is the source of truth. `turn_flags`, `entity_aliases`,
//! `entity_blocklist` and the run cursor are folds over the actions that
//! are not undone, recomputed for exactly the keys an apply or undo
//! touched, so undoing in any order lands where never having applied would
//! have. Payloads name turns by uuid: row ids are reused after a delete.
//!
//! Hides and supersessions only advance `meta.curation_seq`; recall reads
//! the flags from SQLite on each query, so another process's curation is
//! visible at once and no vector index is dropped. An alias or block
//! re-derives the entity tables from the text (`store::rederive_entities`)
//! without touching FTS or vectors. Undoing a note deletes the note turn,
//! which bumps `generation` like any other delete.

pub mod finders;

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::entities::{self, Mention};
use crate::error::{Error, Result};
use crate::store::{self, EntityMap, Store};
use crate::types::{AliasRow, FlagRow, IngestOutcome, NoteSourceRow, Turn, TurnInput, TurnKind};

/// The speaker of every note a curator writes.
pub const CURATOR_SPEAKER: &str = "zeromem-curator";
/// Longest note a curator may write, in characters.
pub const NOTE_MAX_CHARS: usize = 4000;
const DAY_MS: i64 = 24 * 3600 * 1000;

// --- settings ------------------------------------------------------------------

/// How the curator surface is exposed and limited. Stored in
/// `meta.curator_config` so the admin UI can change it; the engine enforces
/// the limits, the server reads the token and the exposure.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct CuratorConfig {
    /// Most actions one apply call may carry.
    pub max_per_call: u32,
    /// Most actions one run may apply in total.
    pub max_per_run: u32,
    /// Turns younger than this are never touched, so a live conversation
    /// is not curated under the user.
    pub min_age_ms: i64,
    /// Bearer token that grants the curator scope over MCP. `None` means no
    /// token grants it (unless `expose_to_all`).
    pub token: Option<String>,
    /// Give every MCP client the curator tools, not only the curator token.
    pub expose_to_all: bool,
}

impl Default for CuratorConfig {
    fn default() -> Self {
        CuratorConfig { max_per_call: 100, max_per_run: 300, min_age_ms: DAY_MS, token: None, expose_to_all: false }
    }
}

impl CuratorConfig {
    pub const MAX_PER_CALL_CAP: u32 = 1000;
    pub const MAX_PER_RUN_CAP: u32 = 100_000;

    fn validate(&self) -> Result<()> {
        if self.max_per_call == 0 || self.max_per_call > Self::MAX_PER_CALL_CAP {
            return Err(Error::Curation(format!("max_per_call must be 1..={}", Self::MAX_PER_CALL_CAP)));
        }
        if self.max_per_run == 0 || self.max_per_run > Self::MAX_PER_RUN_CAP {
            return Err(Error::Curation(format!("max_per_run must be 1..={}", Self::MAX_PER_RUN_CAP)));
        }
        if self.min_age_ms < 0 {
            return Err(Error::Curation("min_age_ms must not be negative".into()));
        }
        if self.token.as_deref().is_some_and(|t| t.trim().len() < 16) {
            return Err(Error::Curation("the curator token must be at least 16 characters".into()));
        }
        Ok(())
    }
}

// --- actions -------------------------------------------------------------------

/// One reversible edit. Turns are named by row id on the way in and stored
/// by uuid.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum CurationOp {
    Hide {
        turn_ids: Vec<i64>,
    },
    Unhide {
        turn_ids: Vec<i64>,
    },
    /// `turn_ids` state something `by` restates with a newer value.
    Supersede {
        turn_ids: Vec<i64>,
        by: i64,
    },
    Alias {
        alias: String,
        canonical: String,
    },
    Unalias {
        alias: String,
    },
    Block {
        entity: String,
    },
    Unblock {
        entity: String,
    },
    /// A turn of kind `note` in `session_id` that stands for `source_ids`.
    Note {
        session_id: String,
        text: String,
        source_ids: Vec<i64>,
    },
    /// Close a run: record its summary and advance the cursor finders read
    /// from. `cursor` defaults to the newest turn old enough to curate.
    RunEnd {
        #[serde(default)]
        summary: String,
        #[serde(default)]
        cursor: Option<i64>,
    },
}

impl CurationOp {
    pub fn name(&self) -> &'static str {
        match self {
            CurationOp::Hide { .. } => "hide",
            CurationOp::Unhide { .. } => "unhide",
            CurationOp::Supersede { .. } => "supersede",
            CurationOp::Alias { .. } => "alias",
            CurationOp::Unalias { .. } => "unalias",
            CurationOp::Block { .. } => "block",
            CurationOp::Unblock { .. } => "unblock",
            CurationOp::Note { .. } => "note",
            CurationOp::RunEnd { .. } => "run_end",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CurationAction {
    #[serde(flatten)]
    pub op: CurationOp,
    /// Why; required for everything but `run_end`.
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActionResult {
    pub index: u32,
    pub op: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApplyReport {
    pub run_id: String,
    pub dry_run: bool,
    pub results: Vec<ActionResult>,
    pub applied: u32,
    pub rejected: u32,
}

/// What to undo: one action or a whole run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UndoTarget {
    Action(i64),
    Run(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UndoReport {
    /// Action ids undone, in the order they were undone.
    pub undone: Vec<i64>,
}

// --- reads ---------------------------------------------------------------------

/// A turn with everything curation says about it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CuratedTurn {
    #[serde(flatten)]
    pub turn: Turn,
    pub entities: Vec<Mention>,
    #[serde(flatten)]
    pub curation: TurnCuration,
}

/// Curation facts about one turn, each left out when empty.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TurnCuration {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<i64>,
    /// Turns this one supersedes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supersedes: Vec<i64>,
    /// Notes that stand for this turn.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub covered_by: Vec<i64>,
    /// For a note, the turns it stands for.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<i64>,
}

impl TurnCuration {
    pub fn is_empty(&self) -> bool {
        *self == TurnCuration::default()
    }
}

/// Which turns `curation_turns` reads.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct TurnSelector {
    #[serde(default)]
    pub turn_ids: Option<Vec<i64>>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub entity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunSummary {
    pub run_id: String,
    pub actor: String,
    pub started_at: i64,
    pub ended_at: i64,
    /// Actions in the run, `run_end` included.
    pub actions: u32,
    pub undone: u32,
    /// Live (not undone) actions per op.
    pub ops: BTreeMap<String, u32>,
    pub summary: Option<String>,
    /// Whether a live `run_end` closed it.
    pub finished: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CurationRuns {
    pub runs: Vec<RunSummary>,
    pub total: u64,
    /// Where the next run's finders start.
    pub cursor: i64,
    pub curation_seq: i64,
}

/// A turn an action names, for display. `id` is `None` once the turn is gone.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TargetTurn {
    pub uuid: String,
    pub id: Option<i64>,
    pub session_id: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActionRow {
    pub id: i64,
    pub run_id: String,
    pub actor: String,
    pub ts: i64,
    pub op: String,
    pub payload: serde_json::Value,
    pub reason: String,
    pub undone_at: Option<i64>,
    pub undone_by: Option<String>,
    /// The turns the action names (hidden, superseded, the superseding
    /// turn, a note and its sources), first ones first.
    pub targets: Vec<TargetTurn>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CurationActions {
    pub actions: Vec<ActionRow>,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AliasEntry {
    pub alias: String,
    pub canonical: String,
    pub action_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BlockEntry {
    pub entity: String,
    pub action_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CurationAliases {
    pub aliases: Vec<AliasEntry>,
    pub blocklist: Vec<BlockEntry>,
}

/// Flags recall applies, keyed by turn id.
#[derive(Debug, Clone, Default)]
pub struct Flags {
    pub hidden: BTreeSet<i64>,
    pub superseded_by: BTreeMap<i64, i64>,
    /// Source turn → the notes that stand for it.
    pub covered_by: BTreeMap<i64, Vec<i64>>,
    /// Note → the turns it stands for.
    pub sources: BTreeMap<i64, Vec<i64>>,
}

// --- store: meta -----------------------------------------------------------------

pub(crate) fn bump_curation_seq(tx: &Transaction<'_>) -> Result<i64> {
    let next = meta_i64_tx(tx, "curation_seq")? + 1;
    set_meta_tx(tx, "curation_seq", &next.to_string())?;
    Ok(next)
}

fn meta_i64_tx(tx: &Transaction<'_>, key: &str) -> Result<i64> {
    Ok(tx
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get::<_, String>(0))
        .optional()?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0))
}

fn set_meta_tx(tx: &Transaction<'_>, key: &str, value: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Normalise an entity key the way extraction does, so `Maya's` and
/// `maya` name one key.
pub fn entity_key(s: &str) -> String {
    entities::name_key(s.trim())
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// A note's uuid comes from its sources alone, so the same consolidation
/// cannot be written twice.
fn note_uuid(source_uuids: &[String]) -> String {
    let mut sorted = source_uuids.to_vec();
    sorted.sort();
    let mut h = Sha256::new();
    h.update(b"zeromem-note\0");
    for u in &sorted {
        h.update(u.as_bytes());
        h.update([0]);
    }
    let hex: String = h.finalize().iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

struct TurnBrief {
    id: i64,
    uuid: String,
    ts: i64,
    kind: TurnKind,
}

fn brief(tx: &Transaction<'_>, id: i64) -> Result<Option<TurnBrief>> {
    Ok(tx
        .query_row("SELECT id, uuid, ts, kind FROM turns WHERE id = ?1", [id], |r| {
            Ok(TurnBrief {
                id: r.get(0)?,
                uuid: r.get(1)?,
                ts: r.get(2)?,
                kind: TurnKind::parse(&r.get::<_, String>(3)?),
            })
        })
        .optional()?)
}

fn id_of(tx: &Transaction<'_>, uuid: &str) -> Result<Option<i64>> {
    Ok(tx.query_row("SELECT id FROM turns WHERE uuid = ?1", [uuid], |r| r.get(0)).optional()?)
}

// --- store: apply and undo -------------------------------------------------------

/// Validated, ready to write.
enum Plan {
    Turns { op: &'static str, payload: serde_json::Value, uuids: Vec<String> },
    Entity { op: &'static str, payload: serde_json::Value },
    Note { input: TurnInput, sources: Vec<i64>, payload: serde_json::Value },
    RunEnd { payload: serde_json::Value },
}

impl Store {
    pub fn curator_config(&self) -> Result<CuratorConfig> {
        Ok(match self.meta("curator_config")? {
            Some(json) => serde_json::from_str(&json)?,
            None => CuratorConfig::default(),
        })
    }

    pub fn set_curator_config(&mut self, config: &CuratorConfig) -> Result<()> {
        config.validate()?;
        let mut config = config.clone();
        config.token = config.token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        self.set_meta("curator_config", &serde_json::to_string(&config)?)
    }

    pub fn curation_seq(&self) -> Result<i64> {
        self.meta_i64("curation_seq")
    }

    pub fn curation_cursor(&self) -> Result<i64> {
        self.meta_i64("curation_cursor")
    }

    /// Apply `actions` as part of `run_id`. Each is validated against the
    /// store as the earlier ones left it and accepted or refused on its
    /// own; all of them commit together, or none with `dry_run`.
    pub fn curate_apply(
        &mut self,
        run_id: &str,
        actor: &str,
        actions: &[CurationAction],
        dry_run: bool,
        now: i64,
    ) -> Result<ApplyReport> {
        let config = self.curator_config()?;
        if run_id.trim().is_empty() {
            return Err(Error::Curation("run_id is empty".into()));
        }
        if actions.len() > config.max_per_call as usize {
            return Err(Error::Curation(format!(
                "{} actions in one call; the limit is {}",
                actions.len(),
                config.max_per_call
            )));
        }
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut in_run: u32 = tx.query_row(
            "SELECT COUNT(*) FROM curation_actions WHERE run_id = ?1 AND op != 'run_end'",
            [run_id],
            |r| r.get(0),
        )?;
        let cutoff = now - config.min_age_ms;
        let mut results = Vec::with_capacity(actions.len());
        let mut entities_changed = false;
        let mut touched_sessions = BTreeSet::new();
        let (mut applied, mut rejected) = (0u32, 0u32);
        for (index, action) in actions.iter().enumerate() {
            let op = action.op.name().to_string();
            let counted = !matches!(action.op, CurationOp::RunEnd { .. });
            let planned = if counted && in_run >= config.max_per_run {
                Err(format!("run {run_id} has reached its limit of {} actions", config.max_per_run))
            } else {
                plan(&tx, action, cutoff)
            };
            let plan = match planned {
                Ok(p) => p,
                Err(error) => {
                    rejected += 1;
                    results.push(ActionResult {
                        index: index as u32,
                        op,
                        ok: false,
                        action_id: None,
                        note_id: None,
                        error: Some(error),
                    });
                    continue;
                }
            };
            let mut note_id = None;
            let action_id = match plan {
                Plan::Turns { op, payload, uuids } => {
                    let id = record(&tx, run_id, actor, now, op, &payload, &action.reason)?;
                    recompute_flags(&tx, &uuids)?;
                    id
                }
                Plan::Entity { op, payload } => {
                    let id = record(&tx, run_id, actor, now, op, &payload, &action.reason)?;
                    recompute_entity_rule(&tx, op, &payload)?;
                    entities_changed = true;
                    id
                }
                Plan::Note { input, sources, mut payload } => {
                    let map = EntityMap::load(&tx)?;
                    let outcome = store::insert_one(&tx, &input, None, None, TurnKind::Note, &map)?;
                    let IngestOutcome::Indexed { id } = outcome else {
                        return Err(Error::Curation("note collided with an existing turn".into()));
                    };
                    for source in &sources {
                        tx.execute("INSERT INTO note_sources (note_id, turn_id) VALUES (?1, ?2)", params![id, source])?;
                    }
                    payload["note"] = serde_json::Value::String(input.uuid.clone().unwrap_or_default());
                    touched_sessions.insert(input.session_id.clone());
                    note_id = Some(id);
                    record(&tx, run_id, actor, now, "note", &payload, &action.reason)?
                }
                Plan::RunEnd { payload } => {
                    let id = record(&tx, run_id, actor, now, "run_end", &payload, &action.reason)?;
                    recompute_cursor(&tx)?;
                    id
                }
            };
            if counted {
                in_run += 1;
            }
            applied += 1;
            results.push(ActionResult {
                index: index as u32,
                op,
                ok: true,
                action_id: Some(action_id),
                note_id,
                error: None,
            });
        }
        if dry_run {
            // Dropping the transaction rolls every write back.
            return Ok(ApplyReport { run_id: run_id.to_string(), dry_run, results, applied, rejected });
        }
        if entities_changed {
            store::rederive_entities(&tx)?;
        } else {
            for session in &touched_sessions {
                store::resegment(&tx, session)?;
            }
        }
        if applied > 0 {
            bump_curation_seq(&tx)?;
        }
        tx.commit()?;
        Ok(ApplyReport { run_id: run_id.to_string(), dry_run, results, applied, rejected })
    }

    /// Undo one action, or every live action of a run newest first.
    pub fn curate_undo(&mut self, target: &UndoTarget, actor: &str, now: i64) -> Result<UndoReport> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let ids: Vec<i64> = match target {
            UndoTarget::Action(id) => {
                let undone: Option<Option<i64>> = tx
                    .query_row("SELECT undone_at FROM curation_actions WHERE id = ?1", [id], |r| r.get(0))
                    .optional()?;
                match undone {
                    None => return Err(Error::Curation(format!("no curation action {id}"))),
                    Some(Some(_)) => return Err(Error::Curation(format!("action {id} is already undone"))),
                    Some(None) => vec![*id],
                }
            }
            UndoTarget::Run(run_id) => {
                let mut stmt = tx.prepare(
                    "SELECT id FROM curation_actions WHERE run_id = ?1 AND undone_at IS NULL ORDER BY id DESC",
                )?;
                let ids = stmt.query_map([run_id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<i64>>>()?;
                drop(stmt);
                if ids.is_empty() {
                    let exists: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM curation_actions WHERE run_id = ?1)",
                        [run_id],
                        |r| r.get(0),
                    )?;
                    if !exists {
                        return Err(Error::Curation(format!("no curation run {run_id}")));
                    }
                }
                ids
            }
        };
        let mut entities_changed = false;
        let mut deleted_notes = false;
        let mut sessions = BTreeSet::new();
        for id in &ids {
            let (op, payload): (String, String) =
                tx.query_row("SELECT op, payload FROM curation_actions WHERE id = ?1", [id], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?;
            let payload: serde_json::Value = serde_json::from_str(&payload)?;
            tx.execute(
                "UPDATE curation_actions SET undone_at = ?2, undone_by = ?3 WHERE id = ?1",
                params![id, now, actor],
            )?;
            match op.as_str() {
                "hide" | "unhide" | "supersede" => recompute_flags(&tx, &payload_uuids(&payload))?,
                "alias" | "unalias" | "block" | "unblock" => {
                    recompute_entity_rule(&tx, &op, &payload)?;
                    entities_changed = true;
                }
                "note" => {
                    if let Some(uuid) = payload["note"].as_str() {
                        let session: Option<String> = tx
                            .query_row("SELECT session_id FROM turns WHERE uuid = ?1", [uuid], |r| r.get(0))
                            .optional()?;
                        if let Some(session) = session {
                            tx.execute("DELETE FROM turns WHERE uuid = ?1", [uuid])?;
                            sessions.insert(session);
                            deleted_notes = true;
                        }
                    }
                }
                "run_end" => recompute_cursor(&tx)?,
                other => return Err(Error::Curation(format!("unknown op {other} in the log"))),
            }
        }
        if entities_changed {
            store::rederive_entities(&tx)?;
        } else if deleted_notes {
            store::rebuild_aggregates(&tx)?;
            for session in &sessions {
                store::resegment(&tx, session)?;
            }
        }
        if deleted_notes {
            // A deleted turn's id can be reused; readers must reload.
            Store::bump_generation(&tx)?;
        }
        if !ids.is_empty() {
            bump_curation_seq(&tx)?;
        }
        tx.commit()?;
        Ok(UndoReport { undone: ids })
    }

    // --- reads ---

    /// Every flag, for recall.
    pub fn curation_flags(&self) -> Result<Flags> {
        let mut stmt = self.conn.prepare_cached("SELECT turn_id, hidden, superseded_by FROM turn_flags")?;
        let mut flags = Flags::default();
        let rows =
            stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, bool>(1)?, r.get::<_, Option<i64>>(2)?)))?;
        for row in rows {
            let (id, hidden, by) = row?;
            if hidden {
                flags.hidden.insert(id);
            }
            if let Some(by) = by {
                flags.superseded_by.insert(id, by);
            }
        }
        let mut stmt =
            self.conn.prepare_cached("SELECT note_id, turn_id FROM note_sources ORDER BY note_id, turn_id")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (note, source) = row?;
            flags.covered_by.entry(source).or_default().push(note);
            flags.sources.entry(note).or_default().push(source);
        }
        Ok(flags)
    }

    /// What curation says about one turn.
    pub fn turn_curation(&self, id: i64) -> Result<TurnCuration> {
        let flag: Option<(bool, Option<i64>)> = self
            .conn
            .prepare_cached("SELECT hidden, superseded_by FROM turn_flags WHERE turn_id = ?1")?
            .query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        let (hidden, superseded_by) = flag.unwrap_or((false, None));
        let ids = |sql: &str| -> Result<Vec<i64>> {
            let mut stmt = self.conn.prepare_cached(sql)?;
            let rows = stmt.query_map([id], |r| r.get(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<i64>>>()?)
        };
        Ok(TurnCuration {
            hidden,
            superseded_by,
            supersedes: ids("SELECT turn_id FROM turn_flags WHERE superseded_by = ?1 ORDER BY turn_id")?,
            covered_by: ids("SELECT note_id FROM note_sources WHERE turn_id = ?1 ORDER BY note_id")?,
            sources: ids("SELECT turn_id FROM note_sources WHERE note_id = ?1 ORDER BY turn_id")?,
        })
    }

    pub fn curation_turns(&self, selector: &TurnSelector, limit: u32) -> Result<Vec<CuratedTurn>> {
        let limit = limit.clamp(1, 500) as i64;
        let ids: Vec<i64> = if let Some(ids) = &selector.turn_ids {
            ids.iter().copied().take(limit as usize).collect()
        } else if let Some(session) = &selector.session_id {
            let mut stmt = self.conn.prepare("SELECT id FROM turns WHERE session_id = ?1 ORDER BY ts, id LIMIT ?2")?;
            let rows = stmt.query_map(params![session, limit], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        } else if let Some(entity) = &selector.entity {
            let key = EntityMap::load(&self.conn)?.canonical(&entity_key(entity)).to_string();
            let mut stmt = self.conn.prepare(
                "SELECT DISTINCT e.turn_id FROM turn_entities e JOIN turns t ON t.id = e.turn_id
                 WHERE e.entity = ?1 ORDER BY t.ts, t.id LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![key, limit], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            return Err(Error::Curation("pass turn_ids, session_id or entity".into()));
        };
        let turns = self.turns_by_ids(&ids)?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(turn) = turns.get(&id) {
                out.push(CuratedTurn {
                    turn: turn.clone(),
                    entities: self.mentions(id)?,
                    curation: self.turn_curation(id)?,
                });
            }
        }
        Ok(out)
    }

    pub fn curation_runs(&self, limit: u32, offset: u32) -> Result<CurationRuns> {
        let mut stmt = self.conn.prepare(
            "SELECT run_id, MIN(actor), MIN(ts), MAX(ts), COUNT(*), SUM(undone_at IS NOT NULL) FROM curation_actions
             GROUP BY run_id ORDER BY MAX(id) DESC LIMIT ?1 OFFSET ?2",
        )?;
        let rows = stmt.query_map(params![limit, offset], |r| {
            Ok(RunSummary {
                run_id: r.get(0)?,
                actor: r.get(1)?,
                started_at: r.get(2)?,
                ended_at: r.get(3)?,
                actions: r.get(4)?,
                undone: r.get(5)?,
                ops: BTreeMap::new(),
                summary: None,
                finished: false,
            })
        })?;
        let mut runs = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut ops = self.conn.prepare_cached(
            "SELECT op, COUNT(*) FROM curation_actions WHERE run_id = ?1 AND undone_at IS NULL GROUP BY op",
        )?;
        let mut end = self.conn.prepare_cached(
            "SELECT json_extract(payload, '$.summary') FROM curation_actions
             WHERE run_id = ?1 AND op = 'run_end' AND undone_at IS NULL ORDER BY id DESC LIMIT 1",
        )?;
        for run in &mut runs {
            let counts = ops.query_map([&run.run_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u32>(1)?)))?;
            run.ops = counts.collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
            let summary: Option<Option<String>> = end.query_row([&run.run_id], |r| r.get(0)).optional()?;
            run.finished = summary.is_some();
            run.summary = summary.flatten().filter(|s| !s.is_empty());
        }
        let total: i64 =
            self.conn.query_row("SELECT COUNT(DISTINCT run_id) FROM curation_actions", [], |r| r.get(0))?;
        Ok(CurationRuns {
            runs,
            total: total as u64,
            cursor: self.curation_cursor()?,
            curation_seq: self.curation_seq()?,
        })
    }

    pub fn curation_actions(&self, run_id: Option<&str>, limit: u32, offset: u32) -> Result<CurationActions> {
        let mut stmt = self.conn.prepare(
            "SELECT id, run_id, actor, ts, op, payload, reason, undone_at, undone_by FROM curation_actions
             WHERE ?1 IS NULL OR run_id = ?1 ORDER BY id DESC LIMIT ?2 OFFSET ?3",
        )?;
        let rows = stmt.query_map(params![run_id, limit, offset], |r| {
            Ok(ActionRow {
                id: r.get(0)?,
                run_id: r.get(1)?,
                actor: r.get(2)?,
                ts: r.get(3)?,
                op: r.get(4)?,
                payload: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or(serde_json::Value::Null),
                reason: r.get(6)?,
                undone_at: r.get(7)?,
                undone_by: r.get(8)?,
                targets: Vec::new(),
            })
        })?;
        let mut actions = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut turn = self.conn.prepare_cached("SELECT id, session_id, text FROM turns WHERE uuid = ?1")?;
        for a in &mut actions {
            let mut uuids = Vec::new();
            if let Some(n) = a.payload["note"].as_str() {
                uuids.push(n.to_string());
            }
            uuids.extend(payload_uuids(&a.payload));
            for key in ["by"] {
                if let Some(u) = a.payload[key].as_str() {
                    uuids.push(u.to_string());
                }
            }
            if let Some(sources) = a.payload["sources"].as_array() {
                uuids.extend(sources.iter().filter_map(|v| v.as_str().map(str::to_string)));
            }
            for uuid in uuids {
                let found: Option<(i64, String, String)> =
                    turn.query_row([&uuid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
                a.targets.push(match found {
                    Some((id, session_id, text)) => {
                        TargetTurn { uuid, id: Some(id), session_id: Some(session_id), text: Some(clip(&text, 240)) }
                    }
                    None => TargetTurn { uuid, id: None, session_id: None, text: None },
                });
            }
        }
        let total: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM curation_actions WHERE ?1 IS NULL OR run_id = ?1",
            params![run_id],
            |r| r.get(0),
        )?;
        Ok(CurationActions { actions, total: total as u64 })
    }

    pub fn curation_aliases(&self) -> Result<CurationAliases> {
        let mut stmt =
            self.conn.prepare("SELECT alias, canonical, action_id FROM entity_aliases ORDER BY canonical, alias")?;
        let aliases = stmt
            .query_map([], |r| Ok(AliasEntry { alias: r.get(0)?, canonical: r.get(1)?, action_id: r.get(2)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut stmt = self.conn.prepare("SELECT entity, action_id FROM entity_blocklist ORDER BY entity")?;
        let blocklist = stmt
            .query_map([], |r| Ok(BlockEntry { entity: r.get(0)?, action_id: r.get(1)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(CurationAliases { aliases, blocklist })
    }

    pub fn count_hidden(&self) -> Result<u64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM turn_flags WHERE hidden = 1", [], |r| r.get::<_, i64>(0))? as u64)
    }

    pub fn count_notes(&self) -> Result<u64> {
        Ok(self.conn.query_row("SELECT COUNT(*) FROM turns WHERE kind = 'note'", [], |r| r.get::<_, i64>(0))? as u64)
    }

    // --- snapshot ---

    pub fn all_flags(&self) -> Result<Vec<FlagRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.uuid, f.hidden, b.uuid FROM turn_flags f
             JOIN turns t ON t.id = f.turn_id LEFT JOIN turns b ON b.id = f.superseded_by
             WHERE f.hidden = 1 OR f.superseded_by IS NOT NULL ORDER BY t.uuid",
        )?;
        let rows =
            stmt.query_map([], |r| Ok(FlagRow { uuid: r.get(0)?, hidden: r.get(1)?, superseded_by: r.get(2)? }))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn all_aliases(&self) -> Result<Vec<AliasRow>> {
        let mut stmt = self.conn.prepare("SELECT alias, canonical FROM entity_aliases ORDER BY alias")?;
        let rows = stmt.query_map([], |r| Ok(AliasRow { alias: r.get(0)?, canonical: r.get(1)? }))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn all_blocklist(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT entity FROM entity_blocklist ORDER BY entity")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn all_note_sources(&self) -> Result<Vec<NoteSourceRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT n.uuid, s.uuid FROM note_sources x
             JOIN turns n ON n.id = x.note_id JOIN turns s ON s.id = x.turn_id ORDER BY n.uuid, s.uuid",
        )?;
        let rows = stmt.query_map([], |r| Ok(NoteSourceRow { note: r.get(0)?, source: r.get(1)? }))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

/// Validate one action against the store as it stands inside `tx`.
/// Refusals are strings: they go back to the caller per action.
fn plan(tx: &Transaction<'_>, action: &CurationAction, cutoff: i64) -> std::result::Result<Plan, String> {
    let sql = |e: Error| e.to_string();
    if !matches!(action.op, CurationOp::RunEnd { .. }) && action.reason.trim().is_empty() {
        return Err("a reason is required".into());
    }
    let old_enough = |t: &TurnBrief| -> std::result::Result<(), String> {
        if t.ts > cutoff {
            Err(format!("turn {} is too recent to curate", t.id))
        } else {
            Ok(())
        }
    };
    let load = |ids: &[i64]| -> std::result::Result<Vec<TurnBrief>, String> {
        if ids.is_empty() {
            return Err("no turn ids".into());
        }
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for id in ids {
            if !seen.insert(*id) {
                continue;
            }
            let t = brief(tx, *id).map_err(sql)?.ok_or_else(|| format!("no turn {id}"))?;
            out.push(t);
        }
        Ok(out)
    };
    let flag = |id: i64| -> std::result::Result<(bool, Option<i64>), String> {
        Ok(tx
            .query_row("SELECT hidden, superseded_by FROM turn_flags WHERE turn_id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or((false, None)))
    };
    match &action.op {
        CurationOp::Hide { turn_ids } | CurationOp::Unhide { turn_ids } => {
            let hide = matches!(action.op, CurationOp::Hide { .. });
            let turns = load(turn_ids)?;
            let mut uuids = Vec::new();
            for t in &turns {
                old_enough(t)?;
                if flag(t.id)?.0 != hide {
                    uuids.push(t.uuid.clone());
                }
            }
            if uuids.is_empty() {
                return Err(if hide { "every turn is already hidden" } else { "no turn is hidden" }.into());
            }
            let op = if hide { "hide" } else { "unhide" };
            Ok(Plan::Turns { op, payload: serde_json::json!({ "turns": uuids }), uuids })
        }
        CurationOp::Supersede { turn_ids, by } => {
            let turns = load(turn_ids)?;
            let by = brief(tx, *by).map_err(sql)?.ok_or_else(|| format!("no turn {by}"))?;
            let mut uuids = Vec::new();
            for t in &turns {
                old_enough(t)?;
                if t.id == by.id {
                    return Err(format!("turn {} cannot supersede itself", t.id));
                }
                if t.ts > by.ts {
                    return Err(format!("turn {} is newer than turn {} that would supersede it", t.id, by.id));
                }
                if flag(t.id)?.1 != Some(by.id) {
                    uuids.push(t.uuid.clone());
                }
            }
            if uuids.is_empty() {
                return Err(format!("every turn is already superseded by {}", by.id));
            }
            if flag(by.id)?.1.is_some_and(|b| turns.iter().any(|t| t.id == b)) {
                return Err(format!("turn {} is itself superseded by one of these turns", by.id));
            }
            Ok(Plan::Turns { op: "supersede", payload: serde_json::json!({ "turns": uuids, "by": by.uuid }), uuids })
        }
        CurationOp::Alias { alias, canonical } => {
            let (alias, canonical) = (entity_key(alias), entity_key(canonical));
            if alias.is_empty() || canonical.is_empty() {
                return Err("alias and canonical must not be empty".into());
            }
            if alias == canonical {
                return Err("an entity cannot alias itself".into());
            }
            let current = |key: &str| -> std::result::Result<Option<String>, String> {
                tx.query_row("SELECT canonical FROM entity_aliases WHERE alias = ?1", [key], |r| r.get(0))
                    .optional()
                    .map_err(|e| e.to_string())
            };
            if let Some(c) = current(&alias)? {
                return Err(format!("{alias} is already an alias of {c}; unalias it first"));
            }
            if let Some(c) = current(&canonical)? {
                return Err(format!("{canonical} is itself an alias of {c}; alias to {c} instead"));
            }
            let targets: bool = tx
                .query_row("SELECT EXISTS(SELECT 1 FROM entity_aliases WHERE canonical = ?1)", [&alias], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if targets {
                return Err(format!("other keys alias to {alias}; it cannot become an alias itself"));
            }
            let kind = |key: &str| -> std::result::Result<Option<String>, String> {
                tx.query_row("SELECT kind FROM entity_stats WHERE entity = ?1", [key], |r| r.get(0))
                    .optional()
                    .map_err(|e| e.to_string())
            };
            if let (Some(a), Some(c)) = (kind(&alias)?, kind(&canonical)?) {
                if a != c {
                    return Err(format!("{alias} is a {a} and {canonical} a {c}"));
                }
            }
            Ok(Plan::Entity { op: "alias", payload: serde_json::json!({ "alias": alias, "canonical": canonical }) })
        }
        CurationOp::Unalias { alias } => {
            let alias = entity_key(alias);
            let canonical: Option<String> = tx
                .query_row("SELECT canonical FROM entity_aliases WHERE alias = ?1", [&alias], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            let Some(canonical) = canonical else {
                return Err(format!("{alias} is not an alias"));
            };
            Ok(Plan::Entity { op: "unalias", payload: serde_json::json!({ "alias": alias, "canonical": canonical }) })
        }
        CurationOp::Block { entity } | CurationOp::Unblock { entity } => {
            let block = matches!(action.op, CurationOp::Block { .. });
            let entity = entity_key(entity);
            if entity.is_empty() {
                return Err("entity must not be empty".into());
            }
            let blocked: bool = tx
                .query_row("SELECT EXISTS(SELECT 1 FROM entity_blocklist WHERE entity = ?1)", [&entity], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if block && blocked {
                return Err(format!("{entity} is already blocked"));
            }
            if !block && !blocked {
                return Err(format!("{entity} is not blocked"));
            }
            let op = if block { "block" } else { "unblock" };
            Ok(Plan::Entity { op, payload: serde_json::json!({ "entity": entity }) })
        }
        CurationOp::Note { session_id, text, source_ids } => {
            if session_id.trim().is_empty() {
                return Err("session_id is empty".into());
            }
            if text.trim().is_empty() {
                return Err("a note needs text".into());
            }
            if text.chars().count() > NOTE_MAX_CHARS {
                return Err(format!("a note is at most {NOTE_MAX_CHARS} characters"));
            }
            let sources = load(source_ids)?;
            for t in &sources {
                old_enough(t)?;
                if t.kind == TurnKind::Note {
                    return Err(format!("turn {} is a note; notes cannot be sources", t.id));
                }
            }
            let uuids: Vec<String> = sources.iter().map(|t| t.uuid.clone()).collect();
            let uuid = note_uuid(&uuids);
            if id_of(tx, &uuid).map_err(sql)?.is_some() {
                return Err("there is already a note for these sources".into());
            }
            let ts = sources.iter().map(|t| t.ts).max().unwrap_or(0);
            let input = TurnInput {
                session_id: session_id.trim().to_string(),
                speaker: CURATOR_SPEAKER.to_string(),
                text: text.trim().to_string(),
                ts: Some(ts),
                uuid: Some(uuid),
            };
            store::validate(&input).map_err(sql)?;
            let payload = serde_json::json!({ "session_id": input.session_id, "sources": uuids });
            Ok(Plan::Note { input, sources: sources.iter().map(|t| t.id).collect(), payload })
        }
        CurationOp::RunEnd { summary, cursor } => {
            let max_id: i64 =
                tx.query_row("SELECT COALESCE(MAX(id), 0) FROM turns", [], |r| r.get(0)).map_err(|e| e.to_string())?;
            let cursor = match cursor {
                Some(c) if *c < 0 || *c > max_id => return Err(format!("cursor must be within 0..={max_id}")),
                Some(c) => *c,
                None => tx
                    .query_row("SELECT COALESCE(MAX(id), 0) FROM turns WHERE ts <= ?1", [cutoff], |r| r.get(0))
                    .map_err(|e| e.to_string())?,
            };
            let previous = meta_i64_tx(tx, "curation_cursor").map_err(sql)?;
            Ok(Plan::RunEnd {
                payload: serde_json::json!({ "summary": summary.trim(), "cursor": cursor, "previous": previous }),
            })
        }
    }
}

fn record(
    tx: &Transaction<'_>,
    run_id: &str,
    actor: &str,
    ts: i64,
    op: &str,
    payload: &serde_json::Value,
    reason: &str,
) -> Result<i64> {
    tx.execute(
        "INSERT INTO curation_actions (run_id, actor, ts, op, payload, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![run_id, actor, ts, op, payload.to_string(), reason.trim()],
    )?;
    Ok(tx.last_insert_rowid())
}

fn payload_uuids(payload: &serde_json::Value) -> Vec<String> {
    payload["turns"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// Refold every live hide, unhide and supersede that names each uuid.
fn recompute_flags(tx: &Transaction<'_>, uuids: &[String]) -> Result<()> {
    let mut actions = tx.prepare_cached(
        "SELECT id, op, payload FROM curation_actions
         WHERE undone_at IS NULL AND op IN ('hide', 'unhide', 'supersede')
           AND EXISTS (SELECT 1 FROM json_each(curation_actions.payload, '$.turns') WHERE value = ?1)
         ORDER BY id",
    )?;
    for uuid in uuids {
        let Some(turn_id) = id_of(tx, uuid)? else { continue };
        let mut hidden = false;
        let mut by: Option<String> = None;
        let mut last = None;
        let rows =
            actions.query_map([uuid], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
        for row in rows {
            let (id, op, payload) = row?;
            last = Some(id);
            match op.as_str() {
                "hide" => hidden = true,
                "unhide" => hidden = false,
                _ => {
                    let payload: serde_json::Value = serde_json::from_str(&payload)?;
                    by = payload["by"].as_str().map(str::to_string);
                }
            }
        }
        let by_id = match &by {
            Some(u) => id_of(tx, u)?,
            None => None,
        };
        if !hidden && by_id.is_none() {
            tx.execute("DELETE FROM turn_flags WHERE turn_id = ?1", [turn_id])?;
        } else {
            tx.execute(
                "INSERT INTO turn_flags (turn_id, hidden, superseded_by, action_id) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(turn_id) DO UPDATE SET
                    hidden = excluded.hidden, superseded_by = excluded.superseded_by, action_id = excluded.action_id",
                params![turn_id, hidden, by_id, last],
            )?;
        }
    }
    Ok(())
}

/// Refold the alias or blocklist entry an entity action names.
fn recompute_entity_rule(tx: &Transaction<'_>, op: &str, payload: &serde_json::Value) -> Result<()> {
    match op {
        "alias" | "unalias" => {
            let alias = payload["alias"].as_str().unwrap_or_default();
            let last: Option<(i64, String, String)> = tx
                .query_row(
                    "SELECT id, op, payload FROM curation_actions
                     WHERE undone_at IS NULL AND op IN ('alias', 'unalias') AND json_extract(payload, '$.alias') = ?1
                     ORDER BY id DESC LIMIT 1",
                    [alias],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            tx.execute("DELETE FROM entity_aliases WHERE alias = ?1", [alias])?;
            if let Some((id, op, payload)) = last {
                if op == "alias" {
                    let payload: serde_json::Value = serde_json::from_str(&payload)?;
                    tx.execute(
                        "INSERT INTO entity_aliases (alias, canonical, action_id) VALUES (?1, ?2, ?3)",
                        params![alias, payload["canonical"].as_str().unwrap_or_default(), id],
                    )?;
                }
            }
        }
        _ => {
            let entity = payload["entity"].as_str().unwrap_or_default();
            let last: Option<(i64, String)> = tx
                .query_row(
                    "SELECT id, op FROM curation_actions
                     WHERE undone_at IS NULL AND op IN ('block', 'unblock') AND json_extract(payload, '$.entity') = ?1
                     ORDER BY id DESC LIMIT 1",
                    [entity],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            tx.execute("DELETE FROM entity_blocklist WHERE entity = ?1", [entity])?;
            if let Some((id, op)) = last {
                if op == "block" {
                    tx.execute(
                        "INSERT INTO entity_blocklist (entity, action_id) VALUES (?1, ?2)",
                        params![entity, id],
                    )?;
                }
            }
        }
    }
    Ok(())
}

/// The cursor is the newest live `run_end`'s.
fn recompute_cursor(tx: &Transaction<'_>) -> Result<()> {
    let cursor: Option<i64> = tx
        .query_row(
            "SELECT json_extract(payload, '$.cursor') FROM curation_actions
             WHERE undone_at IS NULL AND op = 'run_end' ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    match cursor {
        Some(c) => set_meta_tx(tx, "curation_cursor", &c.to_string())?,
        None => {
            tx.execute("DELETE FROM meta WHERE key = 'curation_cursor'", [])?;
        }
    }
    Ok(())
}
