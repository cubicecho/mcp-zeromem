//! Neighbour context on recall, and the session window behind it.
//!
//! Stores are built by hand so each test states exactly which turns sit either
//! side of a hit. Fixtures put the query's terms in the turn that should rank
//! and keep them out of its neighbours: a neighbour that matches the query is
//! ranked evidence in its own right, and evidence is never repeated as context.
//!
//! The load-bearing invariant across all of it: neighbours are *attached* to
//! evidence, never ranked with it — `evidence` is identical with and without
//! `context`, which is what keeps the eval floors and the goldens from moving.

mod common;

use common::*;
use zeromem_core::curation::{CurationAction, CurationOp};
use zeromem_core::retrieve::{MAX_CONTEXT, MAX_CONTEXT_TURNS};
use zeromem_core::{Evidence, QueryOptions, QueryResult, SessionWindowOptions, TurnInput, ZeroMem};

/// The one text every fixture ranks on, so neighbours can be plainly unrelated.
const ANSWER: &str = "Maya Okafor owns the billing service on Heron.";
const QUERY: &str = "who owns the billing service on Heron";

/// Old enough (1970) that curation's minimum-age guard never applies.
fn turn(session: &str, uuid: &str, ts: i64, speaker: &str, text: &str) -> TurnInput {
    TurnInput {
        session_id: session.into(),
        speaker: speaker.into(),
        text: text.into(),
        ts: Some(ts),
        uuid: Some(uuid.into()),
    }
}

fn id_of(zm: &ZeroMem, uuid: &str) -> i64 {
    zm.snapshot().unwrap().turns.iter().find(|t| t.uuid == uuid).unwrap_or_else(|| panic!("no turn {uuid}")).id
}

fn hit<'a>(result: &'a QueryResult, uuid: &str) -> &'a Evidence {
    result.evidence.iter().find(|e| e.turn.uuid == uuid).unwrap_or_else(|| panic!("{uuid} was not recalled"))
}

fn uuids(turns: &[zeromem_core::Turn]) -> Vec<&str> {
    turns.iter().map(|t| t.uuid.as_str()).collect()
}

fn with_context(context: u32) -> QueryOptions {
    QueryOptions { top_k: Some(10), context: Some(context), ..Default::default() }
}

/// An answer with the question that prompted it and the remark that followed,
/// plus an earlier, unrelated session to prove neighbours never cross one.
fn seeded() -> (tempfile::TempDir, ZeroMem) {
    let (dir, mut zm) = open_temp();
    zm.ingest_many(&[
        turn("b", "b1", 500, "user", "Lunch was quiet today."),
        turn("a", "a1", 1_000, "user", "Can you remind me what we settled on?"),
        turn("a", "a2", 2_000, "assistant", ANSWER),
        turn("a", "a3", 3_000, "assistant", "She is away until Tuesday."),
    ])
    .unwrap();
    (dir, zm)
}

#[test]
fn context_attaches_the_question_and_the_continuation() {
    let (_dir, mut zm) = seeded();
    let result = zm.query(QUERY, &with_context(1)).unwrap();
    let answer = hit(&result, "a2");
    assert_eq!(uuids(&answer.before), ["a1"], "the question that prompted the answer");
    assert_eq!(uuids(&answer.after), ["a3"], "the remark that followed it");
}

#[test]
fn without_context_nothing_is_attached() {
    let (_dir, mut zm) = seeded();
    let result = zm.query(QUERY, &QueryOptions { top_k: Some(10), ..Default::default() }).unwrap();
    for item in &result.evidence {
        assert!(item.before.is_empty() && item.after.is_empty(), "{} carried neighbours", item.turn.uuid);
    }
}

#[test]
fn context_stops_at_the_session_edges_and_never_crosses_a_session() {
    let (_dir, mut zm) = open_temp();
    // The same answer at the end of one session and the start of a later one,
    // so a single query tests both edges — and `y1` would pick up session `x`
    // if a window ever reached past its own session.
    zm.ingest_many(&[
        turn("x", "x1", 1_000, "user", "Just checking in."),
        turn("x", "x2", 2_000, "assistant", ANSWER),
        turn("y", "y1", 3_000, "assistant", ANSWER),
        turn("y", "y2", 4_000, "user", "Thanks, that is all."),
    ])
    .unwrap();

    let result = zm.query(QUERY, &with_context(5)).unwrap();
    let last = hit(&result, "x2");
    assert_eq!(uuids(&last.before), ["x1"]);
    assert!(last.after.is_empty(), "nothing follows the last turn of the session");

    let first = hit(&result, "y1");
    assert!(first.before.is_empty(), "nothing precedes the first turn of the session");
    assert_eq!(uuids(&first.after), ["y2"]);

    for item in &result.evidence {
        for neighbour in item.before.iter().chain(item.after.iter()) {
            assert_eq!(neighbour.session_id, item.turn.session_id, "neighbour from another session");
        }
    }
}

