//! Which views run for a question, and how far each is trusted.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::fuse::Clock;
use super::profile::Profile;
use super::Context;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ViewKind {
    Lexical,
    Entity,
    Dense,
    Recent,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ViewPlan {
    pub kind: ViewKind,
    pub weight: f64,
}

pub const LEXICAL_WEIGHT: f64 = 1.0;
/// Half of lexical, because the entity view is broad rather than precise: a
/// question almost always names one entity, and `entity_view` then scores
/// every turn mentioning it by the number of distinct keys matched — which
/// is 1 for all of them. Its list is ordered only by the turn-id tiebreak,
/// so its top slot earns RRF's full `1/(k+1)` on what is really just the
/// most recent mention. Measured on the large corpus under hash: at 1.0
/// recall@5 0.710 / MRR 0.895 / nDCG@5 0.670, at 0.5 0.748 / 0.914 / 0.688,
/// and with the view off entirely 0.730 / 0.906 / 0.656. So the view earns
/// its place — the weight was what did not.
pub const ENTITY_WEIGHT: f64 = 0.5;
pub const DENSE_WEIGHT: f64 = 0.8;
/// The hash embedder is a crude stand-in; it still helps but is not trusted
/// as much as the model.
pub const DENSE_FALLBACK_WEIGHT: f64 = 0.4;
/// The recent view runs only for temporal questions that are not about the
/// past; its ranking alone says little, so its weight is low and the decay
/// term does the work.
pub const RECENT_WEIGHT: f64 = 0.2;
/// Continuous recency term added to the fused score.
pub const RECENCY_TEMPORAL: f64 = 0.3;
pub const RECENCY_TIEBREAK: f64 = 0.02;

pub fn plan(profile: &Profile, ctx: &Context<'_>) -> Vec<ViewPlan> {
    let mut views = Vec::new();
    if !profile.tokens.is_empty() {
        views.push(ViewPlan { kind: ViewKind::Lexical, weight: LEXICAL_WEIGHT });
    }
    if !profile.entities.is_empty() {
        views.push(ViewPlan { kind: ViewKind::Entity, weight: ENTITY_WEIGHT });
    }
    if let Some(embedder) = ctx.embedder.as_deref() {
        if !ctx.index.is_empty() && !profile.text.is_empty() {
            let weight = if embedder.is_fallback() { DENSE_FALLBACK_WEIGHT } else { DENSE_WEIGHT };
            views.push(ViewPlan { kind: ViewKind::Dense, weight });
        }
    }
    // `as of March 2025` and `before the latest change` trip a temporal cue
    // and mean the opposite of "now".
    if profile.temporal && !profile.past() {
        views.push(ViewPlan { kind: ViewKind::Recent, weight: RECENT_WEIGHT });
    }
    views
}

/// How time enters the fused score for this question. A named period
/// outranks a history cue: `what did we previously agree in March 2025` is
/// about March.
pub fn clock<'a>(profile: &Profile, latest_ts: i64, valid_until: &'a BTreeMap<i64, i64>) -> Clock<'a> {
    match profile.window {
        Some(window) => Clock::Window { window, valid_until },
        None if profile.history => Clock::History { valid_until, latest_ts },
        None => Clock::Now { weight: if profile.temporal { RECENCY_TEMPORAL } else { RECENCY_TIEBREAK }, latest_ts },
    }
}
