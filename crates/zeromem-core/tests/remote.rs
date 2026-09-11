//! The remote (OpenAI-compatible) embedder against a local mock, and the
//! engine's switch-and-re-embed behaviour, which needs two embedders and
//! so cannot be shown with the hash embedder alone.

mod common;

use std::time::Duration;

use common::mock_embeddings::{self, MockServer};
use zeromem_core::dense::{EmbedderChoice, EmbedderSpec, RemoteSpec};
use zeromem_core::{Error, OpenOptions, QueryOptions, TurnInput, ZeroMem};

fn turn(session: &str, text: &str, ts: i64) -> TurnInput {
    TurnInput { session_id: session.into(), speaker: "user".into(), text: text.into(), ts: Some(ts), uuid: None }
}

fn remote(server: &MockServer) -> RemoteSpec {
    RemoteSpec { url: server.url.clone(), model: "mock-embed".into(), timeout_ms: 2000, ..Default::default() }
}

fn spec(server: &MockServer) -> EmbedderSpec {
    EmbedderSpec::Remote(remote(server))
}

/// Vectors cross JSON as decimal text, so compare within f32 noise.
fn close(a: &[f32], b: &[f32]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-5)
}

fn open_remote(dir: &tempfile::TempDir, server: &MockServer) -> ZeroMem {
    ZeroMem::open(
        dir.path(),
        OpenOptions { embedder: EmbedderChoice::OpenAi, remote: Some(remote(server)), ..OpenOptions::default() },
    )
    .unwrap()
}

fn open_hash(dir: &tempfile::TempDir) -> ZeroMem {
    ZeroMem::open(dir.path(), OpenOptions { embedder: EmbedderChoice::Hash, ..OpenOptions::default() }).unwrap()
}

fn open_auto(dir: &tempfile::TempDir) -> ZeroMem {
    ZeroMem::open(dir.path(), OpenOptions::default()).unwrap()
}

// --- the embedder itself ---------------------------------------------------

#[test]
fn requests_carry_model_inputs_and_bearer_key() {
    let server = MockServer::start();
    let spec = RemoteSpec { api_key: Some("stored-key".into()), ..remote(&server) };
    let mut e = EmbedderSpec::Remote(spec).build(std::path::Path::new("/nonexistent"), None).unwrap();
    let out = e.embed_documents(&["hello world", "second"]).unwrap();
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].len(), mock_embeddings::DIM);
    assert_eq!(e.dim(), mock_embeddings::DIM, "learned from the first response");
    assert_eq!(e.name(), "openai:mock-embed@8");
    let reqs = server.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].model, "mock-embed");
    assert_eq!(reqs[0].inputs, vec!["hello world", "second"]);
    assert_eq!(reqs[0].authorization.as_deref(), Some("Bearer stored-key"));
}

#[test]
fn the_environment_key_overrides_the_stored_one() {
    let server = MockServer::start();
    server.set(|s| s.require_key = Some("env-key".into()));
    let spec = EmbedderSpec::Remote(RemoteSpec { api_key: Some("stored-key".into()), ..remote(&server) });
    let home = std::path::Path::new("/nonexistent");
    let err = spec.build(home, None).unwrap().embed(&["x"]).unwrap_err().to_string();
    assert!(err.contains("HTTP 401"), "{err}");
    assert!(!err.contains("stored-key"), "the key never appears in an error: {err}");
    assert!(spec.build(home, Some("env-key")).unwrap().embed(&["x"]).is_ok());
}

#[test]
fn batches_prefixes_clipping_and_index_order() {
    let server = MockServer::start();
    server.set(|s| s.shuffle = true);
    let spec = RemoteSpec {
        query_prefix: "query: ".into(),
        document_prefix: "passage: ".into(),
        max_chars: 12,
        ..remote(&server)
    };
    let mut e = EmbedderSpec::Remote(spec).build(std::path::Path::new("/nonexistent"), None).unwrap();
    let texts: Vec<String> = (0..70).map(|i| format!("text number {i}")).collect();
    let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
    let out = e.embed_documents(&refs).unwrap();
    assert_eq!(out.len(), 70);
    let reqs = server.requests();
    assert_eq!(reqs.iter().map(|r| r.inputs.len()).collect::<Vec<_>>(), vec![64, 6], "batches of 64");
    assert_eq!(reqs[0].inputs[0], "passage: text number ", "clipped to 12 chars, then prefixed");
    // Order survives a server that answers in reverse.
    assert!(close(&out[5], &mock_embeddings::embed("passage: text number ", 8)));
    assert!(close(&out[65], &mock_embeddings::embed(&format!("passage: {}", &texts[65][..12]), 8)));
    let q = e.embed_query("where is it").unwrap();
    assert_eq!(server.requests().last().unwrap().inputs, vec!["query: where is it"]);
    assert!(close(&q, &mock_embeddings::embed("query: where is it", 8)));
}

