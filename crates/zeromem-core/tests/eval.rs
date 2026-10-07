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
//!
//! The probes — questions about history, a point in time, and facts never
//! stated — are scored apart from the queries, with floors of their own, and
//! written to `target/eval/probes/`.

mod common;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use common::*;
use zeromem_core::curation::{CurationAction, CurationOp, CuratorConfig};
use zeromem_core::dense::remote::{RemoteSpec, DEFAULT_TIMEOUT_MS};
use zeromem_core::dense::{self, EmbedderChoice};
use zeromem_core::{Detail, OpenOptions, QueryOptions, ZeroMem};
use zeromem_harness::corpus::{Ask, Corpus, Profile, Query, LARGE, SMALL, TRANSCRIPT};
use zeromem_harness::eval::{self, Abstention, QueryScore, Summary};

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
/// in `entities` route through the entity view whole. The lexical index
/// still splits `heron::billing_service::flush` into the very words `who
/// owns the billing service on heron?` asks with, which is why the lexical
/// view discounts technical tokens for a question that names none.
///
/// Owner questions gained most from `profile::PREDICATE_FAMILIES`, whose
/// members include the generator's own three ownership phrasings. Those
/// numbers are the ceiling for that change, not what it earns on real
/// transcripts; `by_kind` in `target/eval/*.json` tracks the family.
const FLOORS: &[Floor] = &[
    Floor { profile: &SMALL, embedder: EmbedderChoice::Hash, recall_at_5: 0.95, mrr: 0.85, ndcg_at_5: 0.88 },
    Floor { profile: &LARGE, embedder: EmbedderChoice::Hash, recall_at_5: 0.84, mrr: 0.94, ndcg_at_5: 0.77 },
    Floor { profile: &SMALL, embedder: EmbedderChoice::Onnx, recall_at_5: 0.95, mrr: 0.90, ndcg_at_5: 0.90 },
    Floor { profile: &LARGE, embedder: EmbedderChoice::Onnx, recall_at_5: 0.93, mrr: 0.97, ndcg_at_5: 0.84 },
    Floor { profile: &TRANSCRIPT, embedder: EmbedderChoice::Hash, recall_at_5: 0.89, mrr: 0.94, ndcg_at_5: 0.82 },
    Floor { profile: &TRANSCRIPT, embedder: EmbedderChoice::Onnx, recall_at_5: 0.94, mrr: 0.97, ndcg_at_5: 0.87 },
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

/// One query's id, fact family and scores.
type Scored = (String, String, QueryScore);

/// Runs the labeled queries under one embedder; returns the metrics, the
/// per-query scores, the embedder's name as the store records it, and what
/// the evidence for one question costs to read, in estimated tokens.
fn run(
    profile: &Profile,
    embedder: EmbedderChoice,
    remote: Option<(RemoteSpec, Option<String>)>,
) -> (Summary, Vec<Scored>, String, f64) {
    run_corpus(profile.name, &corpus(profile), embedder, remote)
}

fn run_corpus(
    label: &str,
    corpus: &Corpus,
    embedder: EmbedderChoice,
    remote: Option<(RemoteSpec, Option<String>)>,
) -> (Summary, Vec<Scored>, String, f64) {
    let dir = tempfile::tempdir().unwrap();
    let (remote, api_key) = remote.map(|(s, k)| (Some(s), k)).unwrap_or((None, None));
    let mut zm =
        ZeroMem::open(dir.path(), OpenOptions { embedder, remote, api_key, ..OpenOptions::default() }).unwrap();
    zm.ingest_many(&inputs(corpus)).unwrap();
    let stats = zm.stats().unwrap();
    assert!(stats.embedder_active, "{}: embedder not active: {:?}", label, stats.embedder_warning);
    assert_eq!(stats.embedding_backlog, 0, "{}: turns left without a vector", label);
    let name = stats.embedder.unwrap();
    let mut per_query = Vec::new();
    let mut tokens = 0;
    let summary = eval::evaluate(&corpus.queries, 5, |q| {
        let opts = QueryOptions { top_k: Some(5), detail: Some(Detail::Compact), ..Default::default() };
        let result = zm.query(&q.query, &opts).unwrap();
        tokens += result.evidence.iter().map(|e| eval::estimate_tokens(&e.turn.text)).sum::<usize>();
        let ranked: Vec<String> = result.evidence.iter().map(|e| e.turn.uuid.clone()).collect();
        let s = eval::score(&ranked, &q.relevant, 5);
        per_query.push((q.id.clone(), q.kind.clone(), s));
        ranked
    });
    let tokens_per_answer = tokens as f64 / corpus.queries.len().max(1) as f64;
    (summary, per_query, name, tokens_per_answer)
}

/// The metrics split by fact family, so a family that falls behind shows
/// even when the mean holds.
fn by_kind(per_query: &[Scored]) -> BTreeMap<String, Summary> {
    let mut groups: BTreeMap<String, Vec<QueryScore>> = BTreeMap::new();
    for (_, kind, s) in per_query {
        groups.entry(kind.clone()).or_default().push(*s);
    }
    groups.into_iter().map(|(kind, scores)| (kind, eval::summarise(5, &scores))).collect()
}

fn write_results(
    profile: &Profile,
    embedder: &str,
    summary: &Summary,
    per_query: &[Scored],
    tokens_per_answer: Option<f64>,
) {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/eval");
    fs::create_dir_all(&dir).unwrap();
    let misses: Vec<&str> =
        per_query.iter().filter(|(_, _, s)| s.reciprocal_rank == 0.0).map(|(id, _, _)| id.as_str()).collect();
    let body = serde_json::json!({
        "profile": profile.name,
        "embedder": embedder,
        "summary": summary,
        "by_kind": by_kind(per_query),
        "missed": misses,
        "tokens_per_answer": tokens_per_answer,
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
        let (summary, per_query, _, tokens) = run(floor.profile, floor.embedder, None);
        write_results(floor.profile, name, &summary, &per_query, Some(tokens));
        let label = format!("{} / {name}", floor.profile.name);
        eprintln!(
            "{label}: recall@5 {:.3} mrr {:.3} ndcg@5 {:.3} over {} queries, {tokens:.0} tokens per answer",
            summary.recall_at_k, summary.mrr, summary.ndcg_at_k, summary.queries
        );
        for (kind, s) in by_kind(&per_query) {
            eprintln!(
                "  {kind:>8}: recall@5 {:.3} mrr {:.3} ndcg@5 {:.3} over {}",
                s.recall_at_k, s.mrr, s.ndcg_at_k, s.queries
            );
        }
        assert!(summary.recall_at_k >= floor.recall_at_5, "{label}: recall@5 {:.3}", summary.recall_at_k);
        assert!(summary.mrr >= floor.mrr, "{label}: mrr {:.3}", summary.mrr);
        assert!(summary.ndcg_at_k >= floor.ndcg_at_5, "{label}: ndcg@5 {:.3}", summary.ndcg_at_k);
    }
    if let Some(remote) = remote_from_env() {
        for profile in [&SMALL, &LARGE] {
            let (summary, per_query, name, tokens) = run(profile, EmbedderChoice::OpenAi, Some(remote.clone()));
            write_results(profile, &name, &summary, &per_query, Some(tokens));
            eprintln!(
                "{} / {name}: recall@5 {:.3} mrr {:.3} ndcg@5 {:.3} over {} queries (recorded, no floor)",
                profile.name, summary.recall_at_k, summary.mrr, summary.ndcg_at_k, summary.queries
            );
        }
    }
}

/// Supersede every turn the labels grade 1 by the latest turn they grade 2,
/// which is the best a curating agent could do with supersession alone.
/// Returns how many actions were applied.
fn apply_oracle(zm: &mut ZeroMem, corpus: &Corpus) -> u32 {
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
    zm.set_curator_config(&CuratorConfig { min_age_ms: 0, ..CuratorConfig::default() }).unwrap();
    let mut applied = 0;
    for (i, chunk) in actions.chunks(100).enumerate() {
        applied += zm.curate_apply(&format!("oracle-{i}"), "eval", chunk, false).unwrap().applied;
    }
    applied
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
            per_query.push((q.id.clone(), q.kind.clone(), eval::score(&ranked, &q.relevant, 5)));
            ranked
        });
        (summary, per_query)
    };
    let (before, _) = score(&mut zm);

    let applied = apply_oracle(&mut zm, &corpus);
    assert!(applied > 0, "the large corpus has superseded facts");
    let (after, per_query) = score(&mut zm);
    write_results(&LARGE, &format!("{name}+oracle-curator"), &after, &per_query, None);
    eprintln!(
        "large / {name}: ndcg@5 {:.3} -> {:.3}, mrr {:.3} -> {:.3}, recall@5 {:.3} -> {:.3} after {applied} supersessions",
        before.ndcg_at_k, after.ndcg_at_k, before.mrr, after.mrr, before.recall_at_k, after.recall_at_k
    );
    assert!(after.ndcg_at_k > before.ndcg_at_k, "ndcg@5 {:.3} -> {:.3}", before.ndcg_at_k, after.ndcg_at_k);
    assert!(after.mrr >= before.mrr - 0.01, "mrr {:.3} -> {:.3}", before.mrr, after.mrr);
}

