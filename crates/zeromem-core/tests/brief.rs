//! The standing brief: one curator-written paragraph per scope, read at
//! session start without a recall.
//!
//! A brief is a turn, so the oracle and undo cover it, but it is never
//! evidence: it restates what the turns say, and ranking it beside them
//! would count the same fact twice.

mod common;

use common::*;
use zeromem_core::curation::finders::{CandidateKind, FinderOptions, BRIEF_STALE_TURNS};
use zeromem_core::curation::{brief_session, CurationAction, CurationOp, CuratorConfig, UndoTarget};
use zeromem_core::{QueryOptions, TurnInput, TurnKind, ZeroMem};

const ATLAS: &str = "project:atlas";

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

fn brief(scope: &str, text: &str, source_ids: Vec<i64>) -> CurationAction {
    CurationAction {
        op: CurationOp::Brief { scope: scope.into(), text: text.into(), source_ids },
        reason: "session start".into(),
    }
}

fn id_of(zm: &ZeroMem, uuid: &str) -> i64 {
    zm.snapshot().unwrap().turns.iter().find(|t| t.uuid == uuid).unwrap_or_else(|| panic!("no turn {uuid}")).id
}

fn text_of(zm: &ZeroMem, scope: &str) -> Option<String> {
    zm.brief(scope).unwrap().map(|t| t.text)
}

fn seeded() -> (tempfile::TempDir, ZeroMem) {
    let (dir, mut zm) = open_temp();
    zm.ingest_many(&[
        turn("a", "a1", 1_000, Some(ATLAS), "Maya Okafor owns the billing service on Heron."),
        turn("a", "a2", 2_000, Some(ATLAS), "The Heron rollout is planned for Friday."),
        turn("b", "b1", 3_000, Some("project:basalt"), "Kenji Sato owns the importer on Basalt."),
        turn("c", "c1", 4_000, None, "The team standup moved to ten."),
    ])
    .unwrap();
    (dir, zm)
}

#[test]
fn a_brief_is_read_by_scope_and_never_recalled() {
    let (_dir, mut zm) = seeded();
    assert_eq!(text_of(&zm, ATLAS), None);
    let query = "who owns the billing service on Heron";
    let before = zm.query(query, &QueryOptions::default()).unwrap();

    let text = "Maya Okafor owns the billing service on Heron; the rollout is planned for Friday.";
    let report = zm.curate_apply("r", "test", &[brief(ATLAS, text, vec![id_of(&zm, "a1")])], false).unwrap();
    assert_eq!(report.applied, 1, "{:?}", report.results);
    let brief_id = report.results[0].brief_id.expect("brief id");

    let stored = zm.brief(ATLAS).unwrap().expect("a brief");
    assert_eq!((stored.id, stored.kind, stored.scope.as_str()), (brief_id, TurnKind::Brief, ATLAS));
    assert_eq!((stored.text.as_str(), stored.session_id), (text, brief_session(ATLAS)));
    assert_eq!(text_of(&zm, "project:basalt"), None, "a brief belongs to one scope");
    assert_eq!(text_of(&zm, ""), None);

    // The same words as the brief, with and without a scope, and by its session.
    for opts in [
        QueryOptions::default(),
        QueryOptions { scope: Some(ATLAS.into()), ..Default::default() },
        QueryOptions { session: Some(brief_session(ATLAS)), ..Default::default() },
    ] {
        let got = zm.query(text, &opts).unwrap();
        assert!(got.evidence.iter().all(|e| e.turn.kind != TurnKind::Brief), "{:?}", got.evidence);
    }
    let after = zm.query(query, &QueryOptions::default()).unwrap();
    assert_eq!(
        serde_json::to_string(&before.evidence).unwrap(),
        serde_json::to_string(&after.evidence).unwrap(),
        "a brief does not move the ranking"
    );

    // A store loaded from disk equals one rebuilt from the same turns.
    let live = zm.snapshot().unwrap();
    drop(zm);
    let mut reopened = reopen(&_dir);
    assert_eq!(contents(&reopened.snapshot().unwrap()), contents(&live));
    reopened.rebuild().unwrap();
    assert_eq!(text_of(&reopened, ATLAS).as_deref(), Some(text), "a rebuild keeps the brief");
}

