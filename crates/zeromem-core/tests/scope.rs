//! Scopes: one store, several memories kept apart.
//!
//! The load-bearing test is `a_small_scope_is_not_starved`. Every view hands
//! back its best `VIEW_LIMIT` candidates; were the scope applied to that
//! answer rather than inside the view's own search, a scope holding one turn
//! in a store where hundreds of others match better would recall nothing.
//! The same goes for `session`, `since` and `until`, so they are tested the
//! same way.

mod common;

use common::*;
use zeromem_core::curation::{CurationAction, CurationOp};
use zeromem_core::retrieve::VIEW_LIMIT;
use zeromem_core::{IngestOutcome, QueryOptions, TurnInput, TurnKind, ZeroMem};

const QUERY: &str = "who owns the billing service on Heron";

/// Old enough (1970) that curation's minimum-age guard never applies.
fn turn(session: &str, uuid: &str, ts: i64, scope: Option<&str>, text: &str) -> TurnInput {
    TurnInput {
        session_id: session.into(),
        speaker: "user".into(),
        text: text.into(),
        ts: Some(ts),
        uuid: Some(uuid.into()),
        scope: scope.map(str::to_string),
    }
}

fn recalled(zm: &mut ZeroMem, opts: QueryOptions) -> Vec<String> {
    zm.query(QUERY, &opts).unwrap().evidence.into_iter().map(|e| e.turn.uuid).collect()
}

fn scoped(scope: &str) -> QueryOptions {
    QueryOptions { top_k: Some(10), scope: Some(scope.into()), ..Default::default() }
}

/// One early, wordy turn in scope `small`, session `quiet`, then several
/// times `VIEW_LIMIT` later turns in scope `big` that repeat the question
/// itself and are newer, so they fill every view ahead of it.
fn crowded() -> (tempfile::TempDir, ZeroMem) {
    let (dir, mut zm) = open_temp();
    let lone = "After the reorganisation last spring, and a long handover from the payments group, Maya Okafor \
                owns the billing service on Heron.";
    let mut turns = vec![turn("quiet", "lone", 1_000, Some("small"), lone)];
    for i in 0..VIEW_LIMIT * 4 {
        turns.push(turn(
            &format!("loud-{}", i % 7),
            &format!("crowd-{i}"),
            10_000 + i as i64,
            Some("big"),
            &format!("Who owns the billing service on Heron? Kenji owns the billing service on Heron. {i}"),
        ));
    }
    zm.ingest_many(&turns).unwrap();
    (dir, zm)
}

#[test]
fn a_small_scope_is_not_starved() {
    let (_dir, mut zm) = crowded();
    let open = recalled(&mut zm, QueryOptions { top_k: Some(50), ..Default::default() });
    assert!(!open.contains(&"lone".to_string()), "the fixture must crowd the lone turn out of an unscoped recall");
    assert_eq!(recalled(&mut zm, scoped("small")), vec!["lone"]);
}

#[test]
fn a_session_or_a_time_range_is_not_starved_either() {
    let (_dir, mut zm) = crowded();
    let only = |opts: QueryOptions| QueryOptions { top_k: Some(10), ..opts };
    assert_eq!(recalled(&mut zm, only(QueryOptions { session: Some("quiet".into()), ..Default::default() })), ["lone"]);
    assert_eq!(recalled(&mut zm, only(QueryOptions { until: Some(5_000), ..Default::default() })), ["lone"]);
    let since =
        recalled(&mut zm, only(QueryOptions { since: Some(10_000 + VIEW_LIMIT as i64 * 4 - 1), ..Default::default() }));
    assert_eq!(since, [format!("crowd-{}", VIEW_LIMIT * 4 - 1)]);
}

#[test]
fn scopes_are_kept_apart_and_no_scope_searches_them_all() {
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&[
        turn("a", "a1", 1_000, Some("project:atlas"), "Maya Okafor owns the billing service on Heron."),
        turn("b", "b1", 2_000, Some("project:basalt"), "Kenji Sato owns the billing service on Heron."),
        turn("c", "c1", 3_000, None, "Nobody owns the billing service on Heron yet."),
    ])
    .unwrap();

    assert_eq!(recalled(&mut zm, scoped("project:atlas")), ["a1"]);
    assert_eq!(recalled(&mut zm, scoped("project:basalt")), ["b1"]);
    assert_eq!(recalled(&mut zm, scoped(" project:atlas ")), ["a1"], "a scope is trimmed");
    assert!(recalled(&mut zm, scoped("project:nowhere")).is_empty());
    assert!(recalled(&mut zm, scoped("project")).is_empty(), "a scope matches whole, never as a prefix");

    let mut all = recalled(&mut zm, QueryOptions { top_k: Some(10), ..Default::default() });
    all.sort();
    assert_eq!(all, ["a1", "b1", "c1"]);
    let mut blank = recalled(&mut zm, scoped("  "));
    blank.sort();
    assert_eq!(blank, all, "a blank scope is no scope");

    let hit = zm.query(QUERY, &scoped("project:atlas")).unwrap().evidence.remove(0);
    assert_eq!(hit.turn.scope, "project:atlas");
}

