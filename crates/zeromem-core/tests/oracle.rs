//! The rebuild-vs-load oracle.
//!
//! A store opened from disk must be indistinguishable from one built fresh
//! from the same turns, and both from one whose derived tables were thrown
//! away and recomputed. `Snapshot` carries the turns and every derived row
//! (mentions, entity statistics, graph edges, segments, embedding digests),
//! so each index is covered here the moment it lands.

mod common;

use std::collections::{BTreeMap, BTreeSet};

use common::*;
use zeromem_core::{IngestOutcome, IngestReport};
use zeromem_harness::corpus::{LARGE, PROFILES, SMALL};

#[test]
fn reopened_store_equals_fresh_ingest() {
    for profile in PROFILES {
        let corpus = corpus(profile);
        let turns = inputs(&corpus);

        let (dir_a, mut a) = open_temp();
        a.ingest_many(&turns).unwrap();
        let built = a.snapshot().unwrap();
        drop(a);

        let loaded = reopen(&dir_a).snapshot().unwrap();
        assert_eq!(loaded, built, "{}: load differs from build", profile.name);

        let (_dir_c, mut c) = open_temp();
        c.ingest_many(&turns).unwrap();
        assert_eq!(c.snapshot().unwrap(), built, "{}: second build differs", profile.name);
        assert_eq!(built.turns.len(), corpus.turns.len());
    }
}

#[test]
fn copied_store_loads_identically() {
    let turns = inputs(&small());
    let (dir_a, mut a) = open_temp();
    a.ingest_many(&turns).unwrap();
    let built = a.snapshot().unwrap();
    // Closing the last connection checkpoints the WAL into the main file, so
    // a plain file copy is a complete store.
    drop(a);

    let dir_b = tempfile::tempdir().unwrap();
    for entry in std::fs::read_dir(dir_a.path()).unwrap() {
        let entry = entry.unwrap();
        std::fs::copy(entry.path(), dir_b.path().join(entry.file_name())).unwrap();
    }
    assert_eq!(reopen(&dir_b).snapshot().unwrap(), built);
}

#[test]
fn reingesting_the_corpus_changes_nothing() {
    let turns = inputs(&large());
    let (_dir, mut zm) = open_temp();
    let first = zm.ingest_many(&turns).unwrap();
    assert_eq!(first, IngestReport { indexed: turns.len() as u32, duplicates: 0, rejected: 0 });
    let before = zm.snapshot().unwrap();

    let second = zm.ingest_many(&turns).unwrap();
    assert_eq!(second, IngestReport { indexed: 0, duplicates: turns.len() as u32, rejected: 0 });
    assert_eq!(zm.snapshot().unwrap(), before);

    // One at a time reports the same duplicate, with its original id.
    let outcome = zm.ingest_turn(&turns[7]).unwrap();
    let id = before.turns.iter().find(|t| t.uuid == turns[7].uuid.clone().unwrap()).unwrap().id;
    assert_eq!(outcome, IngestOutcome::Duplicate { id });
}

#[test]
fn delete_then_reopen_matches_fresh_ingest_of_the_remainder() {
    let corpus = small();
    let victim = corpus.turns[0].session_id.clone();
    let turns = inputs(&corpus);

    let (dir_a, mut a) = open_temp();
    a.ingest_many(&turns).unwrap();
    let removed = a.delete_session(&victim).unwrap();
    assert!(removed > 0);
    drop(a);
    let after_delete = reopen(&dir_a).snapshot().unwrap();

    let remainder: Vec<_> = turns.iter().filter(|t| t.session_id != victim).cloned().collect();
    let (_dir_b, mut b) = open_temp();
    b.ingest_many(&remainder).unwrap();
    let fresh = b.snapshot().unwrap();

    assert_eq!(contents(&after_delete), contents(&fresh));
    assert_eq!(after_delete.turns.len(), corpus.turns.len() - removed as usize);
    assert_eq!((after_delete.generation, fresh.generation), (1, 0), "a delete bumps the generation; a build does not");
    assert_eq!(after_delete.schema_version, fresh.schema_version);
}

#[test]
fn session_views_agree_with_the_corpus() {
    let corpus = large();
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&inputs(&corpus)).unwrap();

    let stats = zm.stats().unwrap();
    assert_eq!(stats.turns as usize, corpus.turns.len());
    assert_eq!(stats.sessions as usize, LARGE.sessions);

    let sessions = zm.list_sessions(1000, 0).unwrap();
    assert_eq!(sessions.len(), LARGE.sessions);
    assert_eq!(sessions.iter().map(|s| s.turns as usize).sum::<usize>(), corpus.turns.len());
    assert!(sessions.windows(2).all(|w| w[0].last_ts >= w[1].last_ts), "most recent first");

    for summary in sessions.iter().take(5) {
        let expected: Vec<_> = corpus.turns.iter().filter(|t| t.session_id == summary.session_id).collect();
        let got = zm.session_turns(&summary.session_id, 1000, 0).unwrap();
        assert_eq!(got.len(), expected.len());
        assert!(got.iter().zip(&expected).all(|(g, e)| g.uuid == e.uuid && g.text == e.text && g.ts == e.ts));
        assert_eq!((summary.first_ts, summary.last_ts), (expected[0].ts, expected.last().unwrap().ts));
    }

    // Paging tiles the session exactly.
    let sid = &sessions[0].session_id;
    let whole = zm.session_turns(sid, 1000, 0).unwrap();
    let mut paged = Vec::new();
    let mut offset = 0;
    loop {
        let page = zm.session_turns(sid, 4, offset).unwrap();
        if page.is_empty() {
            break;
        }
        offset += page.len() as u32;
        paged.extend(page);
    }
    assert_eq!(paged, whole);
}

