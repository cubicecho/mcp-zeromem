//! Questions about the past: what held before, and what held in a named
//! period. One fact with three values, said months apart, in a store built
//! by hand so each test states what curation knows.

mod common;

use common::*;
use zeromem_core::curation::{CurationAction, CurationOp};
use zeromem_core::dates::parse_rfc3339_ms;
use zeromem_core::retrieve::Window;
use zeromem_core::{Detail, QueryOptions, QueryResult, TurnInput, ZeroMem};

fn at(date: &str) -> i64 {
    parse_rfc3339_ms(&format!("{date}T09:00:00Z")).unwrap()
}

fn turn(session: &str, uuid: &str, date: &str, text: &str) -> TurnInput {
    TurnInput {
        session_id: session.into(),
        speaker: "user".into(),
        text: text.into(),
        ts: Some(at(date)),
        uuid: Some(uuid.into()),
        scope: None,
    }
}

fn id_of(zm: &ZeroMem, uuid: &str) -> i64 {
    zm.snapshot().unwrap().turns.iter().find(|t| t.uuid == uuid).unwrap_or_else(|| panic!("no turn {uuid}")).id
}

/// Ines owned the importer from January, Tomas from March, Maya from June.
fn seeded() -> (tempfile::TempDir, ZeroMem) {
    let (dir, mut zm) = open_temp();
    zm.ingest_many(&[
        turn("jan", "ines", "2025-01-10", "Ines Varga owns the importer on Atlas."),
        turn("jan", "jan-chat", "2025-01-10", "The Atlas standup moves to Tuesdays."),
        turn("mar", "tomas", "2025-03-05", "Tomas Reed owns the importer on Atlas."),
        turn("mar", "mar-chat", "2025-03-05", "Atlas needs a new staging database."),
        turn("jun", "maya", "2025-06-02", "Maya Okafor owns the importer on Atlas."),
        turn("jun", "jun-chat", "2025-06-20", "The Atlas retro is on Friday."),
    ])
    .unwrap();
    (dir, zm)
}

/// Each value superseded by the next, as a curator reading them in order
/// would: the chain is what gives a turn the date it stopped holding.
fn curate(zm: &mut ZeroMem) {
    let (ines, tomas, maya) = (id_of(zm, "ines"), id_of(zm, "tomas"), id_of(zm, "maya"));
    let act = |old, by| CurationAction {
        op: CurationOp::Supersede { turn_ids: vec![old], by },
        reason: "the owner changed".into(),
    };
    let report = zm.curate_apply("r", "test", &[act(ines, tomas), act(tomas, maya)], false).unwrap();
    assert_eq!(report.applied, 2, "{report:?}");
}

fn ask(zm: &mut ZeroMem, query: &str) -> QueryResult {
    zm.query(query, &QueryOptions { top_k: Some(5), detail: Some(Detail::Full), ..Default::default() }).unwrap()
}

fn uuids(result: &QueryResult) -> Vec<&str> {
    result.evidence.iter().map(|e| e.turn.uuid.as_str()).collect()
}

#[test]
fn a_plain_question_gets_the_present_value() {
    let (_dir, mut zm) = seeded();
    curate(&mut zm);
    let result = ask(&mut zm, "Who owns the importer on Atlas?");
    let profile = &result.route.as_ref().unwrap().profile;
    assert!(!profile.history && profile.window.is_none());
    assert_eq!(uuids(&result)[0], "maya");
    assert!(!uuids(&result).contains(&"tomas"), "replaced turns fold under their replacement: {:?}", uuids(&result));
    assert!(result.evidence.iter().all(|e| e.valid_until.is_none()));
}