#[test]
fn dimension_mismatch_and_transient_failures() {
    let server = MockServer::start();
    let home = std::path::Path::new("/nonexistent");
    let wrong = EmbedderSpec::Remote(RemoteSpec { dim: Some(16), ..remote(&server) });
    let err = wrong.build(home, None).unwrap().embed(&["x"]).unwrap_err().to_string();
    assert!(err.contains("returned 8 dims, expected 16"), "{err}");

    // One 500 is retried once and succeeds; two in a row fail the call.
    let mut e = spec(&server).build(home, None).unwrap();
    server.set(|s| s.fail_next = 1);
    assert!(e.embed(&["x"]).is_ok());
    server.set(|s| s.fail_next = 2);
    let err = e.embed(&["x"]).unwrap_err().to_string();
    assert!(err.contains("HTTP 500"), "{err}");
    assert!(e.warning().unwrap().contains("last request failed"));
    assert!(e.embed(&["x"]).is_ok(), "a success clears the failure");
    assert!(e.warning().is_none());
}

#[test]
fn a_timeout_is_reported_with_the_endpoint() {
    let server = MockServer::start();
    server.set(|s| s.delay = Duration::from_millis(600));
    let slow = EmbedderSpec::Remote(RemoteSpec { timeout_ms: 200, ..remote(&server) });
    let mut e = slow.build(std::path::Path::new("/nonexistent"), None).unwrap();
    let err = e.embed(&["x"]).unwrap_err().to_string();
    assert!(err.contains("timed out") && err.contains("/v1/embeddings"), "{err}");
}

// --- the engine with a remote store ----------------------------------------

#[test]
fn a_fresh_store_is_seeded_with_the_remote_spec_and_followed_by_auto() {
    let server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();
    let mut zm = open_remote(&dir, &server);
    zm.ingest_many(&[turn("s", "Maya Okafor owns the billing service.", 1), turn("s", "Lunch was fine.", 2)]).unwrap();
    let stats = zm.stats().unwrap();
    assert_eq!(stats.embedder.as_deref(), Some("openai:mock-embed@8"));
    assert_eq!(stats.embedder_kind.as_deref(), Some("openai"));
    assert_eq!(stats.embedder_dim, Some(8));
    assert_eq!((stats.embeddings, stats.embedding_backlog), (2, 0));
    assert!(stats.embedder_active && !stats.embedder_is_fallback);
    let r = zm.query("who owns billing", &QueryOptions::default()).unwrap();
    assert_eq!(r.evidence[0].turn.id, 1);
    drop(zm);

    // No env at all: the store's spec is followed.
    let mut again = open_auto(&dir);
    assert_eq!(again.stats().unwrap().embedder.as_deref(), Some("openai:mock-embed@8"));
    assert!(again.stats().unwrap().embedder_active);
    again.ingest_turn(&turn("s", "Kenji moved to Osaka.", 3)).unwrap();
    assert_eq!(again.stats().unwrap().embeddings, 3);
    let settings = again.embedder_settings().unwrap();
    assert_eq!(settings.api_key_source, zeromem_core::ApiKeySource::None);
    assert_eq!(settings.spec, Some(EmbedderSpec::Remote(RemoteSpec { dim: Some(8), ..remote(&server) })));

    // A different explicit request is a mismatch.
    let err = ZeroMem::open(dir.path(), OpenOptions { embedder: EmbedderChoice::Hash, ..OpenOptions::default() });
    assert!(matches!(err, Err(Error::EmbedderMismatch { .. })));
}

