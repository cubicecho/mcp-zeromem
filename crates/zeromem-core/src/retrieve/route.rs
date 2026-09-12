//! Which views run for a question, and how far each is trusted.

use serde::{Deserialize, Serialize};

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
/// The recent view runs only for temporal questions; its ranking alone
/// says little, so its weight is low and the decay term does the work.
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
    if profile.temporal {
        views.push(ViewPlan { kind: ViewKind::Recent, weight: RECENT_WEIGHT });
    }
    views
}

pub fn recency_weight(profile: &Profile) -> f64 {
    if profile.temporal {
        RECENCY_TEMPORAL
    } else {
        RECENCY_TIEBREAK
    }
}
