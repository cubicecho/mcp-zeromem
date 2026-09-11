//! Comparing two rankers over the same labeled queries.
//!
//! The upstream project is a black box to this repo: it is only ever run as
//! a binary. What can be compared is the ranked list each side returns for
//! each labeled query — one JSON object per line, `{"id", "ranked": [uuid,
//! …]}` — and this module scores those lists against the labels (the quality
//! gate) and against each other (overlap and rank agreement, tracked so an
//! *unintended* divergence is visible, never gated on).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::corpus::Query;
use crate::eval::{self, Summary};

/// One ranker's answer to one labeled query.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ranked {
    pub id: String,
    pub ranked: Vec<String>,
}

/// How two rankers relate over a query set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Comparison {
    pub k: usize,
    /// Queries both sides answered; only these are compared.
    pub queries: usize,
    pub left: Summary,
    pub right: Summary,
    /// Mean |top-k(left) ∩ top-k(right)| over the longer of the two top-k
    /// lists, so two identical short lists score 1.
    pub overlap_at_k: f64,
    /// Mean Spearman correlation of the ranks of items in both top-k lists,
    /// over the queries where at least two items are shared. `None` when no
    /// query shares two.
    pub spearman: Option<f64>,
    pub spearman_queries: usize,
}

/// Fraction of the longer top-`k` list that the two lists share. A ranker
/// may return fewer than `k` items (calibration drops weak ones), and two
/// identical short lists should still score 1.
pub fn overlap_at_k(left: &[String], right: &[String], k: usize) -> f64 {
    let left_top: Vec<&String> = left.iter().take(k).collect();
    let right_top: Vec<&String> = right.iter().take(k).collect();
    let longest = left_top.len().max(right_top.len());
    if longest == 0 {
        return 1.0;
    }
    let shared = left_top.iter().filter(|u| right_top.contains(u)).count();
    shared as f64 / longest as f64
}

/// Spearman's rho over the items both top-`k` lists contain, by their rank
/// in each list. `None` unless at least two items are shared.
pub fn spearman(left: &[String], right: &[String], k: usize) -> Option<f64> {
    let right_rank: HashMap<&String, f64> = right.iter().take(k).enumerate().map(|(i, u)| (u, i as f64)).collect();
    let pairs: Vec<(f64, f64)> =
        left.iter().take(k).enumerate().filter_map(|(i, u)| right_rank.get(u).map(|r| (i as f64, *r))).collect();
    if pairs.len() < 2 {
        return None;
    }
    // The shared items' ranks are not 0..n on either side, so this is the
    // Pearson correlation of the two rank vectors, which is what Spearman
    // reduces to.
    let n = pairs.len() as f64;
    let (mx, my) = (pairs.iter().map(|p| p.0).sum::<f64>() / n, pairs.iter().map(|p| p.1).sum::<f64>() / n);
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for (x, y) in &pairs {
        sxy += (x - mx) * (y - my);
        sxx += (x - mx) * (x - mx);
        syy += (y - my) * (y - my);
    }
    if sxx == 0.0 || syy == 0.0 {
        // Every shared item sits at the same rank on one side; the lists
        // agree perfectly on what little they share.
        return Some(1.0);
    }
    Some(sxy / (sxx * syy).sqrt())
}

/// Score both sides against the labels and against each other. Queries
/// missing from either side are left out of everything.
pub fn compare(queries: &[Query], left: &[Ranked], right: &[Ranked], k: usize) -> Comparison {
    let by_id = |side: &[Ranked]| -> HashMap<String, Vec<String>> {
        side.iter().map(|r| (r.id.clone(), r.ranked.clone())).collect()
    };
    let (left, right) = (by_id(left), by_id(right));
    let shared: Vec<&Query> =
        queries.iter().filter(|q| left.contains_key(&q.id) && right.contains_key(&q.id)).collect();
    let owned: Vec<Query> = shared.iter().map(|q| (*q).clone()).collect();
    let left_summary = eval::evaluate(&owned, k, |q| left[&q.id].clone());
    let right_summary = eval::evaluate(&owned, k, |q| right[&q.id].clone());
    let mut overlap = 0.0;
    let mut rho_sum = 0.0;
    let mut rho_n = 0usize;
    for q in &shared {
        let (l, r) = (&left[&q.id], &right[&q.id]);
        overlap += overlap_at_k(l, r, k);
        if let Some(rho) = spearman(l, r, k) {
            rho_sum += rho;
            rho_n += 1;
        }
    }
    Comparison {
        k,
        queries: shared.len(),
        left: left_summary,
        right: right_summary,
        overlap_at_k: overlap / shared.len().max(1) as f64,
        spearman: (rho_n > 0).then(|| rho_sum / rho_n as f64),
        spearman_queries: rho_n,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::corpus::Relevance;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn overlap_counts_shared_items_within_k() {
        assert_eq!(overlap_at_k(&ids(&["a", "b", "c"]), &ids(&["c", "a", "x"]), 3), 2.0 / 3.0);
        assert_eq!(overlap_at_k(&ids(&["a", "b", "c"]), &ids(&["c", "a", "x"]), 1), 0.0);
        assert_eq!(overlap_at_k(&ids(&[]), &ids(&["c"]), 2), 0.0);
        assert_eq!(overlap_at_k(&ids(&["a"]), &ids(&["a"]), 5), 1.0);
        assert_eq!(overlap_at_k(&ids(&[]), &ids(&[]), 5), 1.0);
    }

    #[test]
    fn spearman_is_one_for_agreement_and_minus_one_for_reversal() {
        let l = ids(&["a", "b", "c", "d"]);
        assert_eq!(spearman(&l, &l, 4), Some(1.0));
        let reversed = ids(&["d", "c", "b", "a"]);
        assert!((spearman(&l, &reversed, 4).unwrap() + 1.0).abs() < 1e-12);
        assert_eq!(spearman(&l, &ids(&["a", "x"]), 4), None);
    }

    #[test]
    fn compare_scores_only_the_queries_both_sides_answered() {
        let queries = vec![
            Query {
                id: "q1".into(),
                kind: "owner".into(),
                query: "who".into(),
                latest_session_id: "s".into(),
                relevant: vec![Relevance { uuid: "a".into(), grade: 2 }],
            },
            Query {
                id: "q2".into(),
                kind: "owner".into(),
                query: "what".into(),
                latest_session_id: "s".into(),
                relevant: vec![Relevance { uuid: "b".into(), grade: 2 }],
            },
        ];
        let left =
            vec![Ranked { id: "q1".into(), ranked: ids(&["a", "b"]) }, Ranked { id: "q2".into(), ranked: ids(&["b"]) }];
        let right = vec![Ranked { id: "q1".into(), ranked: ids(&["b", "a"]) }];
        let c = compare(&queries, &left, &right, 2);
        assert_eq!(c.queries, 1);
        assert_eq!(c.left.mrr, 1.0);
        assert_eq!(c.right.mrr, 0.5);
        assert_eq!(c.overlap_at_k, 1.0);
        assert!((c.spearman.unwrap() + 1.0).abs() < 1e-12);
    }
}
