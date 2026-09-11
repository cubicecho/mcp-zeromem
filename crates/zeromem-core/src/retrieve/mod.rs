//! Recall: from a question to a ranked, calibrated evidence set, with no
//! model in the loop.
//!
//! Four views each nominate candidates — lexical (BM25 over the words),
//! entity (turns that mention what the question mentions, widened one hop
//! along the co-occurrence graph), dense (nearest vectors), and recency.
//! `profile` reads the question, `route` decides which views run and how
//! much each is trusted, `fuse` merges their rankings, `calibrate` turns
//! fused scores into a confidence and a role and drops what is not worth
//! showing. The trace of every stage is kept, so `query_trace` is the same
//! run with the intermediate state left in, not a second implementation.
//!
//! Curation shapes the run without changing any view: hidden turns are
//! never nominated; outside a temporal question a superseded turn hands its
//! fused score to the turn that replaced it, is halved itself, and drops out
//! when its replacement is kept; and a turn drops out under a kept note that
//! stands for it.

pub mod calibrate;
pub mod fuse;
pub mod profile;
pub mod route;

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::curation::Flags;
use crate::dense::{Embedder, VectorIndex};
use crate::error::Result;
use crate::store::Store;
use crate::types::Turn;

pub use calibrate::{Calibrated, Role, DROP_BELOW, PRIMARY_AT};
pub use fuse::{Fused, RRF_K};
pub use profile::Profile;
pub use route::{ViewKind, ViewPlan};

/// How much of the answer to return.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Detail {
    /// Evidence only.
    #[default]
    Compact,
    /// Evidence plus the route and each item's provenance.
    Full,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct QueryOptions {
    /// How many evidence items at most. Default 5, capped at 50.
    pub top_k: Option<u32>,
    /// Leave out this session, typically the one asking.
    pub exclude_session: Option<String>,
    /// Only this session.
    pub session: Option<String>,
    /// Only turns at or after this timestamp (ms).
    pub since: Option<i64>,
    /// Only turns at or before this timestamp (ms).
    pub until: Option<i64>,
    pub detail: Option<Detail>,
    /// Let hidden turns be recalled too, flagged; for the curator and the
    /// admin UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_hidden: Option<bool>,
}

pub const DEFAULT_TOP_K: u32 = 5;
pub const MAX_TOP_K: u32 = 50;
/// How many candidates each view nominates.
pub const VIEW_LIMIT: usize = 50;
/// What a superseded turn's fused score is multiplied by.
pub const SUPERSEDED_FACTOR: f64 = 0.5;
/// Collapsing frees places that calibration refills; bounded so a chain
/// of notes and supersessions cannot loop.
const COLLAPSE_PASSES: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Evidence {
    pub turn: Turn,
    /// Fused score in `[0, 1]`; 1 means every view ranked it first.
    pub score: f64,
    /// Fraction of the best score in this answer.
    pub confidence: f64,
    pub role: Role,
    /// Which views nominated it. Empty under `Detail::Compact`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<ViewKind>,
    /// Entity keys the turn mentions. Empty under `Detail::Compact`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entities: Vec<String>,
    /// A newer turn restates this one. Kept only when that turn is not in
    /// the answer, or the question is about history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<i64>,
    /// Hidden by curation; only with `include_hidden`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    /// For a note, the turns it stands for.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub covers: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ViewSummary {
    pub view: ViewKind,
    pub weight: f64,
    pub candidates: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Route {
    pub profile: Profile,
    pub views: Vec<ViewSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QueryResult {
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<Route>,
    pub evidence: Vec<Evidence>,
    /// Distinct turns any view nominated, after filters.
    pub considered: usize,
    pub took_ms: u64,
}

/// One view's ranked nominations with their raw scores, before fusion.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ViewTrace {
    pub view: ViewKind,
    pub weight: f64,
    /// `(turn id, raw score)`, best first.
    pub candidates: Vec<(i64, f64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Dropped {
    pub id: i64,
    pub score: f64,
    pub reason: String,
}

/// Every stage of one run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QueryTrace {
    pub query: String,
    pub profile: Profile,
    pub views: Vec<ViewTrace>,
    /// Fused scores, best first, after filters.
    pub fused: Vec<Fused>,
    pub dropped: Vec<Dropped>,
    pub evidence: Vec<Evidence>,
    pub took_ms: u64,
}

/// What one run needs to touch.
pub struct Context<'a> {
    pub store: &'a Store,
    pub index: &'a VectorIndex,
    pub embedder: Option<&'a mut (dyn Embedder + 'a)>,
    /// Newest timestamp in the store; recency is measured from here.
    pub latest_ts: i64,
}