#[test]
fn an_unscoped_turn_reads_as_it_always_did() {
    let (_dir, mut zm) = open_temp();
    zm.ingest_turn(&turn("c", "c1", 3_000, None, "Nobody owns the billing service on Heron yet.")).unwrap();
    let result = zm.query(QUERY, &QueryOptions::default()).unwrap();
    let json = serde_json::to_value(&result.evidence[0].turn).unwrap();
    assert!(json.get("scope").is_none(), "{json}");
    assert!(serde_json::to_value(zm.stats().unwrap()).unwrap().get("scopes").is_none());
    assert!(serde_json::to_value(&zm.list_sessions(10, 0, None).unwrap()[0]).unwrap().get("scope").is_none());
}

#[test]
fn the_first_write_of_a_turn_decides_its_scope() {
    let (_dir, mut zm) = open_temp();
    let said = |scope| TurnInput { uuid: None, ..turn("a", "", 1_000, scope, "Maya Okafor owns the billing service.") };
    let first = zm.ingest_turn(&said(Some("project:atlas"))).unwrap();
    assert!(matches!(first, IngestOutcome::Indexed { .. }));
    for scope in [Some("project:basalt"), None] {
        assert_eq!(zm.ingest_turn(&said(scope)).unwrap(), IngestOutcome::Duplicate { id: first.id() });
    }
    assert_eq!(zm.snapshot().unwrap().turns[0].scope, "project:atlas");
}

#[test]
fn sessions_and_stats_report_scopes() {
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&[
        turn("a", "a1", 1_000, Some("project:atlas"), "Maya Okafor owns the billing service on Heron."),
        turn("a", "a2", 2_000, Some("project:atlas"), "She is away until Tuesday."),
        turn("b", "b1", 3_000, Some("project:basalt"), "Kenji Sato owns the importer."),
        turn("c", "c1", 4_000, None, "Lunch was quiet today."),
    ])
    .unwrap();

    let all = zm.list_sessions(10, 0, None).unwrap();
    let scopes: Vec<(&str, &str)> = all.iter().map(|s| (s.session_id.as_str(), s.scope.as_str())).collect();
    assert_eq!(scopes, [("c", ""), ("b", "project:basalt"), ("a", "project:atlas")]);

    let atlas = zm.list_sessions(10, 0, Some("project:atlas")).unwrap();
    assert_eq!(atlas.len(), 1);
    assert_eq!((atlas[0].session_id.as_str(), atlas[0].turns), ("a", 2));

    let listed: Vec<(String, u64, u64)> =
        zm.stats().unwrap().scopes.into_iter().map(|s| (s.scope, s.turns, s.sessions)).collect();
    assert_eq!(
        listed,
        [("project:atlas".to_string(), 2, 1), (String::new(), 1, 1), ("project:basalt".to_string(), 1, 1)],
        "largest first, the unscoped turns as the empty scope"
    );

    let window =
        zm.session_window(&zeromem_core::SessionWindowOptions { session_id: Some("a".into()), ..Default::default() });
    assert!(window.unwrap().turns.iter().all(|t| t.scope == "project:atlas"));
}

#[test]
fn a_note_lives_in_its_sources_scope_and_never_spans_two() {
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&[
        turn("a", "a1", 1_000, Some("project:atlas"), "Maya Okafor owns the billing service on Heron."),
        turn("a", "a2", 2_000, Some("project:atlas"), "Maya Okafor lives in Lisbon."),
        turn("b", "b1", 3_000, Some("project:basalt"), "Kenji Sato owns the importer on Basalt."),
    ])
    .unwrap();
    let id = |zm: &ZeroMem, uuid: &str| zm.snapshot().unwrap().turns.iter().find(|t| t.uuid == uuid).unwrap().id;
    let note = |source_ids: Vec<i64>| CurationAction {
        op: CurationOp::Note {
            session_id: "a".into(),
            text: "Maya Okafor owns the billing service on Heron and lives in Lisbon.".into(),
            source_ids,
        },
        reason: "episode".into(),
    };

    let mixed = zm.curate_apply("r", "test", &[note(vec![id(&zm, "a1"), id(&zm, "b1")])], false).unwrap();
    assert_eq!(mixed.rejected, 1, "{:?}", mixed.results);

    let report = zm.curate_apply("r", "test", &[note(vec![id(&zm, "a1"), id(&zm, "a2")])], false).unwrap();
    assert_eq!(report.applied, 1, "{:?}", report.results);
    let note_id = report.results[0].note_id.expect("note id");
    let stored = zm.snapshot().unwrap().turns.into_iter().find(|t| t.id == note_id).unwrap();
    assert_eq!((stored.kind, stored.scope.as_str()), (TurnKind::Note, "project:atlas"));

    let seen = zm.query(QUERY, &scoped("project:basalt")).unwrap();
    assert!(seen.evidence.iter().all(|e| e.turn.id != note_id), "the note stays out of the other scope");
}
