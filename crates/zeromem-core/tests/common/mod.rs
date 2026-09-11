//! Shared helpers for the integration tests. Each test file is its own
//! crate, so anything two of them need lives here.

#![allow(dead_code)]

pub mod mock_embeddings;

use tempfile::TempDir;
use zeromem_core::dense::EmbedderChoice;
use zeromem_core::{
    AliasRow, EdgeRow, EmbeddingRow, EntityStat, FlagRow, MentionRow, NoteSourceRow, OpenOptions, SegmentRow, Snapshot,
    Turn, TurnInput, TurnKind, ZeroMem,
};
use zeromem_harness::corpus::{self, Corpus, Profile};

/// Tests open with the hash embedder: deterministic, offline, and it
/// exercises the dense path end to end. The ONNX model has its own test.
pub fn options() -> OpenOptions {
    OpenOptions { embedder: EmbedderChoice::Hash, ..OpenOptions::default() }
}

pub fn open_temp() -> (TempDir, ZeroMem) {
    let dir = tempfile::tempdir().expect("tempdir");
    let zm = ZeroMem::open(dir.path(), options()).expect("open");
    (dir, zm)
}

pub fn reopen(dir: &TempDir) -> ZeroMem {
    ZeroMem::open(dir.path(), options()).expect("reopen")
}

pub fn corpus(profile: &Profile) -> Corpus {
    zeromem_harness::fixtures::load(profile).expect("committed fixtures; run `cargo run -p zeromem-harness -- gen`")
}

pub fn small() -> Corpus {
    corpus(&corpus::SMALL)
}

pub fn large() -> Corpus {
    corpus(&corpus::LARGE)
}

pub fn inputs(corpus: &Corpus) -> Vec<TurnInput> {
    corpus.turns.iter().map(input).collect()
}

pub fn input(t: &corpus::Turn) -> TurnInput {
    TurnInput {
        session_id: t.session_id.clone(),
        speaker: t.speaker.clone(),
        text: t.text.clone(),
        ts: Some(t.ts),
        uuid: Some(t.uuid.clone()),
    }
}

/// A turn without its row id, for comparisons where insertion order is
/// allowed to differ.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Content {
    pub uuid: String,
    pub session_id: String,
    pub speaker: String,
    pub text: String,
    pub ts: i64,
    pub kind: TurnKind,
}

impl From<&Turn> for Content {
    fn from(t: &Turn) -> Self {
        Content {
            uuid: t.uuid.clone(),
            session_id: t.session_id.clone(),
            speaker: t.speaker.clone(),
            text: t.text.clone(),
            ts: t.ts,
            kind: t.kind,
        }
    }
}

/// Everything in a snapshot that does not depend on row ids or on how many
/// deletes the store has seen: the turns and every derived row, all keyed
/// by uuid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Derived {
    pub embedder: Option<String>,
    pub turns: Vec<Content>,
    pub mentions: Vec<MentionRow>,
    pub entities: Vec<EntityStat>,
    pub edges: Vec<EdgeRow>,
    pub segments: Vec<SegmentRow>,
    pub embeddings: Vec<EmbeddingRow>,
    pub flags: Vec<FlagRow>,
    pub aliases: Vec<AliasRow>,
    pub blocklist: Vec<String>,
    pub note_sources: Vec<NoteSourceRow>,
}

pub fn contents(snapshot: &Snapshot) -> Derived {
    Derived {
        embedder: snapshot.embedder.clone(),
        turns: snapshot.turns.iter().map(Content::from).collect(),
        mentions: snapshot.mentions.clone(),
        entities: snapshot.entities.clone(),
        edges: snapshot.edges.clone(),
        segments: snapshot.segments.clone(),
        embeddings: snapshot.embeddings.clone(),
        flags: snapshot.flags.clone(),
        aliases: snapshot.aliases.clone(),
        blocklist: snapshot.blocklist.clone(),
        note_sources: snapshot.note_sources.clone(),
    }
}
