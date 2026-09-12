//! Curation: every action reversible, recall honouring it, and the finders.
//! Stores are built by hand so each test states exactly what it curates.

mod common;

use common::*;
use zeromem_core::curation::finders::{CandidateKind, FinderOptions};
use zeromem_core::curation::{CurationAction, CurationOp, CuratorConfig, TurnSelector, UndoTarget};
use zeromem_core::{Detail, QueryOptions, Snapshot, TurnInput, TurnKind, ZeroMem};

/// Old enough (1970) that the minimum-age guard never applies.
fn turn(session: &str, uuid: &str, ts: i64, text: &str) -> TurnInput {
    TurnInput {
        session_id: session.into(),
        speaker: "user".into(),
        text: text.into(),
        ts: Some(ts),
        uuid: Some(uuid.into()),
    }
}

fn act(op: CurationOp, reason: &str) -> CurationAction {
    CurationAction { op, reason: reason.into() }
}

fn id_of(zm: &ZeroMem, uuid: &str) -> i64 {
    zm.snapshot().unwrap().turns.iter().find(|t| t.uuid == uuid).unwrap_or_else(|| panic!("no turn {uuid}")).id
}

fn ranked(zm: &mut ZeroMem, query: &str, opts: QueryOptions) -> Vec<String> {
    zm.query(query, &opts).unwrap().evidence.into_iter().map(|e| e.turn.uuid).collect()
}

/// The state curation may change; generation and vectors aside.
fn state(s: &Snapshot) -> impl PartialEq + std::fmt::Debug {
    (
        s.turns.clone(),
        s.mentions.clone(),
        s.entities.clone(),
        s.edges.clone(),
        s.flags.clone(),
        s.aliases.clone(),
        s.blocklist.clone(),
        s.note_sources.clone(),
    )
}

fn seeded() -> (tempfile::TempDir, ZeroMem) {
    let (dir, mut zm) = open_temp();
    zm.ingest_many(&[
        turn("a", "a1", 1_000, "Maya Okafor owns the billing service on Heron."),
        turn("a", "a2", 2_000, "Maya lives in Lisbon and runs the Heron rollout."),
        turn("a", "a3", 3_000, "ok thanks"),
        turn("b", "b1", 10_000, "Maya Okafor owns the billing service on Heron."),
        turn("b", "b2", 11_000, "Maya moved to Osaka last spring."),
        turn("b", "b3", 12_000, "Sure, the deploy is on Friday."),
    ])
    .unwrap();
    (dir, zm)
}

#[test]
fn undoing_a_run_restores_the_state() {
    let (_dir, mut zm) = seeded();
    let before = zm.snapshot().unwrap();
    let ids: Vec<i64> = ["a1", "a2", "a3", "b1", "b2"].iter().map(|u| id_of(&zm, u)).collect();
    let report = zm
        .curate_apply(
            "r1",
            "test",
            &[
                act(CurationOp::Hide { turn_ids: vec![ids[3]] }, "repeat"),
                act(CurationOp::Hide { turn_ids: vec![ids[2]] }, "chatter"),
                act(CurationOp::Supersede { turn_ids: vec![ids[1]], by: ids[4] }, "moved"),
                act(CurationOp::Alias { alias: "Maya".into(), canonical: "Maya Okafor".into() }, "same person"),
                act(CurationOp::Block { entity: "Sure".into() }, "not an entity"),
                act(
                    CurationOp::Note {
                        session_id: "a".into(),
                        text: "Maya Okafor owns billing on Heron and lived in Lisbon.".into(),
                        source_ids: vec![ids[0], ids[1]],
                    },
                    "episode",
                ),
            ],
            false,
        )
        .unwrap();
    assert_eq!(report.rejected, 0, "{:?}", report.results);
    assert_eq!(report.applied, 6);
    assert_ne!(state(&zm.snapshot().unwrap()), state(&before));

    let undone = zm.curate_undo(&UndoTarget::Run("r1".into()), "test").unwrap();
    assert_eq!(undone.undone.len(), 6);
    assert_eq!(state(&zm.snapshot().unwrap()), state(&before));

    // Undoing twice is refused, not repeated.
    let first = undone.undone[0];
    assert!(zm.curate_undo(&UndoTarget::Action(first), "test").is_err());
}

#[test]
fn a_dry_run_changes_nothing() {
    let (_dir, mut zm) = seeded();
    let before = zm.snapshot().unwrap();
    let id = id_of(&zm, "b1");
    let report =
        zm.curate_apply("dry", "test", &[act(CurationOp::Hide { turn_ids: vec![id] }, "repeat")], true).unwrap();
    assert_eq!((report.applied, report.rejected, report.dry_run), (1, 0, true));
    assert_eq!(state(&zm.snapshot().unwrap()), state(&before));
    assert_eq!(zm.curation_runs(10, 0).unwrap().total, 0);
}