#[test]
fn a_process_barred_from_remote_stores_turns_without_vectors() {
    let server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();
    drop(open_remote(&dir, &server));
    let probes = server.requests().len();
    let mut hook = ZeroMem::open(dir.path(), OpenOptions { follow_remote: false, ..OpenOptions::default() }).unwrap();
    let stats = hook.stats().unwrap();
    assert!(!stats.embedder_active);
    assert!(stats.embedder_warning.unwrap().contains("leaves embedding to the server"));
    hook.ingest_turn(&turn("s", "written by a hook", 1)).unwrap();
    assert_eq!(hook.stats().unwrap().embedding_backlog, 1);
    assert_eq!(server.requests().len(), probes, "the hook never talked to the endpoint");

    let mut server_side = open_auto(&dir);
    assert_eq!(server_side.stats().unwrap().embedding_backlog, 0, "refresh at open embedded the hook's turn");
    assert_eq!(server_side.refresh().unwrap(), 0);
}

#[test]
fn switching_drops_vectors_and_the_backlog_drains_in_batches() {
    let server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();
    let mut zm = open_hash(&dir);
    let turns: Vec<TurnInput> = (0..150).map(|i| turn("s", &format!("turn {i} about topic {}", i % 7), i)).collect();
    zm.ingest_many(&turns).unwrap();
    assert_eq!(zm.stats().unwrap().embeddings, 150);
    let generation = zm.stats().unwrap().generation;

    let report = zm.set_embedder(spec(&server), false).unwrap();
    assert_eq!(report.embedder, "openai:mock-embed@8");
    assert_eq!(report.embedder_dim, 8);
    assert!(!report.vectors_kept);
    // set_embedder's own refresh embeds one batch.
    assert_eq!(report.turns_to_embed, 150 - 64);
    let stats = zm.stats().unwrap();
    assert_eq!(stats.generation, generation + 1, "a switch invalidates every reader");
    assert_eq!(stats.embeddings, 64);
    assert_eq!(stats.embedding_backlog, 86);

    assert_eq!(zm.embed_backlog(50).unwrap(), 36);
    assert_eq!(zm.embed_backlog(1000).unwrap(), 0);
    let stats = zm.stats().unwrap();
    assert_eq!((stats.embeddings, stats.embedding_backlog), (150, 0));
    let r =
        zm.query("topic 3", &QueryOptions { detail: Some(zeromem_core::Detail::Full), ..Default::default() }).unwrap();
    let dense = r.route.unwrap().views.into_iter().find(|v| v.view == zeromem_core::ViewKind::Dense).unwrap();
    assert!(dense.candidates > 0, "the dense view answers from the new vectors");

    // Applying the same model again (a new timeout) keeps the vectors.
    let same = EmbedderSpec::Remote(RemoteSpec { timeout_ms: 9000, ..remote(&server) });
    let report = zm.set_embedder(same.clone(), false).unwrap();
    assert!(report.vectors_kept);
    assert_eq!(report.turns_to_embed, 0);
    assert_eq!(zm.stats().unwrap().embeddings, 150);
    assert_eq!(
        zm.embedder_settings().unwrap().spec.unwrap(),
        EmbedderSpec::Remote(RemoteSpec { dim: Some(8), timeout_ms: 9000, ..remote(&server) })
    );

    // And back to hash.
    let report = zm.set_embedder(EmbedderSpec::Hash, false).unwrap();
    assert_eq!(report.embedder, "hash-384");
    assert_eq!(zm.embed_backlog(1000).unwrap(), 0);
    assert_eq!(zm.stats().unwrap().embeddings, 150);
    assert_eq!(zm.stats().unwrap().embedder_dim, Some(384));
}

#[test]
fn a_bad_endpoint_leaves_the_store_untouched() {
    let server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();
    let mut zm = open_hash(&dir);
    zm.ingest_turn(&turn("s", "hello", 1)).unwrap();
    let dead = EmbedderSpec::Remote(RemoteSpec { url: server.dead_url(), timeout_ms: 500, ..remote(&server) });
    let err = zm.set_embedder(dead.clone(), false).unwrap_err().to_string();
    assert!(err.contains("/v1/embeddings"), "{err}");
    let stats = zm.stats().unwrap();
    assert_eq!(stats.embedder.as_deref(), Some("hash-384"));
    assert_eq!(stats.embeddings, 1);
    assert!(zm.probe_embedder(dead, false).is_err());
    let probe = zm.probe_embedder(spec(&server), false).unwrap();
    assert_eq!((probe.embedder.as_str(), probe.embedder_dim), ("openai:mock-embed@8", 8));
    assert_eq!(zm.stats().unwrap().embedder.as_deref(), Some("hash-384"), "a probe changes nothing");
}