#[test]
fn identical_timestamps_are_ordered_by_id_like_session_turns() {
    let (_dir, mut zm) = open_temp();
    // A transcript ingests many turns stamped the same millisecond; the window
    // has to break that tie the way `session_turns` does, by id.
    zm.ingest_many(&[
        turn("a", "a1", 1_000, "user", "Please continue."),
        turn("a", "a2", 1_000, "assistant", ANSWER),
        turn("a", "a3", 1_000, "user", "Understood."),
    ])
    .unwrap();

    let result = zm.query(QUERY, &with_context(5)).unwrap();
    let middle = hit(&result, "a2");
    assert_eq!(uuids(&middle.before), ["a1"]);
    assert_eq!(uuids(&middle.after), ["a3"]);

    // The order `session_turns` pages in, or the window and the session read
    // would disagree about what "the next turn" is.
    assert_eq!(uuids(&zm.session_turns("a", 10, 0).unwrap()), ["a1", "a2", "a3"]);
}

#[test]
fn a_hidden_neighbour_is_dropped_and_not_backfilled() {
    let (_dir, mut zm) = seeded();
    let hidden = id_of(&zm, "a1");
    zm.curate_apply(
        "r1",
        "test",
        &[CurationAction { op: CurationOp::Hide { turn_ids: vec![hidden] }, reason: "noise".into() }],
        false,
    )
    .unwrap();

    let result = zm.query(QUERY, &with_context(1)).unwrap();
    // One turn back from `a2` is `a1`, which is hidden: the slot stays empty
    // rather than reaching further and silently splicing over the gap.
    assert!(hit(&result, "a2").before.is_empty(), "a hidden neighbour must not be replaced by an older one");

    let seen = zm.query(QUERY, &QueryOptions { include_hidden: Some(true), ..with_context(1) }).unwrap();
    assert_eq!(uuids(&hit(&seen, "a2").before), ["a1"], "include_hidden shows it again");
}

#[test]
fn neighbours_are_never_ranked_evidence_or_attached_twice() {
    let (_dir, mut zm) = open_temp();
    // `a2` and `a3` both answer the query and sit next to each other, so their
    // windows overlap and each is inside the other's reach.
    zm.ingest_many(&[
        turn("a", "a1", 1_000, "user", "Just checking in."),
        turn("a", "a2", 2_000, "assistant", ANSWER),
        turn("a", "a3", 3_000, "assistant", "Maya Okafor still owns billing on Heron this quarter."),
        turn("a", "a4", 4_000, "user", "Thanks, that is all."),
    ])
    .unwrap();

    let result = zm.query(QUERY, &with_context(3)).unwrap();
    assert!(result.evidence.len() >= 2, "this test needs adjacent hits");

    let ranked: Vec<i64> = result.evidence.iter().map(|e| e.turn.id).collect();
    let mut seen = std::collections::BTreeSet::new();
    for item in &result.evidence {
        for neighbour in item.before.iter().chain(item.after.iter()) {
            assert!(!ranked.contains(&neighbour.id), "turn {} is already ranked evidence", neighbour.id);
            assert!(seen.insert(neighbour.id), "turn {} was attached to two hits", neighbour.id);
        }
    }
}

#[test]
fn context_is_clamped_per_side_and_across_the_answer() {
    let (_dir, mut zm) = open_temp();
    let turns: Vec<TurnInput> = (0..60)
        .map(|i| {
            let text =
                if i % 5 == 0 { format!("{ANSWER} Note {i}.") } else { format!("Unrelated chatter number {i}.") };
            turn("a", &format!("a{i:02}"), 1_000 + i64::from(i) * 10, "user", &text)
        })
        .collect();
    zm.ingest_many(&turns).unwrap();

    let result = zm.query(QUERY, &with_context(MAX_CONTEXT + 40)).unwrap();
    for item in &result.evidence {
        assert!(item.before.len() <= MAX_CONTEXT as usize, "before exceeded MAX_CONTEXT");
        assert!(item.after.len() <= MAX_CONTEXT as usize, "after exceeded MAX_CONTEXT");
    }
    let attached: usize = result.evidence.iter().map(|e| e.before.len() + e.after.len()).sum();
    assert!(attached > 0, "nothing was attached at all");
    assert!(attached <= MAX_CONTEXT_TURNS, "attached {attached}, budget is {MAX_CONTEXT_TURNS}");
}