#[test]
fn a_hidden_turn_is_never_recalled_unless_asked_for() {
    let (_dir, mut zm) = seeded();
    let id = id_of(&zm, "b1");
    let query = "who owns the billing service on Heron?";
    let opts = || QueryOptions { top_k: Some(10), ..Default::default() };
    assert!(ranked(&mut zm, query, opts()).contains(&"b1".to_string()));

    zm.curate_apply("r", "test", &[act(CurationOp::Hide { turn_ids: vec![id] }, "repeat of a1")], false).unwrap();
    let plain = ranked(&mut zm, query, opts());
    assert!(!plain.contains(&"b1".to_string()), "{plain:?}");
    assert!(plain.contains(&"a1".to_string()));

    let all = zm.query(query, &QueryOptions { include_hidden: Some(true), ..opts() }).unwrap();
    let hidden = all.evidence.iter().find(|e| e.turn.uuid == "b1").expect("include_hidden recalls it");
    assert!(hidden.hidden);
    assert_eq!(zm.stats().unwrap().hidden, 1);
}

#[test]
fn a_superseded_turn_gives_way_to_its_replacement() {
    let (_dir, mut zm) = seeded();
    let (old, new) = (id_of(&zm, "a2"), id_of(&zm, "b2"));
    zm.curate_apply("r", "test", &[act(CurationOp::Supersede { turn_ids: vec![old], by: new }, "moved")], false)
        .unwrap();
    let result = zm
        .query(
            "where does Maya live?",
            &QueryOptions { top_k: Some(10), detail: Some(Detail::Full), ..Default::default() },
        )
        .unwrap();
    let uuids: Vec<&str> = result.evidence.iter().map(|e| e.turn.uuid.as_str()).collect();
    if let Some(e) = result.evidence.iter().find(|e| e.turn.uuid == "a2") {
        assert_eq!(e.superseded_by, Some(new), "{uuids:?}");
        assert!(!uuids.contains(&"b2"), "the old turn stays only when the new one is not shown: {uuids:?}");
    }
    let read = zm.curation_turns(&TurnSelector { turn_ids: Some(vec![old, new]), ..Default::default() }, 10).unwrap();
    assert_eq!(read[0].curation.superseded_by, Some(new));
    assert_eq!(read[1].curation.supersedes, vec![old]);
}

#[test]
fn a_note_stands_for_its_sources() {
    let (_dir, mut zm) = seeded();
    let sources = vec![id_of(&zm, "a1"), id_of(&zm, "a2")];
    let report = zm
        .curate_apply(
            "r",
            "test",
            &[act(
                CurationOp::Note {
                    session_id: "a".into(),
                    text: "Maya Okafor owns the billing service on Heron and lives in Lisbon.".into(),
                    source_ids: sources.clone(),
                },
                "episode",
            )],
            false,
        )
        .unwrap();
    let note_id = report.results[0].note_id.expect("note id");
    let note = zm.snapshot().unwrap().turns.into_iter().find(|t| t.id == note_id).unwrap();
    assert_eq!(note.kind, TurnKind::Note);
    assert_eq!(zm.stats().unwrap().notes, 1);

    let result = zm
        .query(
            "who owns the billing service on Heron?",
            &QueryOptions { top_k: Some(10), detail: Some(Detail::Full), ..Default::default() },
        )
        .unwrap();
    let shown: Vec<i64> = result.evidence.iter().map(|e| e.turn.id).collect();
    if let Some(e) = result.evidence.iter().find(|e| e.turn.id == note_id) {
        assert_eq!(e.covers, sources);
        assert!(sources.iter().all(|s| !shown.contains(s)), "sources collapse under the note: {shown:?}");
    }

    // The same sources twice is refused; the uuid is derived from them.
    let again = zm
        .curate_apply(
            "r",
            "test",
            &[act(CurationOp::Note { session_id: "a".into(), text: "again".into(), source_ids: sources }, "dup")],
            false,
        )
        .unwrap();
    assert_eq!(again.rejected, 1);
}

