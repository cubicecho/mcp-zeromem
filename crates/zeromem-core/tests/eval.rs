//! The quality gate: retrieval metrics over the labeled corpora.
//!
//! Every query in the fixtures names the turns that answer it, graded 2 for
//! the current value and 1 for a superseded one. The engine runs each query
//! with the hash embedder (deterministic, offline) and the floors below
//! must hold. The full numbers are written to `target/eval/<profile>.json`
//! so a change in ranking shows as a diff in CI logs, not only as a
//! pass/fail. With `ZEROMEM_EMBEDDING_URL` and `ZEROMEM_EMBEDDING_MODEL`
//! set, an OpenAI-compatible endpoint is scored too — recorded, never gated,
//! so `scripts/record-eval.sh` gives an operator's own model a line on the
//! Eval page. CI never sets them.

mod common;

use std::fs;
use std::path::PathBuf;

use common::*;
use zeromem_core::dense::remote::{RemoteSpec, DEFAULT_TIMEOUT_MS};
use zeromem_core::dense::{self, EmbedderChoice};
use zeromem_core::{Detail, OpenOptions, QueryOptions, ZeroMem};
use zeromem_harness::corpus::{Profile, LARGE, SMALL};
use zeromem_harness::eval::{self, Summary};

struct Floor {
    profile: &'static Profile,
    embedder: EmbedderChoice,
    recall_at_5: f64,
    mrr: f64,
    ndcg_at_5: f64,
}

/// Floors are set a little under the measured numbers so an unrelated
/// change does not trip them, but a real regression does. Raise them when
/// retrieval improves; never lower them without saying why in the commit.
/// The ONNX rows run unless `ZEROMEM_SKIP_ONNX` is set (see
/// `reference_vectors.rs` for where the model comes from).
const FLOORS: &[Floor] = &[
    Floor { profile: &SMALL, embedder: EmbedderChoice::Hash, recall_at_5: 0.85, mrr: 0.75, ndcg_at_5: 0.75 },
    Floor { profile: &LARGE, embedder: EmbedderChoice::Hash, recall_at_5: 0.65, mrr: 0.80, ndcg_at_5: 0.60 },
    Floor { profile: &SMALL, embedder: EmbedderChoice::Onnx, recall_at_5: 0.85, mrr: 0.85, ndcg_at_5: 0.85 },
    Floor { profile: &LARGE, embedder: EmbedderChoice::Onnx, recall_at_5: 0.85, mrr: 0.95, ndcg_at_5: 0.78 },
];

fn embedder_name(choice: EmbedderChoice) -> &'static str {
    match choice {
        EmbedderChoice::Onnx => dense::ONNX_NAME,
        _ => dense::HASH_NAME,
    }
}

/// The endpoint named by `ZEROMEM_EMBEDDING_URL` / `ZEROMEM_EMBEDDING_MODEL`,
/// with the optional key, prefixes and timeout the CLI and server also read.
fn remote_from_env() -> Option<(RemoteSpec, Option<String>)> {
    let env = |key: &str| std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let url = env("ZEROMEM_EMBEDDING_URL")?;
    let model = env("ZEROMEM_EMBEDDING_MODEL")?;
    let spec = RemoteSpec {
        url,
        model,
        query_prefix: env("ZEROMEM_EMBEDDING_QUERY_PREFIX").unwrap_or_default(),
        document_prefix: env("ZEROMEM_EMBEDDING_DOCUMENT_PREFIX").unwrap_or_default(),
        timeout_ms: env("ZEROMEM_EMBEDDING_TIMEOUT_MS").and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_TIMEOUT_MS),
        ..RemoteSpec::default()
    };
    Some((spec, env("ZEROMEM_EMBEDDING_API_KEY")))
}

