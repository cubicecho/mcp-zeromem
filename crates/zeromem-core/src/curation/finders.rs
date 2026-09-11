//! Candidate finders: cheap, deterministic scans that point a curator at
//! turns and keys worth a judgement. They never change anything; each
//! candidate carries a suggested action the curator may apply, edit or
//! skip.
//!
//! Turn-based finders (duplicates, noise, supersession) walk turns in id
//! order from `since_turn_id` (the run cursor by default), skipping notes,
//! hidden or superseded turns and turns younger than the configured age.
//! A page stops at `limit` candidates or after a bounded scan and reports
//! `scanned_through`, the id to resume from. Aliases and consolidation rank
//! keys and episodes instead and page with `offset`.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{clip, CurationOp, DAY_MS};
use crate::dense::VectorIndex;
use crate::entities::EntityKind;
use crate::error::Result;
use crate::store::Store;
use crate::text;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateKind {
    /// The same statement twice: equal normalised text, or vectors almost
    /// parallel.
    Duplicates,
    /// Chatter with nothing to recall, or pasted tool output.
    Noise,
    /// Two name keys that look like one person or thing.
    Aliases,
    /// A newer turn that restates something about the same subject with a
    /// different value.
    Supersession,
    /// A long, old episode no note stands for yet.
    Consolidation,
}