#[test]
fn a_new_brief_replaces_the_old_one_and_undo_brings_it_back() {
    let (_dir, mut zm) = seeded();
    let first = zm.curate_apply("r1", "test", &[brief(ATLAS, "Maya owns billing.", vec![])], false).unwrap();
    let second = zm.curate_apply("r2", "test", &[brief(ATLAS, "Kenji owns billing now.", vec![])], false).unwrap();
    assert_eq!((first.applied, second.applied), (1, 1));
    assert_eq!(text_of(&zm, ATLAS).as_deref(), Some("Kenji owns billing now."));
    let kept = zm.snapshot().unwrap().turns.iter().filter(|t| t.kind == TurnKind::Brief).count();
    assert_eq!(kept, 2, "the old brief is history, not deleted");

    zm.curate_undo(&UndoTarget::Run("r2".into()), "test").unwrap();
    assert_eq!(text_of(&zm, ATLAS).as_deref(), Some("Maya owns billing."));
    zm.curate_undo(&UndoTarget::Action(first.results[0].action_id.unwrap()), "test").unwrap();
    assert_eq!(text_of(&zm, ATLAS), None);

    // The unscoped store has a brief of its own.
    zm.curate_apply("r3", "test", &[brief("", "Standup is at ten.", vec![])], false).unwrap();
    assert_eq!(text_of(&zm, "").as_deref(), Some("Standup is at ten."));
    assert_eq!(text_of(&zm, ATLAS), None);
}

#[test]
fn a_brief_that_cannot_stand_is_refused() {
    let (_dir, mut zm) = seeded();
    let config = CuratorConfig { brief_max_chars: 200, ..CuratorConfig::default() };
    zm.set_curator_config(&config).unwrap();
    let (a1, b1) = (id_of(&zm, "a1"), id_of(&zm, "b1"));

    let refused = [
        brief(ATLAS, "   ", vec![]),
        brief(ATLAS, &"x".repeat(201), vec![]),
        brief("project:nowhere", "Nothing is known here.", vec![]),
        brief(ATLAS, "Kenji owns the importer.", vec![b1]),
    ];
    let report = zm.curate_apply("r", "test", &refused, false).unwrap();
    assert_eq!((report.applied, report.rejected), (0, 4), "{:?}", report.results);

    let ok = zm.curate_apply("r", "test", &[brief(ATLAS, "Maya owns billing.", vec![a1])], false).unwrap();
    assert_eq!(ok.applied, 1, "{:?}", ok.results);
    let id = ok.results[0].brief_id.unwrap();
    let again = [
        brief(ATLAS, "Maya owns billing.", vec![a1]),
        brief(ATLAS, "Built on the old brief.", vec![id]),
        CurationAction { op: CurationOp::Hide { turn_ids: vec![id] }, reason: "stale".into() },
        CurationAction { op: CurationOp::Supersede { turn_ids: vec![id], by: a1 }, reason: "stale".into() },
        CurationAction { op: CurationOp::Supersede { turn_ids: vec![a1], by: id }, reason: "stale".into() },
    ];
    let report = zm.curate_apply("r", "test", &again, false).unwrap();
    assert_eq!((report.applied, report.rejected), (0, 5), "{:?}", report.results);

    let dry = zm.curate_apply("r", "test", &[brief(ATLAS, "Maya still owns billing.", vec![])], true).unwrap();
    assert_eq!(dry.applied, 1);
    assert_eq!(text_of(&zm, ATLAS).as_deref(), Some("Maya owns billing."), "a dry run writes nothing");
}

#[test]
fn the_finder_names_scopes_without_a_brief_and_those_that_fell_behind() {
    let (_dir, mut zm) = seeded();
    let scopes = |zm: &mut ZeroMem| -> Vec<String> {
        let page = zm.curate_candidates(CandidateKind::Brief, &FinderOptions::default()).unwrap();
        assert!(!page.more);
        page.candidates
            .into_iter()
            .map(|c| match c.suggested {
                CurationOp::Brief { scope, text, .. } if text.is_empty() => {
                    assert!(!c.turns.is_empty(), "the newest turns say where to start reading");
                    scope
                }
                other => panic!("{other:?}"),
            })
            .collect()
    };
    assert_eq!(scopes(&mut zm), ["", ATLAS, "project:basalt"]);

    zm.curate_apply("r", "test", &[brief(ATLAS, "Maya owns billing.", vec![])], false).unwrap();
    assert_eq!(scopes(&mut zm), ["", "project:basalt"], "a scope with a fresh brief is left alone");

    // The brief is stamped now; turns that arrive after it put it behind.
    let later = zm.brief(ATLAS).unwrap().unwrap().ts + 1;
    let fresh: Vec<_> = (0..i64::from(BRIEF_STALE_TURNS))
        .map(|i| turn("d", &format!("d{i}"), later + i, Some(ATLAS), &format!("Heron rollout step {i} is done.")))
        .collect();
    zm.ingest_many(&fresh[1..]).unwrap();
    assert_eq!(scopes(&mut zm), ["", "project:basalt"]);
    zm.ingest_many(&fresh[..1]).unwrap();
    assert_eq!(scopes(&mut zm), ["", "project:basalt", ATLAS], "scopes with no brief come first");

    let page = zm
        .curate_candidates(
            CandidateKind::Brief,
            &FinderOptions { limit: Some(1), offset: Some(1), ..Default::default() },
        )
        .unwrap();
    assert!(page.more);
    assert!(matches!(&page.candidates[0].suggested, CurationOp::Brief { scope, .. } if scope == "project:basalt"));
}
