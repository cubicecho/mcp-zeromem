//! Ranking metrics over the labeled queries.
//!
//! A ranked result is a list of turn uuids, best first. Labels are graded:
//! 2 for a turn that states the fact's current value, 1 for a superseded
//! one, absent for everything else. Recall and MRR treat any positive grade
//! as relevant; nDCG uses the grade. Recall@k is normalised by
//! `min(k, relevant)`, so a query with more relevant turns than `k` can
//! still score 1.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::corpus::{Query, Relevance};

/// Metrics for one query at one cutoff.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct QueryScore {
    pub recall: f64,
    pub reciprocal_rank: f64,
    pub ndcg: f64,
}

/// Means over a query set, plus how many queries fed them.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    pub k: usize,
    pub queries: usize,
    pub recall_at_k: f64,
    pub mrr: f64,
    pub ndcg_at_k: f64,
}

/// Score a ranked list of uuids against one query's labels at cutoff `k`.
pub fn score(ranked: &[String], relevant: &[Relevance], k: usize) -> QueryScore {
    let grades: HashMap<&str, u8> = relevant.iter().map(|r| (r.uuid.as_str(), r.grade)).collect();
    let top: Vec<&str> = ranked.iter().take(k).map(String::as_str).collect();

    let hits = top.iter().filter(|u| grades.contains_key(*u)).count();
    // A fact restated twenty times has twenty relevant turns; asking for
    // all of them in the top five is asking the wrong question. Recall is
    // therefore over the number that could have fit.
    let reachable = grades.len().min(k);
    let recall = if reachable == 0 { 0.0 } else { hits as f64 / reachable as f64 };

    let reciprocal_rank = top.iter().position(|u| grades.contains_key(u)).map_or(0.0, |i| 1.0 / (i as f64 + 1.0));

    let dcg: f64 =
        top.iter().enumerate().map(|(i, u)| gain(grades.get(u).copied().unwrap_or(0)) / ((i + 2) as f64).log2()).sum();
    let mut ideal: Vec<u8> = grades.values().copied().collect();
    ideal.sort_unstable_by(|a, b| b.cmp(a));
    let idcg: f64 = ideal.iter().take(k).enumerate().map(|(i, g)| gain(*g) / ((i + 2) as f64).log2()).sum();
    let ndcg = if idcg == 0.0 { 0.0 } else { dcg / idcg };

    QueryScore { recall, reciprocal_rank, ndcg }
}

fn gain(grade: u8) -> f64 {
    (2f64).powi(i32::from(grade)) - 1.0
}

/// Score every query with `run` producing its ranked uuids, and average.
pub fn evaluate<F>(queries: &[Query], k: usize, mut run: F) -> Summary
where
    F: FnMut(&Query) -> Vec<String>,
{
    let scores: Vec<QueryScore> = queries.iter().map(|q| score(&run(q), &q.relevant, k)).collect();
    summarise(k, &scores)
}

/// Average already-scored queries, so a caller can split one run by fact
/// family without ranking it twice.
pub fn summarise(k: usize, scores: &[QueryScore]) -> Summary {
    let mut sum = QueryScore { recall: 0.0, reciprocal_rank: 0.0, ndcg: 0.0 };
    for s in scores {
        sum.recall += s.recall;
        sum.reciprocal_rank += s.reciprocal_rank;
        sum.ndcg += s.ndcg;
    }
    let n = scores.len().max(1) as f64;
    Summary {
        k,
        queries: scores.len(),
        recall_at_k: sum.recall / n,
        mrr: sum.reciprocal_rank / n,
        ndcg_at_k: sum.ndcg / n,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(pairs: &[(&str, u8)]) -> Vec<Relevance> {
        pairs.iter().map(|(u, g)| Relevance { uuid: (*u).into(), grade: *g }).collect()
    }

    fn ranked(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn perfect_ranking_scores_one() {
        let s = score(&ranked(&["a", "b", "c"]), &rel(&[("a", 2), ("b", 1)]), 5);
        assert_eq!(s, QueryScore { recall: 1.0, reciprocal_rank: 1.0, ndcg: 1.0 });
    }

    #[test]
    fn miss_scores_zero() {
        let s = score(&ranked(&["x", "y"]), &rel(&[("a", 2)]), 5);
        assert_eq!(s, QueryScore { recall: 0.0, reciprocal_rank: 0.0, ndcg: 0.0 });
    }

    #[test]
    fn cutoff_is_respected() {
        let s = score(&ranked(&["x", "y", "a"]), &rel(&[("a", 2)]), 2);
        assert_eq!(s.recall, 0.0);
        let s = score(&ranked(&["x", "y", "a"]), &rel(&[("a", 2)]), 3);
        assert_eq!(s.recall, 1.0);
        assert!((s.reciprocal_rank - 1.0 / 3.0).abs() < 1e-12);
    }

    #[test]
    fn ndcg_prefers_the_current_value_first() {
        let labels = rel(&[("current", 2), ("old", 1)]);
        let good = score(&ranked(&["current", "old"]), &labels, 5).ndcg;
        let worse = score(&ranked(&["old", "current"]), &labels, 5).ndcg;
        assert_eq!(good, 1.0);
        assert!(worse < good && worse > 0.5, "{worse}");
    }

    #[test]
    fn recall_is_over_what_could_fit() {
        let labels = rel(&[("a", 2), ("b", 1), ("c", 1), ("d", 1)]);
        assert_eq!(score(&ranked(&["a", "b"]), &labels, 2).recall, 1.0);
        assert_eq!(score(&ranked(&["a", "x"]), &labels, 2).recall, 0.5);
        assert_eq!(score(&ranked(&["a", "b"]), &labels, 5).recall, 0.5);
    }

    #[test]
    fn partial_recall_counts_hits() {
        let s = score(&ranked(&["a", "x"]), &rel(&[("a", 2), ("b", 2)]), 5);
        assert_eq!(s.recall, 0.5);
        assert_eq!(s.reciprocal_rank, 1.0);
    }

    #[test]
    fn evaluate_averages_over_queries() {
        let queries = vec![
            Query {
                id: "q1".into(),
                kind: "owner".into(),
                query: "?".into(),
                latest_session_id: "s".into(),
                relevant: rel(&[("a", 2)]),
            },
            Query {
                id: "q2".into(),
                kind: "owner".into(),
                query: "?".into(),
                latest_session_id: "s".into(),
                relevant: rel(&[("b", 2)]),
            },
        ];
        let summary = evaluate(&queries, 3, |q| if q.id == "q1" { ranked(&["a"]) } else { ranked(&["z"]) });
        assert_eq!(summary.queries, 2);
        assert_eq!(summary.recall_at_k, 0.5);
        assert_eq!(summary.mrr, 0.5);
        assert_eq!(summary.ndcg_at_k, 0.5);
    }
}