struct ProbeFloor {
    profile: &'static Profile,
    ask: Ask,
    /// Whether the oracle curator has run: a point in time is only
    /// answerable from a store that records what replaced what.
    curated: bool,
    recall_at_5: f64,
    mrr: f64,
    ndcg_at_5: f64,
}

/// What recall does today with a question it was not built for, a little
/// under the measured numbers like `FLOORS`. These start low on purpose: they
/// are the baseline the temporal work has to raise, and nDCG is the one to
/// watch, since it alone tells the wanted value from the other ones.
///
/// The curated rows are the finding: once the oracle has superseded every
/// old value, `retrieve::hand_over` gives the old turn's place to its
/// replacement, so a question about the past is answered with the present
/// and nDCG falls by more than half. Supersession has to learn which
/// questions are about history before these rows can rise.
#[rustfmt::skip]
const PROBE_FLOORS: &[ProbeFloor] = &[
    ProbeFloor { profile: &LARGE, ask: Ask::History, curated: false, recall_at_5: 0.87, mrr: 0.94, ndcg_at_5: 0.66 },
    ProbeFloor { profile: &LARGE, ask: Ask::AsOf, curated: false, recall_at_5: 0.73, mrr: 0.83, ndcg_at_5: 0.55 },
    ProbeFloor { profile: &LARGE, ask: Ask::History, curated: true, recall_at_5: 0.51, mrr: 0.94, ndcg_at_5: 0.27 },
    ProbeFloor { profile: &LARGE, ask: Ask::AsOf, curated: true, recall_at_5: 0.44, mrr: 0.83, ndcg_at_5: 0.23 },
    ProbeFloor { profile: &TRANSCRIPT, ask: Ask::History, curated: false, recall_at_5: 0.88, mrr: 0.96, ndcg_at_5: 0.76 },
    ProbeFloor { profile: &TRANSCRIPT, ask: Ask::AsOf, curated: false, recall_at_5: 0.84, mrr: 0.91, ndcg_at_5: 0.73 },
    ProbeFloor { profile: &TRANSCRIPT, ask: Ask::History, curated: true, recall_at_5: 0.51, mrr: 0.96, ndcg_at_5: 0.32 },
    ProbeFloor { profile: &TRANSCRIPT, ask: Ask::AsOf, curated: true, recall_at_5: 0.53, mrr: 0.92, ndcg_at_5: 0.35 },
];

