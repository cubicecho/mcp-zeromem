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

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use common::*;
use zeromem_core::curation::{CurationAction, CurationOp, CuratorConfig};
use zeromem_core::dense::remote::{RemoteSpec, DEFAULT_TIMEOUT_MS};
use zeromem_core::dense::{self, EmbedderChoice};
use zeromem_core::{Detail, OpenOptions, QueryOptions, ZeroMem};
use zeromem_harness::corpus::{Profile, LARGE, SMALL, TRANSCRIPT};
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
///
/// `transcript` is the same facts written the way a real session is: mostly
/// lowercase, paths and `::` symbols and env vars as typed, and each name
/// capitalised only some of the time. So the store learns a key from the
/// capitalised third of its mentions and the shape rules then find it in
/// none of the questions — the asymmetry `retrieve::resolve_known_entities`
/// exists to close, and the reason this profile is worth its fixtures. Its
/// document side stays lossy either way (two mentions in three are missed),
/// which is what an extractor change would have to fix and why these rows
/// sit below `large`'s.
///
/// A third of its questions name a technical token (`what is
/// HERON_BILLING_SERVICE_URL set to?`), which the path, symbol and env kinds
/// in `entities` route through the entity view whole. What they still cost
/// is the owner questions: the lexical index splits
/// `heron::billing_service::flush` into the very words `who owns the billing
/// service on heron?` asks with.
const FLOORS: &[Floor] = &[
    Floor { profile: &SMALL, embedder: EmbedderChoice::Hash, recall_at_5: 0.95, mrr: 0.85, ndcg_at_5: 0.88 },
    Floor { profile: &LARGE, embedder: EmbedderChoice::Hash, recall_at_5: 0.70, mrr: 0.88, ndcg_at_5: 0.65 },
    Floor { profile: &SMALL, embedder: EmbedderChoice::Onnx, recall_at_5: 0.95, mrr: 0.90, ndcg_at_5: 0.90 },
    Floor { profile: &LARGE, embedder: EmbedderChoice::Onnx, recall_at_5: 0.87, mrr: 0.95, ndcg_at_5: 0.78 },
    Floor { profile: &TRANSCRIPT, embedder: EmbedderChoice::Hash, recall_at_5: 0.79, mrr: 0.87, ndcg_at_5: 0.74 },
    Floor { profile: &TRANSCRIPT, embedder: EmbedderChoice::Onnx, recall_at_5: 0.87, mrr: 0.91, ndcg_at_5: 0.80 },
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

/// An oracle curator: it knows the labels, so for every query it marks the
/// turns stating a superseded value (grade 1) as superseded by one stating
/// the current value (grade 2). This is the best a curating agent could do
/// with supersession alone. nDCG, which grades the current value above the
/// old, must rise and MRR must hold. Recall is recorded, not gated: it
/// counts a superseded turn as a hit, and folding those under their
/// replacement is the point.
#[test]
fn an_oracle_curator_does_not_hurt_recall() {
    let corpus = corpus(&LARGE);
    let dir = tempfile::tempdir().unwrap();
    let mut zm =
        ZeroMem::open(dir.path(), OpenOptions { embedder: EmbedderChoice::Hash, ..OpenOptions::default() }).unwrap();
    zm.ingest_many(&inputs(&corpus)).unwrap();
    let name = zm.stats().unwrap().embedder.unwrap();

    let score = |zm: &mut ZeroMem| {
        let mut per_query = Vec::new();
        let summary = eval::evaluate(&corpus.queries, 5, |q| {
            let opts = QueryOptions { top_k: Some(5), detail: Some(Detail::Compact), ..Default::default() };
            let ranked: Vec<String> =
                zm.query(&q.query, &opts).unwrap().evidence.into_iter().map(|e| e.turn.uuid).collect();
            per_query.push((q.id.clone(), eval::score(&ranked, &q.relevant, 5).reciprocal_rank));
            ranked
        });
        (summary, per_query)
    };
    let (before, _) = score(&mut zm);

    let ids: HashMap<String, i64> = zm.snapshot().unwrap().turns.into_iter().map(|t| (t.uuid, t.id)).collect();
    let current: HashSet<&str> =
        corpus.queries.iter().flat_map(|q| &q.relevant).filter(|r| r.grade == 2).map(|r| r.uuid.as_str()).collect();
    let mut seen = HashSet::new();
    let mut actions = Vec::new();
    for q in &corpus.queries {
        // The latest grade-2 turn is the replacement; ids follow ingest order.
        let Some(by) = q.relevant.iter().filter(|r| r.grade == 2).map(|r| ids[&r.uuid]).max() else { continue };
        let old: Vec<i64> = q
            .relevant
            .iter()
            .filter(|r| r.grade == 1 && !current.contains(r.uuid.as_str()) && seen.insert(r.uuid.clone()))
            .map(|r| ids[&r.uuid])
            .collect();
        if !old.is_empty() {
            actions.push(CurationAction {
                op: CurationOp::Supersede { turn_ids: old, by },
                reason: format!("oracle: {}", q.id),
            });
        }
    }
    assert!(!actions.is_empty(), "the large corpus has superseded facts");
    zm.set_curator_config(&CuratorConfig { min_age_ms: 0, ..CuratorConfig::default() }).unwrap();
    let mut applied = 0;
    for (i, chunk) in actions.chunks(100).enumerate() {
        applied += zm.curate_apply(&format!("oracle-{i}"), "eval", chunk, false).unwrap().applied;
    }
    let (after, per_query) = score(&mut zm);
    write_results(&LARGE, &format!("{name}+oracle-curator"), &after, &per_query);
    eprintln!(
        "large / {name}: ndcg@5 {:.3} -> {:.3}, mrr {:.3} -> {:.3}, recall@5 {:.3} -> {:.3} after {applied} supersessions",
        before.ndcg_at_k, after.ndcg_at_k, before.mrr, after.mrr, before.recall_at_k, after.recall_at_k
    );
    assert!(after.ndcg_at_k > before.ndcg_at_k, "ndcg@5 {:.3} -> {:.3}", before.ndcg_at_k, after.ndcg_at_k);
    assert!(after.mrr >= before.mrr - 0.01, "mrr {:.3} -> {:.3}", before.mrr, after.mrr);
}