#[test]
fn a_second_engine_follows_a_switch_and_a_stale_writer_cannot_overwrite() {
    let server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();
    let mut a = open_hash(&dir);
    let mut b = open_hash(&dir);
    a.ingest_many(&[turn("s", "one", 1), turn("s", "two", 2)]).unwrap();
    assert_eq!(b.refresh().unwrap(), 2);

    a.set_embedder(spec(&server), false).unwrap();
    assert_eq!(a.embed_backlog(100).unwrap(), 0);
    let before = server.requests().len();

    // b still holds the hash embedder. Its next write lands without a
    // vector and it then follows the store.
    b.ingest_turn(&turn("s", "three", 3)).unwrap();
    let stats = b.stats().unwrap();
    assert_eq!(stats.embedder.as_deref(), Some("openai:mock-embed@8"));
    assert!(stats.embedder_active, "b built the remote embedder from the store's spec");
    assert_eq!(stats.embedding_backlog, 0, "b's refresh embedded the turn with the new model");
    assert!(server.requests().len() > before);
    assert_eq!(stats.embeddings, 3);
    assert_eq!(a.refresh().unwrap(), 1);
    let r = a.query("three", &QueryOptions::default()).unwrap();
    assert_eq!(r.evidence[0].turn.id, 3);
}

#[test]
fn a_switch_in_one_process_is_followed_by_the_other_on_refresh() {
    let server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();
    let mut a = open_hash(&dir);
    let mut b = open_hash(&dir);
    a.ingest_many(&[turn("s", "one", 1), turn("s", "two", 2)]).unwrap();
    b.refresh().unwrap();
    a.set_embedder(spec(&server), false).unwrap();
    b.refresh().unwrap();
    let stats = b.stats().unwrap();
    assert_eq!(stats.embedder_dim, Some(8));
    assert_eq!(stats.embedding_backlog, 0);
    let proj = b.projection(&zeromem_core::viz::ProjectionOptions::default(), Some("one")).unwrap();
    assert_eq!(proj.embedder, "openai:mock-embed@8");
    assert_eq!(proj.basis.mean.len(), 8);
    assert_eq!(proj.points.len(), 2);
}

#[test]
fn a_dead_endpoint_does_not_block_ingest_or_recall() {
    let server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();
    let mut zm = open_remote(&dir, &server);
    zm.ingest_turn(&turn("s", "Maya owns billing", 1)).unwrap();
    // Point the store at a port with nothing behind it, as if the box went away.
    let dead = EmbedderSpec::Remote(RemoteSpec { url: server.dead_url(), timeout_ms: 300, ..remote(&server) });
    // set_embedder would refuse (it probes), so simulate the outage: swap the spec in the store directly.
    drop(zm);
    {
        let conn = rusqlite::Connection::open(dir.path().join("zeromem.db")).unwrap();
        let mut dead_with_dim = dead.clone();
        if let EmbedderSpec::Remote(r) = &mut dead_with_dim {
            r.dim = Some(8);
        }
        conn.execute(
            "UPDATE meta SET value = ?1 WHERE key = 'embedder_spec'",
            [serde_json::to_string(&dead_with_dim).unwrap()],
        )
        .unwrap();
    }
    let mut zm = open_auto(&dir);
    assert!(zm.stats().unwrap().embedder_active, "built without a probe");
    zm.ingest_turn(&turn("s", "Kenji moved to Osaka", 2)).unwrap();
    let stats = zm.stats().unwrap();
    assert_eq!(stats.embedding_backlog, 1, "the turn landed without a vector");
    assert!(stats.embedder_warning.unwrap().contains("last request failed"));
    let r = zm.query("Kenji Osaka", &QueryOptions::default()).unwrap();
    assert_eq!(r.evidence[0].turn.id, 2, "lexical recall still answers");
    let err = zm.embed_backlog(10).unwrap_err().to_string();
    assert!(err.contains("/v1/embeddings"), "{err}");
}