/// One ask's metrics over the probes, on the store as it stands.
fn score_probes(zm: &mut ZeroMem, probes: &[Query], ask: Ask) -> (Summary, Vec<Option<f64>>) {
    let mut scores = Vec::new();
    let mut best = Vec::new();
    for q in probes.iter().filter(|q| q.ask == ask) {
        let opts = QueryOptions { top_k: Some(5), detail: Some(Detail::Compact), ..Default::default() };
        let evidence = zm.query(&q.query, &opts).unwrap().evidence;
        best.push(evidence.first().map(|e| e.score));
        let ranked: Vec<String> = evidence.into_iter().map(|e| e.turn.uuid).collect();
        scores.push(eval::score(&ranked, &q.relevant, 5));
    }
    (eval::summarise(5, &scores), best)
}

/// The probes, hash embedder only: history and as-of questions before and
/// after the oracle curator, and how well the top score tells a question
/// the corpus answers from one it does not. Abstention is recorded, never
/// gated — confidence is relative to the best hit, so recall has no way to
/// say "nothing" yet, and the number is here so that shows.
#[test]
fn probes_clear_their_floors() {
    for profile in [&SMALL, &LARGE, &TRANSCRIPT] {
        let corpus = corpus(profile);
        let dir = tempfile::tempdir().unwrap();
        let mut zm =
            ZeroMem::open(dir.path(), OpenOptions { embedder: EmbedderChoice::Hash, ..OpenOptions::default() })
                .unwrap();
        zm.ingest_many(&inputs(&corpus)).unwrap();
        let name = zm.stats().unwrap().embedder.unwrap();

        let (_, answerable) = score_probes(&mut zm, &corpus.queries, Ask::Current);
        let (_, unanswerable) = score_probes(&mut zm, &corpus.probes, Ask::Abstain);
        let abstention: Abstention = eval::abstention(&answerable, &unanswerable);

        let mut by_ask: BTreeMap<String, Summary> = BTreeMap::new();
        for curated in [false, true] {
            if curated {
                zm.set_curator_config(&CuratorConfig { min_age_ms: 0, ..CuratorConfig::default() }).unwrap();
                apply_oracle(&mut zm, &corpus);
            }
            for ask in [Ask::History, Ask::AsOf] {
                let (summary, _) = score_probes(&mut zm, &corpus.probes, ask);
                let label = format!("{}{}", ask.name(), if curated { "+oracle-curator" } else { "" });
                eprintln!(
                    "{} / {name} {label:>24}: recall@5 {:.3} mrr {:.3} ndcg@5 {:.3} over {}",
                    profile.name, summary.recall_at_k, summary.mrr, summary.ndcg_at_k, summary.queries
                );
                for floor in PROBE_FLOORS {
                    if floor.profile.name != profile.name || floor.ask != ask || floor.curated != curated {
                        continue;
                    }
                    let at = format!("{} / {name} {label}", profile.name);
                    assert!(summary.recall_at_k >= floor.recall_at_5, "{at}: recall@5 {:.3}", summary.recall_at_k);
                    assert!(summary.mrr >= floor.mrr, "{at}: mrr {:.3}", summary.mrr);
                    assert!(summary.ndcg_at_k >= floor.ndcg_at_5, "{at}: ndcg@5 {:.3}", summary.ndcg_at_k);
                }
                by_ask.insert(label, summary);
            }
        }
        eprintln!(
            "{} / {name} {:>24}: {:.3} answered of {}, auc {:.3} (recorded, no floor)",
            profile.name, "abstain", abstention.answered, abstention.queries, abstention.auc
        );

        let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/eval/probes");
        fs::create_dir_all(&out).unwrap();
        let body = serde_json::json!({
            "profile": profile.name,
            "embedder": name,
            "by_ask": by_ask,
            "abstention": abstention,
        });
        fs::write(out.join(format!("{}-{name}.json", profile.name)), serde_json::to_string_pretty(&body).unwrap())
            .unwrap();
    }
}