#[test]
fn an_alias_folds_entities_as_if_the_text_used_the_canonical_name() {
    let texts = [
        ("a", "a1", 1_000, "Maya Okafor owns billing with Kenji."),
        ("a", "a2", 2_000, "Maya shipped the Heron rollout."),
        ("b", "b1", 3_000, "Kenji paired with Maya on Basalt."),
    ];
    let (_d1, mut aliased) = open_temp();
    aliased.ingest_many(&texts.map(|(s, u, ts, t)| turn(s, u, ts, t))).unwrap();
    aliased
        .curate_apply(
            "r",
            "test",
            &[act(CurationOp::Alias { alias: "Maya".into(), canonical: "Maya Okafor".into() }, "same person")],
            false,
        )
        .unwrap();

    let (_d2, mut renamed) = open_temp();
    renamed
        .ingest_many(&texts.map(|(s, u, ts, t)| {
            turn(s, u, ts, &t.replace("Maya shipped", "Maya Okafor shipped").replace("with Maya", "with Maya Okafor"))
        }))
        .unwrap();

    let (a, r) = (aliased.snapshot().unwrap(), renamed.snapshot().unwrap());
    assert_eq!(a.entities, r.entities);
    assert_eq!(a.edges, r.edges);
    assert_eq!(aliased.curation_aliases().unwrap().aliases.len(), 1);
}

#[test]
fn a_block_drops_the_entity() {
    let (_dir, mut zm) = seeded();
    let has_sure = |zm: &ZeroMem| zm.snapshot().unwrap().entities.iter().any(|e| e.entity == "sure");
    assert!(has_sure(&zm), "the fixture should make `Sure` an entity");
    zm.curate_apply("r", "test", &[act(CurationOp::Block { entity: "Sure".into() }, "a word")], false).unwrap();
    assert!(!has_sure(&zm));
    assert_eq!(zm.curation_aliases().unwrap().blocklist.len(), 1);
}

#[test]
fn rebuild_keeps_curation() {
    let (_dir, mut zm) = seeded();
    let (hidden, sure) = (id_of(&zm, "b1"), "Sure".to_string());
    zm.curate_apply(
        "r",
        "test",
        &[
            act(CurationOp::Hide { turn_ids: vec![hidden] }, "repeat"),
            act(CurationOp::Alias { alias: "Maya".into(), canonical: "Maya Okafor".into() }, "same person"),
            act(CurationOp::Block { entity: sure }, "a word"),
        ],
        false,
    )
    .unwrap();
    let before = zm.snapshot().unwrap();
    zm.rebuild().unwrap();
    assert_eq!(state(&zm.snapshot().unwrap()), state(&before));
}

#[test]
fn a_second_engine_follows_curation_without_reloading_vectors() {
    let (dir, mut writer) = seeded();
    let mut reader = reopen(&dir);
    let query = "who owns the billing service on Heron?";
    let opts = || QueryOptions { top_k: Some(10), ..Default::default() };
    assert!(ranked(&mut reader, query, opts()).contains(&"b1".to_string()));
    let generation = reader.stats().unwrap().generation;

    let id = id_of(&writer, "b1");
    writer.curate_apply("r", "test", &[act(CurationOp::Hide { turn_ids: vec![id] }, "repeat")], false).unwrap();
    assert!(!ranked(&mut reader, query, opts()).contains(&"b1".to_string()));
    let stats = reader.stats().unwrap();
    assert_eq!(stats.generation, generation, "a hide must not bump the generation");
    assert_eq!(stats.curation_seq, writer.stats().unwrap().curation_seq);
}

#[test]
fn an_alias_bumps_the_generation_so_a_second_engine_reloads_its_entities() {
    let (dir, mut writer) = seeded();
    let mut reader = reopen(&dir);
    // The reader has to have loaded its entity tables before the alias lands.
    assert!(!ranked(&mut reader, "who owns the billing service on Heron?", QueryOptions::default()).is_empty());
    let generation = reader.stats().unwrap().generation;

    let alias = act(CurationOp::Alias { alias: "maya".into(), canonical: "maya okafor".into() }, "same person");
    writer.curate_apply("r", "test", &[alias.clone()], false).unwrap();
    assert!(
        writer.stats().unwrap().generation > generation,
        "an alias re-derives every mention; that has to move the generation"
    );
    // `refresh` reads the stamp, so the reader picks the new mentions up
    // without a restart — `curation_seq` alone would only reload the flags.
    assert_eq!(reader.stats().unwrap().generation, writer.stats().unwrap().generation);
    assert!(
        reader.snapshot().unwrap().mentions.iter().all(|m| m.entity != "maya"),
        "the reader is still serving the pre-alias mentions"
    );

    let undone = writer.curate_undo(&UndoTarget::Run("r".into()), "test").unwrap();
    assert_eq!(undone.undone.len(), 1);
    assert!(writer.stats().unwrap().generation > generation + 1, "undoing an alias re-derives them again");
    assert_eq!(reader.stats().unwrap().generation, writer.stats().unwrap().generation);
}

