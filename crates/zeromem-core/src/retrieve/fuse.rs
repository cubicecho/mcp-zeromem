//! Reciprocal-rank fusion with a recency term.
//!
//! Each view contributes `weight / (k + rank)`; the sum is divided by the
//! best possible sum so a turn every view ranked first scores 1. Recency
//! is a decaying term measured from the newest turn in the store, small
//! enough to break ties on most questions and large enough to prefer the
//! latest of two statements on a temporal one.
//!
//! A question about the past turns that clock round ([`Clock`]): one that
//! names a period measures recency from the period's end, over the turns
//! in force during it, and one that asks what held before prefers what
//! curation says has since been replaced.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::route::{ViewKind, RECENCY_TEMPORAL};
use super::window::Window;
use super::ViewTrace;
use crate::types::Turn;

/// The usual 60 is tuned for fusing many long lists; with four short ones
/// it flattens rank differences so much that calibration cannot tell first
/// from fifth. Ten keeps the top of each list meaningful.
pub const RRF_K: f64 = 10.0;
/// A turn this much older than the newest one has half the recency term.
pub const HALF_LIFE_MS: f64 = 30.0 * 24.0 * 3600.0 * 1000.0;

/// What a turn in force during the question's period gains on its rank
/// score, before recency. Measured on the large corpus under hash, as-of
/// questions: at 0 recall@5 0.765 / MRR 0.868 / nDCG@5 0.639, at 0.1 0.749 /
/// 0.870 / 0.651, at 0.2 0.733 / 0.874 / 0.660, at 0.35 0.696 / 0.866 /
/// 0.651. Recall counts a statement of any value, so it falls as later
/// values give way to turns from the period; past 0.1 it falls faster than
/// nDCG, which grades the value that held, rises. Those rows predate
/// `settle_ties`; with it the 0.1 row is 0.731 / 0.860 / 0.646.
pub const WINDOW_BOOST: f64 = 0.1;
/// What a replaced turn's rank score gains under a question about what
/// held before. Measured on the curated large corpus under hash: at 0.25
/// recall@5 0.901 / nDCG@5 0.784, at 0.5 0.858 / 0.803, at 1.0 0.762 /
/// 0.792. Past a quarter the replaced turns of other facts start pushing
/// this fact's out of the top five. With `settle_ties` the 0.25 row is
/// 0.888 / 0.795.
pub const HISTORY_BOOST: f64 = 0.25;