/// A filter over turns, from the options.
struct Filter<'a> {
    exclude_session: Option<&'a str>,
    session: Option<&'a str>,
    since: Option<i64>,
    until: Option<i64>,
    /// Hidden turns to leave out; `None` with `include_hidden`.
    hidden: Option<&'a BTreeSet<i64>>,
}

impl Filter<'_> {
    fn keeps(&self, t: &Turn) -> bool {
        self.hidden.is_none_or(|h| !h.contains(&t.id))
            && self.exclude_session.is_none_or(|s| t.session_id != s)
            && self.session.is_none_or(|s| t.session_id == s)
            && self.since.is_none_or(|s| t.ts >= s)
            && self.until.is_none_or(|u| t.ts <= u)
    }
}

pub fn run(ctx: &mut Context<'_>, query: &str, opts: &QueryOptions) -> Result<QueryTrace> {
    let started = std::time::Instant::now();
    let top_k = opts.top_k.unwrap_or(DEFAULT_TOP_K).clamp(1, MAX_TOP_K) as usize;
    let detail = opts.detail.unwrap_or_default();
    let profile = profile::profile(query);
    let plan = route::plan(&profile, ctx);
    let include_hidden = opts.include_hidden.unwrap_or(false);
    let flags = ctx.store.curation_flags()?;

    // Nominate.
    let mut views: Vec<ViewTrace> = Vec::with_capacity(plan.len());
    for view in &plan {
        let candidates = nominate(ctx, view, &profile, include_hidden, &flags)?;
        views.push(ViewTrace { view: view.kind, weight: view.weight, candidates });
    }

    // Load and filter every nominated turn once.
    let mut ids: Vec<i64> = views.iter().flat_map(|v| v.candidates.iter().map(|c| c.0)).collect();
    ids.sort_unstable();
    ids.dedup();
    let filter = Filter {
        exclude_session: opts.exclude_session.as_deref(),
        session: opts.session.as_deref(),
        since: opts.since,
        until: opts.until,
        hidden: (!include_hidden).then_some(&flags.hidden),
    };
    let mut turns: BTreeMap<i64, Turn> =
        ctx.store.turns_by_ids(&ids)?.into_iter().filter(|(_, t)| filter.keeps(t)).collect();
    for v in &mut views {
        v.candidates.retain(|c| turns.contains_key(&c.0));
    }
    let considered = turns.len();

    // Fuse and calibrate.
    let recency_weight = route::recency_weight(&profile);
    let mut fused = fuse::fuse(&views, &turns, recency_weight, ctx.latest_ts);
    if !profile.temporal && fused.iter().any(|f| flags.superseded_by.contains_key(&f.id)) {
        hand_over(ctx.store, &mut fused, &mut turns, &flags, &filter)?;
    }
    let Calibrated { kept, dropped } = collapse(&fused, top_k, &flags, profile.temporal);

    let mut evidence = Vec::with_capacity(kept.len());
    for item in kept {
        let turn = turns[&item.id].clone();
        let (sources, entities) = match detail {
            Detail::Compact => (Vec::new(), Vec::new()),
            Detail::Full => {
                let mut keys: Vec<String> = ctx.store.mentions(item.id)?.into_iter().map(|m| m.key).collect();
                keys.sort();
                keys.dedup();
                (item.sources.clone(), keys)
            }
        };
        let kept_by = flags.superseded_by.get(&item.id).copied();
        let covers = flags.sources.get(&item.id).cloned().unwrap_or_default();
        evidence.push(Evidence {
            hidden: flags.hidden.contains(&item.id),
            superseded_by: kept_by,
            covers,
            turn,
            score: item.score,
            confidence: item.confidence,
            role: item.role,
            sources,
            entities,
        });
    }

    let _ = considered;
    Ok(QueryTrace {
        query: query.to_string(),
        profile,
        views,
        fused,
        dropped,
        evidence,
        took_ms: started.elapsed().as_millis() as u64,
    })
}