/// Runs the labeled queries under one embedder; returns the metrics, the
/// per-query reciprocal ranks and the embedder's name as the store records it.
fn run(
    profile: &Profile,
    embedder: EmbedderChoice,
    remote: Option<(RemoteSpec, Option<String>)>,
) -> (Summary, Vec<(String, f64)>, String) {
    let corpus = corpus(profile);
    let dir = tempfile::tempdir().unwrap();
    let (remote, api_key) = remote.map(|(s, k)| (Some(s), k)).unwrap_or((None, None));
    let mut zm =
        ZeroMem::open(dir.path(), OpenOptions { embedder, remote, api_key, ..OpenOptions::default() }).unwrap();
    zm.ingest_many(&inputs(&corpus)).unwrap();
    let stats = zm.stats().unwrap();
    assert!(stats.embedder_active, "{}: embedder not active: {:?}", profile.name, stats.embedder_warning);
    assert_eq!(stats.embedding_backlog, 0, "{}: turns left without a vector", profile.name);
    let name = stats.embedder.unwrap();
    let mut per_query = Vec::new();
    let summary = eval::evaluate(&corpus.queries, 5, |q| {
        let opts = QueryOptions { top_k: Some(5), detail: Some(Detail::Compact), ..Default::default() };
        let result = zm.query(&q.query, &opts).unwrap();
        let ranked: Vec<String> = result.evidence.iter().map(|e| e.turn.uuid.clone()).collect();
        let s = eval::score(&ranked, &q.relevant, 5);
        per_query.push((q.id.clone(), s.reciprocal_rank));
        ranked
    });
    (summary, per_query, name)
}

fn write_results(profile: &Profile, embedder: &str, summary: &Summary, per_query: &[(String, f64)]) {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/eval");
    fs::create_dir_all(&dir).unwrap();
    let misses: Vec<&str> = per_query.iter().filter(|(_, rr)| *rr == 0.0).map(|(id, _)| id.as_str()).collect();
    let body = serde_json::json!({
        "profile": profile.name,
        "embedder": embedder,
        "summary": summary,
        "missed": misses,
    });
    let file = dir.join(format!("{}-{}.json", profile.name, embedder));
    fs::write(file, serde_json::to_string_pretty(&body).unwrap()).unwrap();
}

#[test]
fn retrieval_clears_the_floors() {
    let skip_onnx = std::env::var_os("ZEROMEM_SKIP_ONNX").is_some();
    if !skip_onnx && std::env::var_os(dense::MODELS_ENV).is_none() {
        // One cache for every test that loads the model. This binary has a
        // single test, so setting the environment here races with nothing.
        let cache = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/models");
        std::env::set_var(dense::MODELS_ENV, cache);
    }
    for floor in FLOORS {
        let name = embedder_name(floor.embedder);
        if floor.embedder == EmbedderChoice::Onnx && skip_onnx {
            eprintln!("{} / {name}: skipped (ZEROMEM_SKIP_ONNX)", floor.profile.name);
            continue;
        }
        let (summary, per_query, _) = run(floor.profile, floor.embedder, None);
        write_results(floor.profile, name, &summary, &per_query);
        let label = format!("{} / {name}", floor.profile.name);
        eprintln!(
            "{label}: recall@5 {:.3} mrr {:.3} ndcg@5 {:.3} over {} queries",
            summary.recall_at_k, summary.mrr, summary.ndcg_at_k, summary.queries
        );
        assert!(summary.recall_at_k >= floor.recall_at_5, "{label}: recall@5 {:.3}", summary.recall_at_k);
        assert!(summary.mrr >= floor.mrr, "{label}: mrr {:.3}", summary.mrr);
        assert!(summary.ndcg_at_k >= floor.ndcg_at_5, "{label}: ndcg@5 {:.3}", summary.ndcg_at_k);
    }
    if let Some(remote) = remote_from_env() {
        for profile in [&SMALL, &LARGE] {
            let (summary, per_query, name) = run(profile, EmbedderChoice::OpenAi, Some(remote.clone()));
            write_results(profile, &name, &summary, &per_query);
            eprintln!(
                "{} / {name}: recall@5 {:.3} mrr {:.3} ndcg@5 {:.3} over {} queries (recorded, no floor)",
                profile.name, summary.recall_at_k, summary.mrr, summary.ndcg_at_k, summary.queries
            );
        }
    }
}