#[test]
fn the_limits_and_the_minimum_age_hold() {
    let (_dir, mut zm) = seeded();
    zm.ingest_turn(&TurnInput {
        session_id: "c".into(),
        speaker: "user".into(),
        text: "just now".into(),
        ts: None,
        uuid: Some("c1".into()),
    })
    .unwrap();
    let young = id_of(&zm, "c1");
    let report =
        zm.curate_apply("r", "test", &[act(CurationOp::Hide { turn_ids: vec![young] }, "noise")], false).unwrap();
    assert_eq!(report.rejected, 1);

    let config =
        zm.set_curator_config(&CuratorConfig { max_per_call: 1, max_per_run: 2, ..CuratorConfig::default() }).unwrap();
    assert_eq!(config.max_per_call, 1);
    let (a3, b3, b1) = (id_of(&zm, "a3"), id_of(&zm, "b3"), id_of(&zm, "b1"));
    let two = [act(CurationOp::Hide { turn_ids: vec![a3] }, "x"), act(CurationOp::Hide { turn_ids: vec![b3] }, "y")];
    assert!(zm.curate_apply("r2", "test", &two, false).is_err(), "over the per-call limit");
    zm.curate_apply("r2", "test", &two[..1], false).unwrap();
    zm.curate_apply("r2", "test", &two[1..], false).unwrap();
    let third = zm.curate_apply("r2", "test", &[act(CurationOp::Hide { turn_ids: vec![b1] }, "z")], false).unwrap();
    assert_eq!((third.applied, third.rejected), (0, 1), "over the per-run limit");

    // A reason is required.
    zm.set_curator_config(&CuratorConfig::default()).unwrap();
    let report = zm.curate_apply("r3", "test", &[act(CurationOp::Hide { turn_ids: vec![b1] }, "")], false).unwrap();
    assert_eq!(report.rejected, 1);

    assert!(zm.set_curator_config(&CuratorConfig { token: Some("short".into()), ..CuratorConfig::default() }).is_err());
}

#[test]
fn run_end_records_the_summary_and_moves_the_cursor() {
    let (_dir, mut zm) = seeded();
    let id = id_of(&zm, "a3");
    zm.curate_apply(
        "r",
        "test",
        &[
            act(CurationOp::Hide { turn_ids: vec![id] }, "chatter"),
            act(CurationOp::RunEnd { summary: "hid chatter".into(), cursor: Some(id) }, ""),
        ],
        false,
    )
    .unwrap();
    let runs = zm.curation_runs(10, 0).unwrap();
    assert_eq!(runs.cursor, id);
    assert_eq!(runs.runs[0].summary.as_deref(), Some("hid chatter"));
    assert!(runs.runs[0].finished);
    let page = zm.curate_candidates(CandidateKind::Noise, &FinderOptions::default()).unwrap();
    assert_eq!(page.since_turn_id, id);
}

#[test]
fn the_finders_find_what_was_seeded() {
    let (_dir, mut zm) = seeded();
    let opts = FinderOptions { since_turn_id: Some(0), ..FinderOptions::default() };
    let (a1, b1, a3) = (id_of(&zm, "a1"), id_of(&zm, "b1"), id_of(&zm, "a3"));

    let dups = zm.curate_candidates(CandidateKind::Duplicates, &opts).unwrap();
    let pair = dups
        .candidates
        .iter()
        .find(|c| c.turns.iter().any(|t| t.id == a1) && c.turns.iter().any(|t| t.id == b1))
        .unwrap_or_else(|| panic!("a1/b1 are duplicates: {dups:?}"));
    assert!(matches!(&pair.suggested, CurationOp::Hide { turn_ids } if turn_ids == &vec![b1]));

    let noise = zm.curate_candidates(CandidateKind::Noise, &opts).unwrap();
    assert!(noise.candidates.iter().any(|c| c.turns.iter().any(|t| t.id == a3)), "{noise:?}");

    let aliases = zm.curate_candidates(CandidateKind::Aliases, &opts).unwrap();
    assert!(
        aliases.candidates.iter().any(|c| matches!(&c.suggested, CurationOp::Alias { alias, canonical }
            if alias.eq_ignore_ascii_case("maya") && canonical.eq_ignore_ascii_case("maya okafor"))),
        "{aliases:?}"
    );

    // Once hidden, a duplicate is not offered again.
    zm.curate_apply("r", "test", &[act(CurationOp::Hide { turn_ids: vec![b1] }, "repeat")], false).unwrap();
    let dups = zm.curate_candidates(CandidateKind::Duplicates, &opts).unwrap();
    assert!(!dups.candidates.iter().any(|c| c.turns.iter().any(|t| t.id == b1)), "{dups:?}");

    for kind in [CandidateKind::Supersession, CandidateKind::Consolidation] {
        let page = zm.curate_candidates(kind, &opts).unwrap();
        assert!(page.candidates.len() <= 20);
    }
}
