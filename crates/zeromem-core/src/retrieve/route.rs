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
pub const ENTITY_WEIGHT: f64 = 1.0;
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
