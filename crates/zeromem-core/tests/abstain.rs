//! Recall saying it has nothing: `QueryResult::abstained`.
//!
//! Every store here answers one question about one project and is asked the
//! same question about another, which is the shape an unanswerable question
//! takes in practice: the views return the right attribute of the wrong
//! thing, and without the check it reads as an answer.

mod common;

use common::*;
use zeromem_core::curation::{CurationAction, CurationOp, CuratorConfig};
use zeromem_core::retrieve::{Role, CLOSEST};
use zeromem_core::{Detail, QueryOptions, QueryResult, TurnInput, ZeroMem};

/// Old enough (1970) that curation's minimum-age guard never applies.
fn turn(uuid: &str, ts: i64, text: &str) -> TurnInput {
    TurnInput {
        session_id: "s".into(),
        speaker: "user".into(),
        text: text.into(),
        ts: Some(ts),
        uuid: Some(uuid.into()),
        scope: None,
    }
}

fn seeded() -> (tempfile::TempDir, ZeroMem) {
    let (dir, mut zm) = open_temp();
    zm.ingest_many(&[
        turn("l1", 1_000, "Rafael Ortiz owns the search index on Project Lantern."),
        turn("l2", 2_000, "The search index on Lantern is rebuilt every night."),
        turn("l3", 3_000, "Lantern's search index moved to the new cluster."),
        turn("t1", 4_000, "Tidewater standup moved to ten."),
        turn("h1", 5_000, "Maya Okafor owns the billing service on Heron."),
    ])
    .unwrap();
    (dir, zm)
}

fn ask(zm: &mut ZeroMem, query: &str) -> QueryResult {
    zm.query(query, &QueryOptions { top_k: Some(5), ..Default::default() }).unwrap()
}

fn uuids(result: &QueryResult) -> Vec<&str> {
    result.evidence.iter().map(|e| e.turn.uuid.as_str()).collect()
}

#[test]
fn a_question_about_something_else_is_declined_with_the_closest_turns() {
    let (_dir, mut zm) = seeded();

    let about = ask(&mut zm, "Who owns the search index on Lantern?");
    assert_eq!(about.abstained, None);
    assert!(uuids(&about).contains(&"l1"));
    assert!(about.evidence.len() > CLOSEST, "{:?}", uuids(&about));

    // Quill is nowhere in the store, so every candidate is about Lantern.
    let elsewhere = ask(&mut zm, "Who owns the search index on Quill?");
    let abstained = elsewhere.abstained.clone().expect("declined");
    assert_eq!(abstained.missing, ["quill"]);
    assert_eq!(abstained.best, elsewhere.evidence[0].score);
    assert_eq!(elsewhere.evidence.len(), CLOSEST, "the closest turns still come back");
    assert!(elsewhere.evidence.iter().all(|e| e.role == Role::Supporting), "and none of them as the answer");
    assert!(
        elsewhere.evidence[0].score < about.evidence[0].score,
        "a turn that misses the name scores under one that has it"
    );
}

#[test]
fn a_turn_that_names_the_subject_outranks_a_better_match_that_does_not() {
    let (_dir, mut zm) = seeded();
    // Tidewater is in the store; what is rebuilt on it is not. A Lantern
    // turn matches more of the question, and the Tidewater one is the only
    // turn about what was asked.
    let query = "What is rebuilt every night on Tidewater?";
    let trace = zm.query_trace(query, &QueryOptions::default()).unwrap();
    assert_eq!(trace.profile.names, ["tidewater"]);
    let anchor = |uuid: &str| trace.fused.iter().find(|f| f.uuid == uuid).map(|f| f.anchor);
    assert_eq!((anchor("t1"), anchor("l2")), (Some(1.0), Some(0.0)), "the trace says who paid");
    assert_eq!(uuids(&ask(&mut zm, query))[0], "t1");

    // The limit of a name check: the leading turn mentions Tidewater and
    // says nothing about a rebuild, and recall cannot tell.
    assert_eq!(ask(&mut zm, query).abstained, None);
}

#[test]
fn a_question_that_names_nothing_is_never_declined() {
    let (_dir, mut zm) = seeded();
    for query in ["who owns the search index?", "what moved to the new cluster", "zebra crossing paint"] {
        assert_eq!(ask(&mut zm, query).abstained, None, "{query}");
    }
    // A month is when, not what.
    let result = ask(&mut zm, "What moved to the new cluster in March?");
    assert_eq!(result.abstained, None);
    let (_empty, mut empty) = open_temp();
    let nothing = ask(&mut empty, "Who owns the search index on Quill?");
    assert_eq!((nothing.evidence.len(), nothing.abstained), (0, None), "no evidence says it already");
}

#[test]
fn a_replacement_stands_for_the_turn_it_replaced() {
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&[
        turn("old", 1_000, "Feature flags on Heron are served by LaunchDarkly."),
        turn("new", 2_000, "We moved the feature flags to Flagsmith last week."),
        turn("x1", 3_000, "Heron standup moved to ten."),
    ])
    .unwrap();
    let id = |zm: &ZeroMem, uuid: &str| zm.snapshot().unwrap().turns.iter().find(|t| t.uuid == uuid).unwrap().id;
    let (old, new) = (id(&zm, "old"), id(&zm, "new"));
    zm.set_curator_config(&CuratorConfig { min_age_ms: 0, ..CuratorConfig::default() }).unwrap();
    let action = CurationAction { op: CurationOp::Supersede { turn_ids: vec![old], by: new }, reason: "moved".into() };
    assert_eq!(zm.curate_apply("r", "test", &[action], false).unwrap().applied, 1);

    // `new` never says Heron. It answers for `old`, which does.
    let result = ask(&mut zm, "What serves the feature flags on Heron?");
    assert_eq!(uuids(&result)[0], "new");
    assert_eq!(result.abstained, None);
}

#[test]
fn the_verdict_is_the_same_with_context_and_in_the_trace() {
    let (_dir, mut zm) = seeded();
    let query = "Who owns the search index on Quill?";
    let plain = ask(&mut zm, query);
    let opts = QueryOptions { top_k: Some(5), context: Some(2), detail: Some(Detail::Full), ..Default::default() };
    let full = zm.query(query, &opts).unwrap();
    assert_eq!(full.abstained, plain.abstained);
    assert_eq!(uuids(&full), uuids(&plain));
    assert_eq!(full.route.expect("route").profile.names, ["quill"]);
    let trace = zm.query_trace(query, &QueryOptions { top_k: Some(5), ..Default::default() }).unwrap();
    assert_eq!(trace.abstained, plain.abstained);
    assert!(trace.dropped.iter().any(|d| d.reason.contains("abstained")), "{:?}", trace.dropped);

    // An answered question serialises as it always did.
    let json = serde_json::to_value(ask(&mut zm, "who owns the search index?")).unwrap();
    assert!(json.get("abstained").is_none(), "{json}");
}
