//! Reciprocal-rank fusion with a recency term.
//!
//! Each view contributes `weight / (k + rank)`; the sum is divided by the
//! best possible sum so a turn every view ranked first scores 1. Recency
//! is a decaying term measured from the newest turn in the store, small
//! enough to break ties on most questions and large enough to prefer the
//! latest of two statements on a temporal one.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::route::ViewKind;
use super::ViewTrace;
use crate::types::Turn;

/// The usual 60 is tuned for fusing many long lists; with four short ones
/// it flattens rank differences so much that calibration cannot tell first
/// from fifth. Ten keeps the top of each list meaningful.
pub const RRF_K: f64 = 10.0;
/// A turn this much older than the newest one has half the recency term.
pub const HALF_LIFE_MS: f64 = 30.0 * 24.0 * 3600.0 * 1000.0;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Fused {
    pub id: i64,
    /// In `[0, 1 + recency]`; rounded to 6 places so it is stable across
    /// platforms.
    pub score: f64,
    pub sources: Vec<ViewKind>,
    pub ts: i64,
    pub uuid: String,
}

pub fn fuse(views: &[ViewTrace], turns: &BTreeMap<i64, Turn>, recency_weight: f64, latest_ts: i64) -> Vec<Fused> {
    let best_possible: f64 = views.iter().map(|v| v.weight / (RRF_K + 1.0)).sum();
    let mut acc: BTreeMap<i64, (f64, Vec<ViewKind>)> = BTreeMap::new();
    for v in views {
        for (rank, (id, _)) in v.candidates.iter().enumerate() {
            let e = acc.entry(*id).or_insert_with(|| (0.0, Vec::new()));
            e.0 += v.weight / (RRF_K + rank as f64 + 1.0);
            e.1.push(v.view);
        }
    }
    let mut out: Vec<Fused> = acc
        .into_iter()
        .filter_map(|(id, (raw, sources))| {
            let turn = turns.get(&id)?;
            let rank_part = if best_possible > 0.0 { raw / best_possible } else { 0.0 };
            let score = round6(rank_part + recency_weight * decay(turn.ts, latest_ts));
            Some(Fused { id, score, sources, ts: turn.ts, uuid: turn.uuid.clone() })
        })
        .collect();
    out.sort_by(order);
    out
}

/// Best first; ties to the newer turn, then by uuid so the order is total.
pub fn order(a: &Fused, b: &Fused) -> std::cmp::Ordering {
    b.score.total_cmp(&a.score).then(b.ts.cmp(&a.ts)).then(a.uuid.cmp(&b.uuid))
}

pub fn decay(ts: i64, latest_ts: i64) -> f64 {
    let age = (latest_ts - ts).max(0) as f64;
    0.5f64.powf(age / HALF_LIFE_MS)
}

pub fn round6(x: f64) -> f64 {
    (x * 1_000_000.0).round() / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(id: i64, ts: i64) -> Turn {
        Turn {
            id,
            uuid: format!("u{id}"),
            session_id: "s".into(),
            speaker: "user".into(),
            text: "t".into(),
            ts,
            kind: Default::default(),
        }
    }

    #[test]
    fn agreement_beats_a_single_view() {
        let turns: BTreeMap<i64, Turn> = [(1, turn(1, 0)), (2, turn(2, 0)), (3, turn(3, 0))].into();
        let views = vec![
            ViewTrace { view: ViewKind::Lexical, weight: 1.0, candidates: vec![(1, 9.0), (2, 8.0)] },
            ViewTrace { view: ViewKind::Entity, weight: 1.0, candidates: vec![(2, 1.0), (3, 1.0)] },
        ];
        let fused = fuse(&views, &turns, 0.0, 0);
        assert_eq!(fused.iter().map(|f| f.id).collect::<Vec<_>>(), vec![2, 1, 3]);
        assert_eq!(fused[0].sources, vec![ViewKind::Lexical, ViewKind::Entity]);
        assert!(fused[0].score < 1.0 && fused[0].score > 0.9);
    }

    #[test]
    fn recency_breaks_ties_toward_the_newest() {
        let sixty_days = (2.0 * HALF_LIFE_MS) as i64;
        let turns: BTreeMap<i64, Turn> = [(1, turn(1, 0)), (2, turn(2, sixty_days))].into();
        let views = vec![ViewTrace { view: ViewKind::Entity, weight: 1.0, candidates: vec![(1, 1.0), (2, 1.0)] }];
        let fused = fuse(&views, &turns, 0.3, sixty_days);
        assert_eq!(fused[0].id, 2, "rank says 1 by a hair, recency says 2 by a lot");
        let tiebreak = fuse(&views, &turns, 0.02, sixty_days);
        assert_eq!(tiebreak[0].id, 1, "the tie-break weight does not overturn a rank difference");
    }

    #[test]
    fn filtered_turns_do_not_appear() {
        let turns: BTreeMap<i64, Turn> = [(1, turn(1, 0))].into();
        let views = vec![ViewTrace { view: ViewKind::Lexical, weight: 1.0, candidates: vec![(1, 9.0), (2, 8.0)] }];
        assert_eq!(fuse(&views, &turns, 0.0, 0).len(), 1);
    }
}