/// A superseded turn hands its score to the turn that replaced it: the
/// views found the old statement, and the curator said the new one is what
/// it now reads. The replacement scores at least as well as what it
/// replaced, and is brought in when no view nominated it (a changed value
/// often shares few words with the question); the old turn is halved, and
/// `collapse` folds it away when both make the answer. Chains are followed
/// to the latest turn; a replacement the filter refuses leaves the old turn
/// only halved.
fn hand_over(
    store: &Store,
    fused: &mut Vec<Fused>,
    turns: &mut BTreeMap<i64, Turn>,
    flags: &Flags,
    filter: &Filter<'_>,
) -> Result<()> {
    let latest = |mut id: i64| {
        for _ in 0..flags.superseded_by.len() {
            match flags.superseded_by.get(&id) {
                Some(next) if *next != id => id = *next,
                _ => break,
            }
        }
        id
    };
    let heirs: Vec<(usize, i64)> = fused
        .iter()
        .enumerate()
        .filter(|(_, f)| flags.superseded_by.contains_key(&f.id))
        .map(|(i, f)| (i, latest(f.id)))
        .filter(|(i, heir)| *heir != fused[*i].id)
        .collect();
    let missing: Vec<i64> = heirs.iter().map(|(_, h)| *h).filter(|h| !turns.contains_key(h)).collect();
    if !missing.is_empty() {
        for (id, turn) in store.turns_by_ids(&missing)? {
            if filter.keeps(&turn) {
                turns.insert(id, turn);
            }
        }
    }
    let mut inherited: BTreeMap<i64, Fused> = BTreeMap::new();
    for (i, heir) in heirs {
        let old = &fused[i];
        let Some(turn) = turns.get(&heir) else { continue };
        let entry = inherited.entry(heir).or_insert_with(|| Fused {
            id: heir,
            score: 0.0,
            sources: Vec::new(),
            ts: turn.ts,
            uuid: turn.uuid.clone(),
        });
        if old.score > entry.score {
            entry.score = old.score;
            entry.sources = old.sources.clone();
        }
    }
    for f in fused.iter_mut() {
        if flags.superseded_by.contains_key(&f.id) {
            f.score = fuse::round6(f.score * SUPERSEDED_FACTOR);
        }
        if let Some(heir) = inherited.remove(&f.id) {
            if heir.score > f.score {
                f.score = heir.score;
            }
        }
    }
    fused.extend(inherited.into_values());
    fused.sort_by(fuse::order);
    Ok(())
}

/// Calibrate, then fold superseded turns into the turn that supersedes
/// them and sources into the note that stands for them, when both made the
/// answer; recalibrate over what is left so the freed places refill.
fn collapse(fused: &[Fused], top_k: usize, flags: &Flags, temporal: bool) -> Calibrated {
    let mut calibrated = calibrate::calibrate(fused, top_k);
    if flags.superseded_by.is_empty() && flags.covered_by.is_empty() {
        return calibrated;
    }
    let mut pool: Vec<Fused> = fused.to_vec();
    let mut collapsed: Vec<Dropped> = Vec::new();
    for _ in 0..COLLAPSE_PASSES {
        let kept: BTreeSet<i64> = calibrated.kept.iter().map(|k| k.id).collect();
        let mut removed: BTreeSet<i64> = BTreeSet::new();
        // Best first, so of two turns pointing at each other the better stays.
        for k in &calibrated.kept {
            let alive = |id: &i64| kept.contains(id) && !removed.contains(id);
            let reason = match flags.superseded_by.get(&k.id) {
                Some(by) if !temporal && alive(by) => Some(format!("superseded by {by}")),
                _ => flags
                    .covered_by
                    .get(&k.id)
                    .and_then(|notes| notes.iter().find(|n| alive(n)))
                    .map(|n| format!("covered by note {n}")),
            };
            if let Some(reason) = reason {
                removed.insert(k.id);
                collapsed.push(Dropped { id: k.id, score: k.score, reason });
            }
        }
        if removed.is_empty() {
            break;
        }
        pool.retain(|f| !removed.contains(&f.id));
        calibrated = calibrate::calibrate(&pool, top_k);
    }
    collapsed.append(&mut calibrated.dropped);
    calibrated.dropped = collapsed;
    calibrated
}

