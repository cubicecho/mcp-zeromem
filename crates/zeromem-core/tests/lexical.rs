//! The lexical view orders its BM25 candidates by how many of the
//! question's words each turn holds, and, for a question that names no
//! path, symbol or env var, does not count words inside a turn's technical
//! tokens.
//!
//! FTS splits `heron::billing_service::flush` into `heron billing service
//! flush`, so a turn about that symbol matches every content word of `who
//! owns the billing service on heron?` and tends to outrank the one turn
//! that answers it.

mod common;

use std::collections::HashMap;

use common::*;
use zeromem_core::retrieve::ViewKind;
use zeromem_core::{QueryOptions, TurnInput, ZeroMem};

fn turn(uuid: &str, ts: i64, text: &str) -> TurnInput {
    TurnInput {
        session_id: "s".into(),
        speaker: "user".into(),
        text: text.into(),
        ts: Some(ts),
        uuid: Some(uuid.into()),
    }
}

/// The lexical view's candidates for `query`, as uuids, best first.
fn lexical(zm: &mut ZeroMem, query: &str) -> Vec<String> {
    let opts = QueryOptions { top_k: Some(50), ..Default::default() };
    let trace = zm.query_trace(query, &opts).unwrap();
    let uuids: HashMap<i64, String> = trace.evidence.iter().map(|e| (e.turn.id, e.turn.uuid.clone())).collect();
    let view = trace.views.iter().find(|v| v.view == ViewKind::Lexical).expect("lexical view");
    view.candidates.iter().map(|(id, _)| uuids[id].clone()).collect()
}

/// Unrelated turns, so the words the tests care about are rare enough for
/// BM25's IDF to mean something.
fn filler(from: i64) -> Vec<TurnInput> {
    (0..20)
        .map(|i| turn(&format!("filler{i}"), from + i, &format!("standup {i} ran long, nothing else to report.")))
        .collect()
}

fn store() -> (tempfile::TempDir, ZeroMem) {
    let (dir, mut zm) = open_temp();
    zm.ingest_many(&filler(10_000)).unwrap();
    zm.ingest_many(&[
        turn(
            "owner",
            1_000,
            "after the reorg last month maya okafor owns the billing service on heron, and wants every change \
             request for it routed through her first.",
        ),
        turn("symbol", 2_000, "heron::billing_service::flush owns the retry loop on heron."),
        turn("env", 3_000, "HERON_BILLING_SERVICE_URL again."),
    ])
    .unwrap();
    (dir, zm)
}

#[test]
fn words_inside_a_technical_token_do_not_answer_a_prose_question() {
    let (_dir, mut zm) = store();
    let ranked = lexical(&mut zm, "who owns the billing service on heron?");
    assert_eq!(ranked.first().map(String::as_str), Some("owner"), "{ranked:?}");
}

#[test]
fn a_question_naming_a_technical_token_still_counts_it() {
    let (_dir, mut zm) = store();
    let ranked = lexical(&mut zm, "what is HERON_BILLING_SERVICE_URL set to?");
    assert_eq!(ranked.first().map(String::as_str), Some("env"), "{ranked:?}");
}

#[test]
fn a_turn_with_every_word_beats_one_repeating_a_rare_word() {
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&filler(10_000)).unwrap();
    zm.ingest_many(&[
        turn(
            "all",
            1_000,
            "after a long week of back and forth the edge cache on sparrow moved to fastly, according to the \
             infra channel and the migration notes.",
        ),
        turn("repeat", 2_000, "fastly fastly sparrow fastly."),
    ])
    .unwrap();
    let ranked = lexical(&mut zm, "what does the edge cache on sparrow use, fastly?");
    assert_eq!(ranked.first().map(String::as_str), Some("all"), "{ranked:?}");
}

#[test]
fn a_relation_word_is_answered_by_another_word_for_the_same_relation() {
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&filler(10_000)).unwrap();
    zm.ingest_many(&[
        turn("answer", 1_000, "since the reorg kenji morimoto is the point person for sparrow's data warehouse."),
        turn("other", 2_000, "maya owns the data warehouse on juniper."),
    ])
    .unwrap();
    let ranked = lexical(&mut zm, "who owns the data warehouse on sparrow?");
    assert_eq!(ranked.first().map(String::as_str), Some("answer"), "{ranked:?}");
}