#[test]
fn rebuild_reproduces_the_incremental_store() {
    for profile in PROFILES {
        let (_dir, mut zm) = open_temp();
        zm.ingest_many(&inputs(&corpus(profile))).unwrap();
        let incremental = zm.snapshot().unwrap();
        zm.rebuild().unwrap();
        let rebuilt = zm.snapshot().unwrap();
        assert_eq!(contents(&rebuilt), contents(&incremental), "{}: rebuild differs from incremental", profile.name);
        assert_eq!(rebuilt.generation, incremental.generation + 1, "a rebuild invalidates in-memory caches");
        assert!(!rebuilt.mentions.is_empty() && !rebuilt.edges.is_empty() && !rebuilt.segments.is_empty());
        assert_eq!(rebuilt.embeddings.len(), rebuilt.turns.len(), "every turn has a vector");
    }
}

#[test]
fn derived_state_has_the_expected_shape() {
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&inputs(&large())).unwrap();
    let s = zm.stats().unwrap();
    assert!(s.entities > 100, "entities: {}", s.entities);
    assert!(s.edges > s.entities, "edges: {}", s.edges);
    assert!(s.windows >= s.sessions, "windows: {}", s.windows);
    assert!(s.episodes >= s.sessions && s.episodes <= s.windows, "episodes: {}", s.episodes);
    assert_eq!(s.embeddings, s.turns);
    assert_eq!(s.embedder.as_deref(), Some("hash-384"));
    assert!(s.embedder_is_fallback);
    let snap = zm.snapshot().unwrap();
    // Recount from the mention rows and compare with the aggregates.
    let mut by_entity: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    let mut by_turn: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for m in &snap.mentions {
        by_entity.entry(&m.entity).or_default().insert(&m.uuid);
        by_turn.entry(&m.uuid).or_default().insert(&m.entity);
    }
    assert_eq!(by_entity.len(), snap.entities.len());
    for stat in &snap.entities {
        assert_eq!(
            by_entity[stat.entity.as_str()].len() as u32,
            stat.turns,
            "{}: stat disagrees with mentions",
            stat.entity
        );
    }
    let mut pairs: BTreeMap<(&str, &str), u32> = BTreeMap::new();
    for keys in by_turn.values() {
        let keys: Vec<&str> = keys.iter().copied().collect();
        for i in 0..keys.len() {
            for j in i + 1..keys.len() {
                *pairs.entry((keys[i], keys[j])).or_default() += 1;
            }
        }
    }
    let edges: BTreeMap<(&str, &str), u32> =
        snap.edges.iter().map(|e| ((e.a.as_str(), e.b.as_str()), e.turns)).collect();
    assert_eq!(edges, pairs, "edge weights disagree with the mentions");
}

#[test]
fn small_corpus_golden_counts() {
    // A human-checkable anchor: if these move, the fixture changed.
    let corpus = small();
    assert_eq!(corpus.turns.len(), 53);
    assert_eq!(corpus.queries.len(), 10);
    assert_eq!(SMALL.sessions, 5);
}

#[test]
fn clear_memory_then_reingest_matches_a_fresh_store() {
    let corpus = small();
    let turns = inputs(&corpus);
    let sessions = corpus.turns.iter().map(|t| t.session_id.as_str()).collect::<std::collections::BTreeSet<_>>().len();

    let (dir_a, mut a) = open_temp();
    let mut follower = reopen(&dir_a);
    a.ingest_many(&turns).unwrap();
    follower.refresh().unwrap();
    let report = a.clear_memory().unwrap();
    assert_eq!(report.turns_removed as usize, corpus.turns.len());
    assert_eq!(report.sessions_removed as usize, sessions);
    assert_eq!(report.vectors_removed as usize, corpus.turns.len());
    assert_eq!(report.turns_to_embed, 0);

    let stats = follower.stats().unwrap();
    assert_eq!(
        (stats.turns, stats.sessions, stats.entities, stats.edges, stats.windows, stats.episodes, stats.embeddings),
        (0, 0, 0, 0, 0, 0, 0),
        "a second engine follows the clear"
    );
    assert_eq!(stats.embedder.as_deref(), Some("hash-384"), "the embedder stays");
    assert!(follower.query("anything", &Default::default()).unwrap().evidence.is_empty());

    a.ingest_many(&turns).unwrap();
    drop(a);
    let after = reopen(&dir_a).snapshot().unwrap();
    let (_dir_b, mut b) = open_temp();
    b.ingest_many(&turns).unwrap();
    assert_eq!(contents(&after), contents(&b.snapshot().unwrap()));
    assert_eq!(after.generation, 1);
}