/// Score a corpus from outside the repo: `ZEROMEM_EVAL_CORPUS` names a
/// directory holding `turns.jsonl` and `queries.jsonl`, as
/// `zm-harness import` writes them. Recorded under `target/eval/external/`
/// and never gated: the labels are someone else's, and so is the licence.
#[test]
fn an_external_corpus_is_scored_when_named() {
    let Some(dir) = std::env::var_os("ZEROMEM_EVAL_CORPUS").map(PathBuf::from) else { return };
    let corpus = zeromem_harness::fixtures::load_dir(&dir).unwrap();
    let label = dir.file_name().and_then(|n| n.to_str()).unwrap_or("external").to_string();
    let (summary, per_query, name, tokens) = run_corpus(&label, &corpus, EmbedderChoice::Hash, None);
    eprintln!(
        "{label} / {name}: recall@5 {:.3} mrr {:.3} ndcg@5 {:.3} over {} queries, {tokens:.0} tokens per answer (recorded, no floor)",
        summary.recall_at_k, summary.mrr, summary.ndcg_at_k, summary.queries
    );
    for (kind, s) in by_kind(&per_query) {
        eprintln!(
            "  {kind:>26}: recall@5 {:.3} mrr {:.3} ndcg@5 {:.3} over {}",
            s.recall_at_k, s.mrr, s.ndcg_at_k, s.queries
        );
    }
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/eval/external");
    fs::create_dir_all(&out).unwrap();
    let body = serde_json::json!({
        "corpus": label,
        "embedder": name,
        "turns": corpus.turns.len(),
        "summary": summary,
        "by_kind": by_kind(&per_query),
        "tokens_per_answer": tokens,
    });
    fs::write(out.join(format!("{label}-{name}.json")), serde_json::to_string_pretty(&body).unwrap()).unwrap();
}