/// How time enters the score.
///
/// The two clocks for the past scale the rank score instead of adding to
/// it. An added term lifts a turn the views barely nominated as far as one
/// they agreed on, and a question about the past has no recent view to make
/// that the point: on the large corpus the additive form cost as-of
/// questions recall@5 0.765 -> 0.704 for the same nDCG.
#[derive(Debug, Clone, Copy)]
pub enum Clock<'a> {
    /// Newer is better, measured from the newest turn in the store.
    Now { weight: f64, latest_ts: i64 },
    /// The question names a period. A turn was in force during it if it was
    /// said before the period ended and nothing replaced it before the
    /// period began; `valid_until` is when each replaced turn stopped
    /// holding. A turn in force is boosted, and the one said nearest the
    /// period's end most, because the latest word by then is what held. A turn
    /// from afterwards, or one already replaced, gains nothing but is not
    /// dropped: `when is the launch in March 2025` names the event's date,
    /// not the statement's. Without curation nothing is known to have been
    /// replaced, so this is "the latest statement not from afterwards".
    Window { window: Window, valid_until: &'a BTreeMap<i64, i64> },
    /// The question asks what held before the present value. A replaced
    /// turn is boosted, and of two the later one more: the value just
    /// before this one, not the first there ever was. Nothing else earns a
    /// recency term, since newest-first is the wrong way round here.
    History { valid_until: &'a BTreeMap<i64, i64>, latest_ts: i64 },
}

impl Clock<'_> {
    /// What breaks a tie between two candidates a view scored the same;
    /// higher first. `None` leaves the view's own order, newest first.
    fn preference(&self, id: i64, ts: i64) -> Option<(bool, i64)> {
        match *self {
            Clock::Now { .. } => None,
            Clock::Window { window, valid_until } => {
                let in_force = ts < window.end && valid_until.get(&id).is_none_or(|until| *until > window.start);
                Some((in_force, if in_force { ts } else { 0 }))
            }
            Clock::History { valid_until, .. } => {
                let replaced = valid_until.contains_key(&id);
                Some((replaced, if replaced { ts } else { 0 }))
            }
        }
    }

    fn score(&self, rank_part: f64, id: i64, ts: i64) -> f64 {
        match *self {
            Clock::Now { weight, latest_ts } => rank_part + weight * decay(ts, latest_ts),
            Clock::Window { window, valid_until } => {
                let in_force = ts < window.end && valid_until.get(&id).is_none_or(|until| *until > window.start);
                if in_force {
                    rank_part * (1.0 + WINDOW_BOOST + RECENCY_TEMPORAL * decay(ts, window.end))
                } else {
                    rank_part
                }
            }
            Clock::History { valid_until, latest_ts } => {
                if valid_until.contains_key(&id) {
                    rank_part * (1.0 + HISTORY_BOOST + RECENCY_TEMPORAL * decay(ts, latest_ts))
                } else {
                    rank_part
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Fused {
    pub id: i64,
    /// In `[0, 1 + recency]`, scaled up a little under a question about
    /// the past; rounded to 6 places so it is stable across platforms.
    pub score: f64,
    pub sources: Vec<ViewKind>,
    pub ts: i64,
    pub uuid: String,
}

/// Reorder each run of candidates the lexical view scored the same by what
/// the clock prefers. A view breaks its ties toward the newest turn, which
/// is right for a question about now and backwards for one about the past,
/// and an exact BM25 tie is the case that matters: a fact restated with only
/// its value changed. Done to the trace's views, so the order shown is the
/// order fused.
///
/// The other views are left alone. The entity view scores every mention of
/// the one entity a question names the same, so its whole list is a tie and
/// its order says nothing about the fact asked for.
pub fn settle_ties(views: &mut [ViewTrace], turns: &BTreeMap<i64, Turn>, clock: Clock<'_>) {
    const SAME: f64 = 1e-9;
    let preference = |id: i64| turns.get(&id).and_then(|t| clock.preference(id, t.ts));
    for view in views.iter_mut().filter(|v| v.view == ViewKind::Lexical) {
        let mut start = 0;
        while start < view.candidates.len() {
            let score = view.candidates[start].1;
            let len = view.candidates[start..].iter().take_while(|c| (c.1 - score).abs() < SAME).count();
            // Stable, so candidates the clock is indifferent to keep their order.
            view.candidates[start..start + len].sort_by_key(|c| std::cmp::Reverse(preference(c.0)));
            start += len;
        }
    }
}

pub fn fuse(views: &[ViewTrace], turns: &BTreeMap<i64, Turn>, clock: Clock<'_>) -> Vec<Fused> {
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
            let score = round6(clock.score(rank_part, id, turn.ts));
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
        let fused = fuse(&views, &turns, Clock::Now { weight: 0.0, latest_ts: 0 });
        assert_eq!(fused.iter().map(|f| f.id).collect::<Vec<_>>(), vec![2, 1, 3]);
        assert_eq!(fused[0].sources, vec![ViewKind::Lexical, ViewKind::Entity]);
        assert!(fused[0].score < 1.0 && fused[0].score > 0.9);
    }

    #[test]
    fn recency_breaks_ties_toward_the_newest() {
        let sixty_days = (2.0 * HALF_LIFE_MS) as i64;
        let turns: BTreeMap<i64, Turn> = [(1, turn(1, 0)), (2, turn(2, sixty_days))].into();
        let views = vec![ViewTrace { view: ViewKind::Entity, weight: 1.0, candidates: vec![(1, 1.0), (2, 1.0)] }];
        let fused = fuse(&views, &turns, Clock::Now { weight: 0.3, latest_ts: sixty_days });
        assert_eq!(fused[0].id, 2, "rank says 1 by a hair, recency says 2 by a lot");
        let tiebreak = fuse(&views, &turns, Clock::Now { weight: 0.02, latest_ts: sixty_days });
        assert_eq!(tiebreak[0].id, 1, "the tie-break weight does not overturn a rank difference");
    }

    /// Every turn first in a view of its own, so rank says nothing and only
    /// the clock orders them.
    fn level(ids: &[i64]) -> Vec<ViewTrace> {
        ids.iter().map(|id| ViewTrace { view: ViewKind::Lexical, weight: 1.0, candidates: vec![(*id, 1.0)] }).collect()
    }

    #[test]
    fn a_period_prefers_what_was_in_force_and_said_latest_by_then() {
        let day = 24 * 3600 * 1000;
        // 1 said on day 0 and replaced on day 40; 2 said on day 40; 3 said on day 90.
        let turns: BTreeMap<i64, Turn> = [(1, turn(1, 0)), (2, turn(2, 40 * day)), (3, turn(3, 90 * day))].into();
        let views = level(&[1, 2, 3]);
        let valid_until: BTreeMap<i64, i64> = [(1, 40 * day)].into();
        let ids = |window: Window, valid_until: &BTreeMap<i64, i64>| -> Vec<i64> {
            fuse(&views, &turns, Clock::Window { window, valid_until }).iter().map(|f| f.id).collect()
        };
        let then = Window { start: 50 * day, end: 80 * day };
        assert_eq!(ids(then, &valid_until), vec![2, 3, 1], "2 held then; 1 had been replaced; 3 came after");
        assert_eq!(ids(then, &BTreeMap::new()), vec![2, 1, 3], "with nothing replaced, the latest by then leads");
        let early = Window { start: 10 * day, end: 30 * day };
        assert_eq!(ids(early, &valid_until), vec![1, 3, 2], "only 1 had been said by then");
    }

    #[test]
    fn a_history_question_prefers_the_latest_replaced_turn() {
        let day = 24 * 3600 * 1000;
        let turns: BTreeMap<i64, Turn> = [(1, turn(1, 0)), (2, turn(2, 40 * day)), (3, turn(3, 90 * day))].into();
        let views = level(&[1, 2, 3]);
        let valid_until: BTreeMap<i64, i64> = [(1, 40 * day), (2, 90 * day)].into();
        let ids = |valid_until: &BTreeMap<i64, i64>| -> Vec<i64> {
            let clock = Clock::History { valid_until, latest_ts: 90 * day };
            fuse(&views, &turns, clock).iter().map(|f| f.id).collect()
        };
        assert_eq!(ids(&valid_until), vec![2, 1, 3], "the value just before the present one, then the one before it");
        assert_eq!(ids(&BTreeMap::new()), vec![3, 2, 1], "with nothing replaced, the tie goes to the newer as ever");
    }

    #[test]
    fn a_tie_inside_a_view_goes_to_what_the_clock_prefers() {
        let day = 24 * 3600 * 1000;
        let turns: BTreeMap<i64, Turn> = [(1, turn(1, 0)), (2, turn(2, 40 * day)), (3, turn(3, 90 * day))].into();
        // The view's own order: one clear winner, then a tie broken newest first.
        let tied = |view: ViewKind| {
            vec![ViewTrace { view, weight: 1.0, candidates: vec![(9, 2.0), (3, 1.0), (2, 1.0), (1, 1.0)] }]
        };
        let order = |clock: Clock<'_>| -> Vec<i64> {
            let mut views = tied(ViewKind::Lexical);
            settle_ties(&mut views, &turns, clock);
            views[0].candidates.iter().map(|c| c.0).collect()
        };
        let none = BTreeMap::new();
        assert_eq!(order(Clock::Now { weight: 0.3, latest_ts: 90 * day }), vec![9, 3, 2, 1]);
        let window = Window { start: 50 * day, end: 80 * day };
        assert_eq!(
            order(Clock::Window { window, valid_until: &none }),
            vec![9, 2, 1, 3],
            "a higher score is not a tie"
        );
        let replaced: BTreeMap<i64, i64> = [(1, 40 * day)].into();
        assert_eq!(order(Clock::Window { window, valid_until: &replaced }), vec![9, 2, 3, 1]);
        assert_eq!(order(Clock::History { valid_until: &replaced, latest_ts: 90 * day }), vec![9, 1, 3, 2]);

        let mut entity = tied(ViewKind::Entity);
        settle_ties(&mut entity, &turns, Clock::Window { window, valid_until: &none });
        assert_eq!(entity, tied(ViewKind::Entity), "every mention ties there, so that order is left alone");
    }

    #[test]
    fn filtered_turns_do_not_appear() {
        let turns: BTreeMap<i64, Turn> = [(1, turn(1, 0))].into();
        let views = vec![ViewTrace { view: ViewKind::Lexical, weight: 1.0, candidates: vec![(1, 9.0), (2, 8.0)] }];
        assert_eq!(fuse(&views, &turns, Clock::Now { weight: 0.0, latest_ts: 0 }).len(), 1);
    }
}