// --- the session window ------------------------------------------------------

#[test]
fn a_whole_session_window_matches_session_turns() {
    let (_dir, mut zm) = seeded();
    let window =
        zm.session_window(&SessionWindowOptions { session_id: Some("a".into()), ..Default::default() }).unwrap();
    assert_eq!(uuids(&window.turns), uuids(&zm.session_turns("a", 200, 0).unwrap()));
    assert_eq!(window.total, 3);
    assert_eq!(window.offset, 0);
    assert!(!window.truncated);
    assert_eq!(window.around_turn, None);
}

#[test]
fn a_window_centres_on_its_turn() {
    let (_dir, mut zm) = seeded();
    let anchor = id_of(&zm, "a2");
    let window = zm
        .session_window(&SessionWindowOptions {
            around_turn: Some(anchor),
            before: Some(1),
            after: Some(1),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(uuids(&window.turns), ["a1", "a2", "a3"]);
    assert_eq!(window.around_turn, Some(anchor));
    assert_eq!(window.session_id, "a", "the session is taken from the anchor");
    assert_eq!(window.offset, 0);
    assert!(!window.truncated);
}

#[test]
fn a_window_reports_where_it_sits_in_the_session() {
    let (_dir, mut zm) = open_temp();
    let turns: Vec<TurnInput> = (0..10)
        .map(|i| turn("a", &format!("a{i}"), 1_000 + i64::from(i) * 10, "user", &format!("turn number {i}")))
        .collect();
    zm.ingest_many(&turns).unwrap();

    let page = zm
        .session_window(&SessionWindowOptions {
            session_id: Some("a".into()),
            limit: Some(4),
            offset: Some(3),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(uuids(&page.turns), ["a3", "a4", "a5", "a6"]);
    assert_eq!((page.total, page.offset, page.truncated), (10, 3, true));

    let tail = zm
        .session_window(&SessionWindowOptions {
            session_id: Some("a".into()),
            limit: Some(4),
            offset: Some(6),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(uuids(&tail.turns), ["a6", "a7", "a8", "a9"]);
    assert!(!tail.truncated, "the last page is not truncated");

    // A window around a turn reports its own offset, so a caller can page on.
    let around = zm
        .session_window(&SessionWindowOptions {
            around_turn: Some(id_of(&zm, "a5")),
            before: Some(2),
            after: Some(2),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(uuids(&around.turns), ["a3", "a4", "a5", "a6", "a7"]);
    assert_eq!((around.total, around.offset, around.truncated), (10, 3, true));
}

#[test]
fn a_window_needs_a_session_or_a_turn_that_exists() {
    let (_dir, mut zm) = seeded();
    assert!(zm.session_window(&SessionWindowOptions::default()).is_err(), "neither given");
    assert!(
        zm.session_window(&SessionWindowOptions { around_turn: Some(9_999), ..Default::default() }).is_err(),
        "unknown turn"
    );
    assert!(
        zm.session_window(&SessionWindowOptions {
            session_id: Some("b".into()),
            around_turn: Some(id_of(&zm, "a2")),
            ..Default::default()
        })
        .is_err(),
        "the turn is not in the named session"
    );
}

// --- the guard ---------------------------------------------------------------

#[test]
fn context_does_not_change_the_ranking() {
    let corpus = small();
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&inputs(&corpus)).unwrap();

    for q in &corpus.queries {
        let plain = QueryOptions { top_k: Some(5), ..Default::default() };
        let with = QueryOptions { top_k: Some(5), context: Some(3), ..Default::default() };
        let mut ranked = |opts: &QueryOptions| -> Vec<String> {
            zm.query(&q.query, opts).unwrap().evidence.into_iter().map(|e| e.turn.uuid).collect()
        };
        // `tests/eval.rs` and `scripts/rank.sh` both build their ranked list
        // from `evidence[].turn.uuid`. If neighbours ever leak into `evidence`,
        // recall@k appears to rise while precision collapses — this is the test
        // that fails first.
        assert_eq!(ranked(&plain), ranked(&with), "context changed the ranking for {}", q.id);
    }
}