#[test]
fn a_question_about_before_gets_the_value_just_replaced() {
    let (_dir, mut zm) = seeded();
    curate(&mut zm);
    let result = ask(&mut zm, "Who owned the importer on Atlas before?");
    assert!(result.route.as_ref().unwrap().profile.history);
    assert_eq!(&uuids(&result)[..3], ["tomas", "ines", "maya"], "the previous owner, the one before, then today's");

    let tomas = &result.evidence[0];
    assert_eq!(tomas.superseded_by, Some(id_of(&zm, "maya")));
    assert_eq!(tomas.valid_until, Some(at("2025-06-02")), "it held until Maya was named");
    assert_eq!(result.evidence[1].valid_until, Some(at("2025-03-05")));
    assert_eq!(result.evidence[2].valid_until, None, "the present value has no end");
}

#[test]
fn a_question_about_a_period_gets_what_held_then() {
    let (_dir, mut zm) = seeded();
    curate(&mut zm);
    let result = ask(&mut zm, "Who owned the importer on Atlas in April 2025?");
    let profile = &result.route.as_ref().unwrap().profile;
    assert_eq!(
        profile.window,
        Some(Window { start: at("2025-04-01") - 9 * 3_600_000, end: at("2025-05-01") - 9 * 3_600_000 })
    );
    assert_eq!(uuids(&result)[0], "tomas", "{:?}", uuids(&result));
    assert_eq!(result.evidence[0].valid_until, Some(at("2025-06-02")));

    assert_eq!(uuids(&ask(&mut zm, "Who owned the importer on Atlas in February 2025?"))[0], "ines");
    assert_eq!(uuids(&ask(&mut zm, "Who owned the importer on Atlas as of 2025-06-10?"))[0], "maya");
}

/// Without curation nothing is known to have been replaced, so a period
/// falls back on timestamps alone: the latest statement not from afterwards.
#[test]
fn a_period_works_on_a_store_nobody_curated() {
    let (_dir, mut zm) = seeded();
    assert_eq!(uuids(&ask(&mut zm, "Who owned the importer on Atlas in April 2025?"))[0], "tomas");
    assert_eq!(uuids(&ask(&mut zm, "Who owned the importer on Atlas in February 2025?"))[0], "ines");
    let before = ask(&mut zm, "Who owned the importer on Atlas before?");
    assert!(before.evidence.iter().all(|e| e.valid_until.is_none() && e.superseded_by.is_none()));
    for uuid in ["ines", "tomas", "maya"] {
        assert!(uuids(&before).contains(&uuid), "every value is still offered: {:?}", uuids(&before));
    }
}

/// `as of` and `latest` are cues for the present; next to a date or a
/// `before` they mean the opposite, and the recent view would only add the
/// newest chatter.
#[test]
fn the_past_does_not_run_the_recent_view() {
    let (_dir, mut zm) = seeded();
    for (query, recent) in [
        ("Who owns the importer on Atlas as of today?", true),
        ("Who owned the importer on Atlas as of March 2025?", false),
        ("Who changed the importer on Atlas before the latest change?", false),
    ] {
        let route = ask(&mut zm, query).route.unwrap();
        assert!(route.profile.temporal, "{query}");
        let ran = route.views.iter().any(|v| v.view == zeromem_core::ViewKind::Recent);
        assert_eq!(ran, recent, "{query}");
    }
}

/// A question about now wants the replacement more than any other: a
/// temporal cue used to switch the hand-over off along with history.
#[test]
fn a_question_about_now_still_hands_over() {
    let (_dir, mut zm) = seeded();
    curate(&mut zm);
    let result = ask(&mut zm, "Who currently owns the importer on Atlas?");
    assert_eq!(uuids(&result)[0], "maya");
    assert!(!uuids(&result).contains(&"tomas") && !uuids(&result).contains(&"ines"), "{:?}", uuids(&result));
}

/// The fields are absent, not `false`/`null`, when they say nothing, so
/// results written before they existed still compare equal.
#[test]
fn the_new_fields_are_skipped_when_empty() {
    let (_dir, mut zm) = seeded();
    let json = serde_json::to_string(&ask(&mut zm, "Who owns the importer on Atlas?")).unwrap();
    for field in ["valid_until", "\"history\"", "\"window\""] {
        assert!(!json.contains(field), "{field} in {json}");
    }
}
