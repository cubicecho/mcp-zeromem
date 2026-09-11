//! The reads behind the visualisations: every snapshot is capped, the caps
//! hold on the large corpus, the small-corpus snapshots are pinned to a
//! golden file, and the projection is served from cache until a write.

mod common;

use std::fs;
use std::path::PathBuf;

use common::*;
use zeromem_core::viz::{GraphOptions, HierarchyOptions, ProjectionOptions, GRAPH_MAX_NODES, PROJECTION_MAX_POINTS};

fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/viz-small.json")
}

#[test]
fn large_corpus_snapshots_stay_within_their_caps() {
    let corpus = large();
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&inputs(&corpus)).unwrap();

    let graph = zm.graph_snapshot(&GraphOptions { limit: Some(50), ..Default::default() }).unwrap();
    assert_eq!(graph.nodes.len(), 50);
    assert!(graph.truncated);
    assert!(graph.total_entities > 50);
    assert!(graph.edges.iter().all(|e| e.a < e.b), "each undirected edge once");
    let in_set = |k: &str| graph.nodes.iter().any(|n| n.entity == k);
    assert!(graph.edges.iter().all(|e| in_set(&e.a) && in_set(&e.b)));

    let huge = zm.graph_snapshot(&GraphOptions { limit: Some(1_000_000), ..Default::default() }).unwrap();
    assert!(huge.nodes.len() <= GRAPH_MAX_NODES);

    let focus = graph.nodes[0].entity.clone();
    let hood = zm
        .graph_snapshot(&GraphOptions {
            focus: Some(focus.clone()),
            hops: Some(2),
            limit: Some(30),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(hood.nodes[0].entity, focus);
    assert!(hood.nodes.len() <= 30);
    let missing = zm.graph_snapshot(&GraphOptions { focus: Some("nobody-here".into()), ..Default::default() }).unwrap();
    assert!(missing.nodes.is_empty() && missing.edges.is_empty());

    let h = zm.hierarchy(&HierarchyOptions { limit: Some(10), ..Default::default() }).unwrap();
    assert_eq!(h.sessions.len(), 10);
    assert!(h.total_sessions as usize > 10);
    assert!(h.sessions.iter().all(|s| !s.windows.is_empty() && !s.episodes.is_empty()));
    let ranged = zm
        .hierarchy(&HierarchyOptions { since: Some(h.sessions[0].last_ts), limit: Some(500), ..Default::default() })
        .unwrap();
    assert!(ranged.sessions.iter().all(|s| s.last_ts >= h.sessions[0].last_ts));
    assert!(ranged.total_sessions < h.total_sessions);

    let turns = zm.session_turns_with_entities(&h.sessions[0].session_id, 5, 0).unwrap();
    assert!(turns.len() <= 5);
    assert!(turns.iter().any(|t| !t.entities.is_empty()), "the corpus is full of names");

    let proj = zm.projection(&ProjectionOptions { limit: Some(300), session: None }, None).unwrap();
    assert!(proj.points.len() <= 300 && proj.points.len() > 250, "{} points", proj.points.len());
    assert_eq!(proj.total as usize, corpus.turns.len());
    assert!(proj.query.is_none());
    let too_many = zm.projection(&ProjectionOptions { limit: Some(u32::MAX), session: None }, None).unwrap();
    assert!(too_many.points.len() <= PROJECTION_MAX_POINTS);

    let growth = zm.growth(None, None).unwrap();
    assert_eq!(growth.days.last().unwrap().cumulative_turns as usize, corpus.turns.len());
    assert!(growth.days.windows(2).all(|w| w[0].day < w[1].day));
}

#[test]
fn projection_is_cached_until_the_store_changes_and_overlays_a_query() {
    let corpus = small();
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&inputs(&corpus)).unwrap();
    let opts = ProjectionOptions { limit: Some(100), session: None };

    let first = zm.projection(&opts, None).unwrap();
    let again = zm.projection(&opts, None).unwrap();
    assert_eq!(first, again, "same store, same map");

    let q = &corpus.queries[0];
    let with_query = zm.projection(&opts, Some(&q.query)).unwrap();
    assert_eq!(with_query.points, first.points, "the overlay does not move the map");
    let qp = with_query.query.expect("query point");
    assert_eq!(qp.text, q.query);
    assert!(!qp.neighbours.is_empty());

    zm.ingest_turn(&zeromem_core::TurnInput {
        session_id: "extra".into(),
        speaker: "user".into(),
        text: "An unrelated remark about Kestrel.".into(),
        ts: Some(1),
        uuid: None,
    })
    .unwrap();
    let after = zm.projection(&opts, None).unwrap();
    assert_eq!(after.total, first.total + 1);

    let reopened = reopen(&_dir).projection(&opts, None).unwrap();
    assert_eq!(reopened, after, "the projection is a pure function of the store");

    let session_only =
        zm.projection(&ProjectionOptions { limit: Some(100), session: Some("extra".into()) }, Some("Kestrel")).unwrap();
    assert_eq!(session_only.points.len(), 1);
    assert_eq!(session_only.query.unwrap().neighbours, vec![session_only.points[0].turn_id]);
}

#[test]
fn small_corpus_snapshots_match_the_golden_file() {
    let corpus = small();
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&inputs(&corpus)).unwrap();

    let graph = zm.graph_snapshot(&GraphOptions { limit: Some(20), ..Default::default() }).unwrap();
    let focus = graph.nodes[0].entity.clone();
    let hood = zm.graph_snapshot(&GraphOptions { focus: Some(focus), hops: Some(1), ..Default::default() }).unwrap();
    let hierarchy = zm.hierarchy(&HierarchyOptions::default()).unwrap();
    let session = hierarchy.sessions[0].session_id.clone();
    let turns = zm.session_turns_with_entities(&session, 1000, 0).unwrap();
    let growth = zm.growth(None, None).unwrap();
    let actual = serde_json::json!({
        "graph": graph,
        "focus": hood,
        "hierarchy": hierarchy,
        "session_turns": turns,
        "growth": growth,
    });

    let path = golden_path();
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        fs::write(&path, serde_json::to_string_pretty(&actual).unwrap()).unwrap();
        return;
    }
    let expected: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(&path).expect("tests/golden/viz-small.json; run with UPDATE_GOLDEN=1 to create it"),
    )
    .unwrap();
    assert_eq!(actual, expected, "viz snapshots drifted; UPDATE_GOLDEN=1 cargo test --test viz if intended");
}