impl CandidateKind {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "duplicates" => CandidateKind::Duplicates,
            "noise" => CandidateKind::Noise,
            "aliases" => CandidateKind::Aliases,
            "supersession" => CandidateKind::Supersession,
            "consolidation" => CandidateKind::Consolidation,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FinderOptions {
    /// Look only at turns after this id. Defaults to the run cursor.
    #[serde(default)]
    pub since_turn_id: Option<i64>,
    /// Candidates per page; default 20, at most 100.
    #[serde(default)]
    pub limit: Option<u32>,
    /// For aliases and consolidation: skip this many ranked candidates.
    #[serde(default)]
    pub offset: Option<u32>,
}

pub const DEFAULT_LIMIT: u32 = 20;
pub const MAX_LIMIT: u32 = 100;
/// Cosine at or above which two turns count as the same statement.
pub const DUPLICATE_COSINE: f32 = 0.95;
/// Turns scanned per page; a dense check is a pass over every vector, so
/// duplicates scan fewer.
const SCAN_TURNS: usize = 5_000;
const SCAN_DUPLICATES: usize = 500;
/// An episode is worth a note once it has this many turns and is this old.
pub const CONSOLIDATE_MIN_TURNS: u32 = 8;
pub const CONSOLIDATE_MIN_AGE_MS: i64 = 7 * DAY_MS;
const TEXT_CHARS: usize = 300;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CandidateTurn {
    pub id: i64,
    pub session_id: String,
    pub speaker: String,
    pub ts: i64,
    /// Clipped to a few hundred characters; `zeromem_curate_read` has the rest.
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Candidate {
    pub kind: CandidateKind,
    /// How sure the finder is, in `[0, 1]`. Not a verdict.
    pub score: f64,
    /// The turns involved, oldest first.
    pub turns: Vec<CandidateTurn>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entities: Vec<String>,
    pub reason: String,
    /// What applying it would look like. A note's text is left for the
    /// curator to write.
    pub suggested: CurationOp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CandidatePage {
    pub kind: CandidateKind,
    pub since_turn_id: i64,
    pub candidates: Vec<Candidate>,
    /// Pass as `since_turn_id` (turn-based kinds) to continue.
    pub scanned_through: i64,
    /// Whether there is more to scan or rank past this page.
    pub more: bool,
}

struct ScanTurn {
    id: i64,
    session_id: String,
    speaker: String,
    text: String,
    ts: i64,
}

impl ScanTurn {
    fn candidate(&self) -> CandidateTurn {
        CandidateTurn {
            id: self.id,
            session_id: self.session_id.clone(),
            speaker: self.speaker.clone(),
            ts: self.ts,
            text: clip(&self.text, TEXT_CHARS),
        }
    }
}

/// Ordinary turns a curator may still act on: not notes, not hidden, not
/// already superseded.
const ELIGIBLE: &str = "t.kind = 'turn' AND NOT EXISTS (SELECT 1 FROM turn_flags f WHERE f.turn_id = t.id
                        AND (f.hidden = 1 OR f.superseded_by IS NOT NULL))";

pub fn find(
    store: &Store,
    index: &VectorIndex,
    kind: CandidateKind,
    opts: &FinderOptions,
    now: i64,
) -> Result<CandidatePage> {
    let config = store.curator_config()?;
    let cutoff = now - config.min_age_ms;
    let since = match opts.since_turn_id {
        Some(s) => s.max(0),
        None => store.curation_cursor()?,
    };
    let limit = opts.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize;
    let offset = opts.offset.unwrap_or(0) as usize;
    let (candidates, scanned_through, more) = match kind {
        CandidateKind::Duplicates => {
            let finder = Duplicates::load(store, index)?;
            scan(store, since, cutoff, limit, SCAN_DUPLICATES, |t| finder.check(store, index, t))?
        }
        CandidateKind::Noise => scan(store, since, cutoff, limit, SCAN_TURNS, |t| noise(store, t))?,
        CandidateKind::Supersession => {
            scan(store, since, cutoff, limit, SCAN_TURNS, |t| supersession(store, t, cutoff))?
        }
        CandidateKind::Aliases => aliases(store, since, limit, offset)?,
        CandidateKind::Consolidation => {
            consolidation(store, since, cutoff.min(now - CONSOLIDATE_MIN_AGE_MS), limit, offset)?
        }
    };
    Ok(CandidatePage { kind, since_turn_id: since, candidates, scanned_through, more })
}

fn eligible_after(store: &Store, after: i64, cutoff: i64, limit: usize) -> Result<Vec<ScanTurn>> {
    let sql = format!(
        "SELECT t.id, t.session_id, t.speaker, t.text, t.ts FROM turns t
         WHERE t.id > ?1 AND t.ts <= ?2 AND {ELIGIBLE} ORDER BY t.id LIMIT ?3"
    );
    let mut stmt = store.conn.prepare_cached(&sql)?;
    let rows = stmt.query_map(params![after, cutoff, limit as i64], |r| {
        Ok(ScanTurn { id: r.get(0)?, session_id: r.get(1)?, speaker: r.get(2)?, text: r.get(3)?, ts: r.get(4)? })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Walk eligible turns after `since`; stop at `limit` candidates or after
/// `budget` turns.
fn scan(
    store: &Store,
    since: i64,
    cutoff: i64,
    limit: usize,
    budget: usize,
    mut check: impl FnMut(&ScanTurn) -> Result<Option<Candidate>>,
) -> Result<(Vec<Candidate>, i64, bool)> {
    let mut out = Vec::new();
    let mut cursor = since;
    let mut scanned = 0;
    loop {
        let batch = eligible_after(store, cursor, cutoff, 500.min(budget - scanned))?;
        if batch.is_empty() {
            return Ok((out, cursor, false));
        }
        for t in &batch {
            cursor = t.id;
            scanned += 1;
            if let Some(c) = check(t)? {
                out.push(c);
            }
            if out.len() >= limit || scanned >= budget {
                let more = !eligible_after(store, cursor, cutoff, 1)?.is_empty();
                return Ok((out, cursor, more));
            }
        }
    }
}

/// Lower-case words without punctuation, for exact-duplicate matching.
fn normalised_text(text: &str) -> String {
    text::words(text).iter().map(|w| text::normalise(w.text)).collect::<Vec<_>>().join(" ")
}

fn content_words(text: &str) -> Vec<String> {
    text::words(text)
        .iter()
        .map(|w| text::normalise(w.text))
        .filter(|w| w.chars().any(char::is_alphabetic) && !text::is_stopword(w))
        .collect()
}

// --- duplicates ----------------------------------------------------------------

struct Duplicates {
    /// Normalised text → eligible turn ids, ascending.
    by_text: HashMap<String, Vec<i64>>,
    /// Ids a dense match may point at.
    eligible: BTreeSet<i64>,
}

impl Duplicates {
    fn load(store: &Store, index: &VectorIndex) -> Result<Self> {
        let sql = format!("SELECT t.id, t.text FROM turns t WHERE {ELIGIBLE} ORDER BY t.id");
        let mut stmt = store.conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        let mut by_text: HashMap<String, Vec<i64>> = HashMap::new();
        let mut eligible = BTreeSet::new();
        for row in rows {
            let (id, text) = row?;
            by_text.entry(normalised_text(&text)).or_default().push(id);
            if !index.is_empty() {
                eligible.insert(id);
            }
        }
        Ok(Duplicates { by_text, eligible })
    }

    /// Only an earlier turn can be the original, so each pair is reported
    /// once, at the later turn, and the suggestion hides the later one.
    fn check(&self, store: &Store, index: &VectorIndex, t: &ScanTurn) -> Result<Option<Candidate>> {
        // Chatter repeats by nature; the noise finder handles it.
        if content_words(&t.text).len() < 4 && store.mentions(t.id)?.is_empty() {
            return Ok(None);
        }
        let exact: Vec<i64> = self
            .by_text
            .get(&normalised_text(&t.text))
            .map(|ids| ids.iter().copied().filter(|id| *id < t.id).collect())
            .unwrap_or_default();
        let (earlier, score, reason) = if let Some(first) = exact.first() {
            (exact.clone(), 1.0, format!("same text as turn {first}"))
        } else {
            let Some(v) = index.vector(t.id) else { return Ok(None) };
            let hits: Vec<(i64, f32)> = index
                .search(v, 4, |id| id < t.id && self.eligible.contains(&id))
                .into_iter()
                .filter(|(_, s)| *s >= DUPLICATE_COSINE)
                .collect();
            let Some((first, cos)) = hits.first().copied() else { return Ok(None) };
            (
                hits.iter().map(|h| h.0).collect(),
                f64::from(cos).min(1.0),
                format!("nearly the same as turn {first} (cosine {cos:.3})"),
            )
        };
        let mut ids = earlier;
        ids.sort_unstable();
        let found = store.turns_by_ids(&ids)?;
        let mut turns: Vec<CandidateTurn> = ids
            .iter()
            .filter_map(|id| found.get(id))
            .map(|x| CandidateTurn {
                id: x.id,
                session_id: x.session_id.clone(),
                speaker: x.speaker.clone(),
                ts: x.ts,
                text: clip(&x.text, TEXT_CHARS),
            })
            .collect();
        turns.push(t.candidate());
        Ok(Some(Candidate {
            kind: CandidateKind::Duplicates,
            score: round3(score),
            turns,
            entities: Vec::new(),
            reason,
            suggested: CurationOp::Hide { turn_ids: vec![t.id] },
        }))
    }
}

// --- noise -----------------------------------------------------------------------

fn noise(store: &Store, t: &ScanTurn) -> Result<Option<Candidate>> {
    let chars = t.text.chars().count();
    let lines = t.text.lines().count();
    let symbols = t.text.chars().filter(|c| !c.is_alphanumeric() && !c.is_whitespace()).count();
    let (score, reason) = if chars >= 400 && (lines >= 15 || symbols as f64 / chars as f64 >= 0.25) {
        (0.7, format!("{lines} lines, {:.0}% symbols: looks like pasted output", 100.0 * symbols as f64 / chars as f64))
    } else {
        let content = content_words(&t.text).len();
        if content > 3 || chars > 120 || !store.mentions(t.id)?.is_empty() {
            return Ok(None);
        }
        (0.9 - 0.1 * content as f64, format!("{content} content words and no entities: chatter"))
    };
    Ok(Some(Candidate {
        kind: CandidateKind::Noise,
        score: round3(score),
        turns: vec![t.candidate()],
        entities: Vec::new(),
        reason,
        suggested: CurationOp::Hide { turn_ids: vec![t.id] },
    }))
}

// --- supersession ----------------------------------------------------------------

/// Words that announce a change of value.
const CHANGE_CUES: &[&str] = &[
    "update",
    "updated",
    "now",
    "changed",
    "moved",
    "instead",
    "longer",
    "correction",
    "actually",
    "switched",
    "plan",
];
const MIN_OVERLAP: f64 = 0.3;
const MAX_EARLIER: usize = 5;

/// Keys by kind, without `except`.
fn keyed(store: &Store, id: i64) -> Result<BTreeMap<String, EntityKind>> {
    Ok(store.mentions(id)?.into_iter().map(|m| (m.key, m.kind)).collect())
}

fn values_of(keys: &BTreeMap<String, EntityKind>, except: &str, kind: EntityKind) -> BTreeSet<String> {
    keys.iter().filter(|(k, v)| **v == kind && k.as_str() != except).map(|(k, _)| k.clone()).collect()
}

/// Predicate words: content words that are not part of an entity.
fn predicate(text: &str, keys: &BTreeMap<String, EntityKind>) -> BTreeSet<String> {
    let entity_words: BTreeSet<String> = keys.keys().flat_map(|k| k.split(' ').map(str::to_string)).collect();
    content_words(text).into_iter().map(|w| text::stem(&w)).filter(|w| !entity_words.contains(w)).collect()
}

fn jaccard(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f64 {
    let union = a.union(b).count();
    if union == 0 {
        0.0
    } else {
        a.intersection(b).count() as f64 / union as f64
    }
}

fn supersession(store: &Store, t: &ScanTurn, cutoff: i64) -> Result<Option<Candidate>> {
    let keys = keyed(store, t.id)?;
    let subjects: Vec<&String> = keys.iter().filter(|(_, k)| **k == EntityKind::Name).map(|(k, _)| k).collect();
    if subjects.is_empty() || keys.len() < 2 {
        return Ok(None);
    }
    let words = predicate(&t.text, &keys);
    let lower = t.text.to_lowercase();
    let cue = text::words(&lower).iter().any(|w| CHANGE_CUES.contains(&w.text));
    let sql = format!(
        "SELECT DISTINCT t.id, t.text FROM turn_entities e JOIN turns t ON t.id = e.turn_id
         WHERE e.entity = ?1 AND t.id != ?2 AND t.ts <= ?3 AND t.ts <= ?4 AND {ELIGIBLE}
         ORDER BY t.ts DESC, t.id DESC LIMIT 30"
    );
    let mut stmt = store.conn.prepare_cached(&sql)?;
    // Earlier turn id → (overlap, subject, what changed).
    let mut earlier: BTreeMap<i64, (f64, String, String)> = BTreeMap::new();
    for subject in &subjects {
        let rows = stmt
            .query_map(params![subject, t.id, t.ts, cutoff], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (pid, ptext) = row?;
            let pkeys = keyed(store, pid)?;
            let changed = [EntityKind::Name, EntityKind::Date, EntityKind::Quantity].into_iter().find_map(|kind| {
                let now = values_of(&keys, subject, kind);
                let before = values_of(&pkeys, subject, kind);
                (!now.is_empty() && !before.is_empty() && now.is_disjoint(&before)).then(|| {
                    format!(
                        "{} → {}",
                        before.into_iter().collect::<Vec<_>>().join(", "),
                        now.into_iter().collect::<Vec<_>>().join(", ")
                    )
                })
            });
            let Some(changed) = changed else { continue };
            let overlap = jaccard(&words, &predicate(&ptext, &pkeys));
            if overlap < MIN_OVERLAP {
                continue;
            }
            let entry = earlier.entry(pid).or_insert((overlap, subject.to_string(), changed.clone()));
            if overlap > entry.0 {
                *entry = (overlap, subject.to_string(), changed);
            }
        }
    }
    if earlier.is_empty() {
        return Ok(None);
    }
    let mut ranked: Vec<(i64, (f64, String, String))> = earlier.into_iter().collect();
    ranked.sort_by(|a, b| b.1 .0.total_cmp(&a.1 .0).then(b.0.cmp(&a.0)));
    ranked.truncate(MAX_EARLIER);
    let best = ranked[0].1.clone();
    let mut ids: Vec<i64> = ranked.iter().map(|r| r.0).collect();
    let found = store.turns_by_ids(&ids)?;
    ids.sort_by_key(|id| found.get(id).map(|x| (x.ts, x.id)));
    let mut turns: Vec<CandidateTurn> = ids
        .iter()
        .filter_map(|id| found.get(id))
        .map(|x| CandidateTurn {
            id: x.id,
            session_id: x.session_id.clone(),
            speaker: x.speaker.clone(),
            ts: x.ts,
            text: clip(&x.text, TEXT_CHARS),
        })
        .collect();
    turns.push(t.candidate());
    let entities: Vec<String> = ranked.iter().map(|r| r.1 .1.clone()).collect::<BTreeSet<_>>().into_iter().collect();
    Ok(Some(Candidate {
        kind: CandidateKind::Supersession,
        score: round3((best.0 + if cue { 0.2 } else { 0.0 }).min(1.0)),
        turns,
        entities,
        reason: format!("about {}: {}{}", best.1, best.2, if cue { ", worded as a change" } else { "" }),
        suggested: CurationOp::Supersede { turn_ids: ids, by: t.id },
    }))
}

// --- aliases ---------------------------------------------------------------------

fn aliases(store: &Store, since: i64, limit: usize, offset: usize) -> Result<(Vec<Candidate>, i64, bool)> {
    let names: BTreeSet<String> = {
        let mut stmt = store.conn.prepare("SELECT entity FROM entity_stats WHERE kind = 'name'")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let fresh: Option<BTreeSet<String>> = if since > 0 {
        let mut stmt = store.conn.prepare("SELECT DISTINCT entity FROM turn_entities WHERE turn_id > ?1")?;
        let rows = stmt.query_map([since], |r| r.get(0))?;
        Some(rows.collect::<rusqlite::Result<_>>()?)
    } else {
        None
    };
    // (short, long) → how the short one is formed.
    let mut pairs: BTreeMap<(String, String), &'static str> = BTreeMap::new();
    for long in &names {
        let tokens: Vec<&str> = long.split(' ').collect();
        if tokens.len() < 2 {
            continue;
        }
        for n in 1..tokens.len() {
            for (short, how) in
                [(tokens[..n].join(" "), "a prefix"), (tokens[tokens.len() - n..].join(" "), "a suffix")]
            {
                if short.chars().count() >= 2 && names.contains(&short) {
                    pairs.entry((short, long.clone())).or_insert(how);
                }
            }
        }
        let initials: String = tokens.iter().filter_map(|t| t.chars().next()).collect();
        if initials.chars().count() >= 2 && names.contains(&initials) {
            pairs.entry((initials, long.clone())).or_insert("the initials");
        }
    }
    let sessions = |key: &str| -> Result<BTreeSet<String>> {
        let mut stmt = store.conn.prepare_cached(
            "SELECT DISTINCT t.session_id FROM turn_entities e JOIN turns t ON t.id = e.turn_id WHERE e.entity = ?1",
        )?;
        let rows = stmt.query_map([key], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    };
    let mut ranked = Vec::new();
    for ((short, long), how) in pairs {
        if let Some(fresh) = &fresh {
            if !fresh.contains(&short) && !fresh.contains(&long) {
                continue;
            }
        }
        let (a, b) = (sessions(&short)?, sessions(&long)?);
        let shared = a.intersection(&b).count();
        let together = if a.is_empty() || b.is_empty() { 0.0 } else { shared as f64 / a.len().min(b.len()) as f64 };
        let na: BTreeSet<String> =
            store.neighbours(&short, 20)?.into_iter().map(|n| n.0).filter(|n| n != &long).collect();
        let nb: BTreeSet<String> =
            store.neighbours(&long, 20)?.into_iter().map(|n| n.0).filter(|n| n != &short).collect();
        let neighbours = jaccard(&na, &nb);
        let score = round3(0.5 * together + 0.5 * neighbours);
        ranked.push(Candidate {
            kind: CandidateKind::Aliases,
            score,
            turns: Vec::new(),
            entities: vec![short.clone(), long.clone()],
            reason: format!(
                "{short} is {how} of {long}; {shared} shared sessions, {:.0}% shared neighbours",
                100.0 * neighbours
            ),
            suggested: CurationOp::Alias { alias: short, canonical: long },
        });
    }
    ranked.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.entities.cmp(&b.entities)));
    let total = ranked.len();
    let page: Vec<Candidate> = ranked.into_iter().skip(offset).take(limit).collect();
    let max_id = store.max_turn_id()?;
    Ok((page, max_id, offset + limit < total))
}

// --- consolidation ---------------------------------------------------------------

fn consolidation(
    store: &Store,
    since: i64,
    cutoff: i64,
    limit: usize,
    offset: usize,
) -> Result<(Vec<Candidate>, i64, bool)> {
    let mut stmt = store.conn.prepare(
        "SELECT session_id, start_ts, end_ts, last_turn_id, turns, entities FROM segments
         WHERE level = 'episode' AND end_ts <= ?1 AND turns >= ?2 AND last_turn_id > ?3
         ORDER BY last_turn_id, session_id",
    )?;
    type Episode = (String, i64, i64, i64, u32, String);
    let episodes: Vec<Episode> = stmt
        .query_map(params![cutoff, CONSOLIDATE_MIN_TURNS, since], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let sql = format!(
        "SELECT t.id, t.session_id, t.speaker, t.text, t.ts FROM turns t
         WHERE t.session_id = ?1 AND t.ts BETWEEN ?2 AND ?3 AND {ELIGIBLE} ORDER BY t.ts, t.id"
    );
    let mut turns_of = store.conn.prepare_cached(&sql)?;
    let mut covered = store.conn.prepare_cached("SELECT 1 FROM note_sources WHERE turn_id = ?1 LIMIT 1")?;
    let mut out = Vec::new();
    let mut skipped = 0;
    let mut scanned_through = since;
    for (session_id, start, end, last_id, _, entities) in episodes {
        let turns: Vec<ScanTurn> = turns_of
            .query_map(params![session_id, start, end], |r| {
                Ok(ScanTurn {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    speaker: r.get(2)?,
                    text: r.get(3)?,
                    ts: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        if (turns.len() as u32) < CONSOLIDATE_MIN_TURNS {
            continue;
        }
        let mut any_covered = false;
        for t in &turns {
            if covered.exists([t.id])? {
                any_covered = true;
                break;
            }
        }
        if any_covered {
            continue;
        }
        if skipped < offset {
            skipped += 1;
            continue;
        }
        if out.len() >= limit {
            return Ok((out, scanned_through, true));
        }
        scanned_through = scanned_through.max(last_id);
        let entities: Vec<String> = serde_json::from_str(&entities).unwrap_or_default();
        let n = turns.len();
        out.push(Candidate {
            kind: CandidateKind::Consolidation,
            score: round3((n as f64 / 30.0).min(1.0)),
            turns: turns.iter().map(ScanTurn::candidate).collect(),
            entities,
            reason: format!("{n} turns in session {session_id} with no note"),
            suggested: CurationOp::Note {
                session_id: session_id.clone(),
                text: String::new(),
                source_ids: turns.iter().map(|t| t.id).collect(),
            },
        });
    }
    Ok((out, scanned_through, false))
}

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}
