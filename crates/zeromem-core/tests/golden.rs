//! Golden retrieval snapshots over the small corpus.
//!
//! Every labeled query is run with the hash embedder and the full result
//! (route, evidence ids, scores, roles, sources) is compared with the
//! committed JSON. A ranking change, intended or not, shows up as a diff
//! here; `UPDATE_GOLDEN=1 cargo test --test golden` rewrites the file once
//! the change is understood.

mod common;

use std::fs;
use std::path::PathBuf;

use common::*;
use zeromem_core::{Detail, QueryOptions, QueryResult};

fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/small.json")
}

/// The parts of a result that must not drift. `took_ms` is left out.
fn stable(mut r: QueryResult) -> serde_json::Value {
    r.took_ms = 0;
    serde_json::to_value(r).unwrap()
}

#[test]
fn small_corpus_results_match_the_golden_file() {
    let corpus = small();
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&inputs(&corpus)).unwrap();

    let mut results = serde_json::Map::new();
    for q in &corpus.queries {
        let opts = QueryOptions { top_k: Some(5), detail: Some(Detail::Full), ..Default::default() };
        results.insert(q.id.clone(), stable(zm.query(&q.query, &opts).unwrap()));
    }
    // One of each option, so their effect is pinned too.
    let q = &corpus.queries[0];
    let session = corpus.turns[0].session_id.clone();
    let mid = corpus.turns[corpus.turns.len() / 2].ts;
    let cases = [
        (
            "exclude_session",
            QueryOptions { exclude_session: Some(session.clone()), detail: Some(Detail::Full), ..Default::default() },
        ),
        ("session", QueryOptions { session: Some(session), detail: Some(Detail::Full), ..Default::default() }),
        ("since", QueryOptions { since: Some(mid), detail: Some(Detail::Full), ..Default::default() }),
        ("until", QueryOptions { until: Some(mid), detail: Some(Detail::Full), ..Default::default() }),
        ("top_k_2", QueryOptions { top_k: Some(2), ..Default::default() }),
        ("temporal", QueryOptions { detail: Some(Detail::Full), ..Default::default() }),
    ];
    for (name, opts) in cases {
        let text =
            if name == "temporal" { format!("What is the latest on this: {}", q.query) } else { q.query.clone() };
        results.insert(format!("{}:{name}", q.id), stable(zm.query(&text, &opts).unwrap()));
    }
    let got = serde_json::Value::Object(results);
    let pretty = serde_json::to_string_pretty(&got).unwrap() + "\n";

    let path = golden_path();
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &pretty).unwrap();
        return;
    }
    let want: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&path).expect("tests/golden/small.json; run with UPDATE_GOLDEN=1 to create it"),
    )
    .unwrap();
    if got != want {
        let mut diffs = Vec::new();
        for (k, v) in got.as_object().unwrap() {
            if want.get(k) != Some(v) {
                diffs.push(k.clone());
            }
        }
        panic!(
            "golden retrieval results changed for {} of {} cases: {}\nrerun with UPDATE_GOLDEN=1 if the change is intended",
            diffs.len(),
            got.as_object().unwrap().len(),
            diffs.join(", ")
        );
    }
}