/// Shrink a trace to what `query` returns.
pub fn to_result(trace: QueryTrace, detail: Detail) -> QueryResult {
    let considered = trace.fused.len();
    let route = match detail {
        Detail::Compact => None,
        Detail::Full => Some(Route {
            profile: trace.profile,
            views: trace
                .views
                .iter()
                .map(|v| ViewSummary { view: v.view, weight: v.weight, candidates: v.candidates.len() })
                .collect(),
        }),
    };
    QueryResult { query: trace.query, route, evidence: trace.evidence, considered, took_ms: trace.took_ms }
}

fn nominate(
    ctx: &mut Context<'_>,
    view: &ViewPlan,
    profile: &Profile,
    include_hidden: bool,
    flags: &Flags,
) -> Result<Vec<(i64, f64)>> {
    Ok(match view.kind {
        ViewKind::Lexical => ctx.store.lexical_search(&profile.tokens, VIEW_LIMIT, include_hidden)?,
        ViewKind::Entity => entity_view(ctx.store, &profile.entities, include_hidden)?,
        ViewKind::Dense => match ctx.embedder.as_deref_mut() {
            // A failing embedder (a remote box that is down) empties this
            // view; the others still answer.
            Some(embedder) if !ctx.index.is_empty() => match embedder.embed_query(&profile.text) {
                Ok(q) => ctx
                    .index
                    .search(&q, VIEW_LIMIT, |id| include_hidden || !flags.hidden.contains(&id))
                    .into_iter()
                    .map(|(id, s)| (id, f64::from(s)))
                    .collect(),
                Err(e) => {
                    log::warn!("dense view skipped: {e}");
                    Vec::new()
                }
            },
            _ => Vec::new(),
        },
        ViewKind::Recent => {
            ctx.store.recent_turn_ids(VIEW_LIMIT, include_hidden)?.into_iter().map(|id| (id, 1.0)).collect()
        }
    })
}

/// Turns mentioning the question's entities score one per distinct match;
/// turns mentioning an entity that often co-occurs with one of them score
/// a fraction, so a question about a person also reaches the project they
/// are always mentioned with.
fn entity_view(store: &Store, keys: &[String], include_hidden: bool) -> Result<Vec<(i64, f64)>> {
    const NEIGHBOURS: usize = 5;
    const NEIGHBOUR_WEIGHT: f64 = 0.3;
    let mut scores: BTreeMap<i64, f64> = BTreeMap::new();
    for (id, n) in store.turns_mentioning(keys, VIEW_LIMIT * 2, include_hidden)? {
        scores.insert(id, f64::from(n));
    }
    let mut neighbours: Vec<String> = Vec::new();
    for key in keys {
        for (other, _) in store.neighbours(key, NEIGHBOURS)? {
            if !keys.contains(&other) && !neighbours.contains(&other) {
                neighbours.push(other);
            }
        }
    }
    for (id, n) in store.turns_mentioning(&neighbours, VIEW_LIMIT * 2, include_hidden)? {
        *scores.entry(id).or_insert(0.0) += NEIGHBOUR_WEIGHT * f64::from(n);
    }
    let mut ranked: Vec<(i64, f64)> = scores.into_iter().collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.0.cmp(&a.0)));
    ranked.truncate(VIEW_LIMIT);
    Ok(ranked)
}
