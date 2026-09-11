//! Properties the store must hold for any input, not just the fixtures.
//!
//! Generated turns carry explicit timestamps so that two runs can be
//! compared; a turn without one is stamped "now" and differs by design.
//! Uuids are left to the store to derive, so equal content is one turn
//! regardless of which copy arrived first.

mod common;

use common::*;
use proptest::prelude::*;
use zeromem_core::{IngestReport, TurnInput};

fn turn() -> impl Strategy<Value = TurnInput> {
    (
        prop::sample::select(vec!["alpha", "beta", "gamma", " "]),
        prop::sample::select(vec!["user", "assistant", "tool"]),
        prop_oneof![
            8 => "[a-zA-Z0-9 ,.'äöüß日本語]{1,32}",
            1 => Just(String::from("   ")),
            1 => Just(String::new()),
        ],
        0i64..1_000_000,
    )
        .prop_map(|(session, speaker, text, ts)| TurnInput {
            session_id: session.to_string(),
            speaker: speaker.to_string(),
            text,
            ts: Some(ts),
            uuid: None,
        })
}

fn batch() -> impl Strategy<Value = Vec<TurnInput>> {
    prop::collection::vec(turn(), 1..24)
}

fn expected_report(turns: &[TurnInput]) -> IngestReport {
    let mut seen = std::collections::HashSet::new();
    let mut report = IngestReport::default();
    for t in turns {
        if t.session_id.trim().is_empty() || t.text.trim().is_empty() {
            report.rejected += 1;
        } else if seen.insert((t.session_id.clone(), t.speaker.clone(), t.text.clone(), t.ts)) {
            report.indexed += 1;
        } else {
            report.duplicates += 1;
        }
    }
    report
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 96, ..ProptestConfig::default() })]

    #[test]
    fn ingest_order_does_not_matter(turns in batch().prop_flat_map(|t| (Just(t.clone()), Just(t).prop_shuffle()))) {
        let (original, shuffled) = turns;
        let (_da, mut a) = open_temp();
        let (_db, mut b) = open_temp();
        let ra = a.ingest_many(&original).unwrap();
        let rb = b.ingest_many(&shuffled).unwrap();
        prop_assert_eq!(ra, rb);
        prop_assert_eq!(contents(&a.snapshot().unwrap()), contents(&b.snapshot().unwrap()));
    }

    #[test]
    fn ingest_report_is_exact(turns in batch()) {
        let (_d, mut zm) = open_temp();
        let report = zm.ingest_many(&turns).unwrap();
        prop_assert_eq!(zm.stats().unwrap().turns, u64::from(report.indexed));
        prop_assert_eq!(report, expected_report(&turns));
    }

    #[test]
    fn ingest_is_idempotent(turns in batch()) {
        let (_d, mut zm) = open_temp();
        let first = zm.ingest_many(&turns).unwrap();
        let before = zm.snapshot().unwrap();
        let second = zm.ingest_many(&turns).unwrap();
        prop_assert_eq!(second, IngestReport { indexed: 0, duplicates: first.indexed + first.duplicates, rejected: first.rejected });
        prop_assert_eq!(zm.snapshot().unwrap(), before);
    }

    #[test]
    fn batch_equals_sequential(turns in batch()) {
        let (_da, mut a) = open_temp();
        let (_db, mut b) = open_temp();
        let batch = a.ingest_many(&turns).unwrap();
        let mut sequential = IngestReport::default();
        for t in &turns {
            match b.ingest_turn(t) {
                Ok(zeromem_core::IngestOutcome::Indexed { .. }) => sequential.indexed += 1,
                Ok(zeromem_core::IngestOutcome::Duplicate { .. }) => sequential.duplicates += 1,
                Err(zeromem_core::Error::InvalidTurn(_)) => sequential.rejected += 1,
                Err(e) => panic!("{e}"),
            }
        }
        prop_assert_eq!(batch, sequential);
        prop_assert_eq!(a.snapshot().unwrap(), b.snapshot().unwrap());
    }

    #[test]
    fn delete_then_reingest_equals_never_deleted(turns in batch(), victim in prop::sample::select(vec!["alpha", "beta", "gamma"])) {
        let (_da, mut a) = open_temp();
        a.ingest_many(&turns).unwrap();

        let (_db, mut b) = open_temp();
        b.ingest_many(&turns).unwrap();
        let removed = b.delete_session(victim).unwrap();
        let expected_removed = a.session_turns(victim, 1000, 0).unwrap().len();
        prop_assert_eq!(removed as usize, expected_removed);
        let again: Vec<_> = turns.iter().filter(|t| t.session_id == victim).cloned().collect();
        b.ingest_many(&again).unwrap();

        prop_assert_eq!(contents(&a.snapshot().unwrap()), contents(&b.snapshot().unwrap()));
        let (sa, sb) = (a.stats().unwrap(), b.stats().unwrap());
        // Only a delete that removed something invalidates derived state.
        let expected_generation = i64::from(removed > 0);
        prop_assert_eq!((sb.turns, sb.sessions, sb.generation), (sa.turns, sa.sessions, expected_generation));
    }

    #[test]
    fn session_views_partition_the_store(turns in batch()) {
        let (_d, mut zm) = open_temp();
        zm.ingest_many(&turns).unwrap();
        let snapshot = zm.snapshot().unwrap();
        let sessions = zm.list_sessions(1000, 0).unwrap();
        let mut seen = 0usize;
        for s in &sessions {
            let got = zm.session_turns(&s.session_id, 1000, 0).unwrap();
            prop_assert_eq!(got.len(), s.turns as usize);
            prop_assert!(got.windows(2).all(|w| (w[0].ts, w[0].id) < (w[1].ts, w[1].id)), "time order within a session");
            prop_assert!(got.iter().all(|t| t.session_id == s.session_id));
            prop_assert_eq!(got.first().map(|t| t.ts), Some(s.first_ts));
            prop_assert_eq!(got.last().map(|t| t.ts), Some(s.last_ts));
            seen += got.len();
        }
        prop_assert_eq!(seen, snapshot.turns.len());
        prop_assert_eq!(sessions.len() as u64, zm.stats().unwrap().sessions);
    }
}

#[test]
fn a_turn_without_a_timestamp_is_stamped_now() {
    let (_d, mut zm) = open_temp();
    let before = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let t = TurnInput { session_id: "s".into(), speaker: "user".into(), text: "hello".into(), ts: None, uuid: None };
    zm.ingest_turn(&t).unwrap();
    let stored = &zm.session_turns("s", 10, 0).unwrap()[0];
    assert!(stored.ts >= before && stored.ts <= before + 60_000, "{}", stored.ts);
}
