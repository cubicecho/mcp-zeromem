use serde::{Deserialize, Serialize};

/// One utterance to remember. `ts` is milliseconds since the Unix epoch; when
/// absent the store stamps "now". `uuid` is the dedup key — when absent it is
/// derived from the content, so re-ingesting the same transcript is a no-op.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TurnInput {
    pub session_id: String,
    pub speaker: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ts: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
}

/// A stored turn, as read back.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Turn {
    pub id: i64,
    pub uuid: String,
    pub session_id: String,
    pub speaker: String,
    pub text: String,
    pub ts: i64,
}

/// What happened to one ingested turn.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum IngestOutcome {
    Indexed { id: i64 },
    Duplicate { id: i64 },
}

impl IngestOutcome {
    pub fn id(self) -> i64 {
        match self {
            IngestOutcome::Indexed { id } | IngestOutcome::Duplicate { id } => id,
        }
    }
}

/// Totals for a batch ingest.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct IngestReport {
    pub indexed: u32,
    pub duplicates: u32,
    pub rejected: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSummary {
    pub session_id: String,
    pub turns: u32,
    pub first_ts: i64,
    pub last_ts: i64,
}

/// Counts an operator looks at first. `generation` increments on every
/// delete, which is what invalidates derived indexes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Stats {
    pub home: String,
    pub turns: u64,
    pub sessions: u64,
    pub entities: u64,
    pub edges: u64,
    pub windows: u64,
    pub episodes: u64,
    pub embeddings: u64,
    /// Turns still waiting for a vector from the store's embedder.
    pub embedding_backlog: u64,
    /// Name of the store's embedder; `None` until one is recorded.
    pub embedder: Option<String>,
    /// `onnx`, `hash` or `openai`.
    pub embedder_kind: Option<String>,
    pub embedder_dim: Option<u32>,
    /// Whether this process can embed with it (a hook may not; a remote
    /// box may be down).
    pub embedder_active: bool,
    /// True when the hash fallback is in use instead of the model.
    pub embedder_is_fallback: bool,
    /// Why there is no dense view here, why the fallback was chosen, or
    /// what the embedder last failed on.
    pub embedder_warning: Option<String>,
    pub generation: i64,
    pub schema_version: i64,
}

/// Where a remote embedder's key comes from. The key itself never leaves
/// the engine.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApiKeySource {
    /// The override the caller passed at open, taken from the environment.
    Env,
    Store,
    None,
}

/// The store's embedder as the settings page sees it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbedderSettings {
    /// The recorded spec with its key redacted.
    pub spec: Option<crate::dense::EmbedderSpec>,
    pub embedder: Option<String>,
    pub embedder_kind: Option<String>,
    pub embedder_dim: Option<u32>,
    /// Whether this process has the embedder open.
    pub active: bool,
    pub embedder_is_fallback: bool,
    pub embedder_warning: Option<String>,
    pub embedding_backlog: u64,
    pub api_key_source: ApiKeySource,
    /// Whether this build can load the ONNX model.
    pub onnx_available: bool,
}

/// What `set_embedder` did.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SwitchReport {
    pub embedder: String,
    pub embedder_dim: u32,
    /// Turns waiting to be re-embedded.
    pub turns_to_embed: u64,
    /// True when the spec named the model already in use, so nothing was
    /// dropped.
    pub vectors_kept: bool,
}

/// What `clear_embeddings` or `clear_memory` removed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClearReport {
    pub turns_removed: u64,
    pub sessions_removed: u64,
    pub vectors_removed: u64,
    /// Turns now waiting for a vector: every turn after clearing the
    /// vectors, none after clearing the memory.
    pub turns_to_embed: u64,
}

/// What a probe of an embedder found.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProbeReport {
    pub embedder: String,
    pub embedder_kind: String,
    pub embedder_dim: u32,
    pub latency_ms: u64,
}

/// Everything durable in a store, in a canonical order, for equality checks.
/// The rebuild-vs-load oracle compares two of these; as derived indexes
/// arrive they are added here so the oracle covers them too.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    pub schema_version: i64,
    pub generation: i64,
    pub embedder: Option<String>,
    /// Ordered by uuid, so insertion order does not leak into equality.
    pub turns: Vec<Turn>,
    pub mentions: Vec<MentionRow>,
    pub entities: Vec<EntityStat>,
    pub edges: Vec<EdgeRow>,
    pub segments: Vec<SegmentRow>,
    pub embeddings: Vec<EmbeddingRow>,
}

/// One entity as the store counts it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EntityStat {
    pub entity: String,
    pub kind: String,
    pub turns: u32,
    pub first_ts: i64,
    pub last_ts: i64,
}

/// Snapshot rows are keyed by uuid rather than row id so that two stores
/// built in different orders compare equal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MentionRow {
    pub uuid: String,
    pub entity: String,
    pub kind: String,
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EdgeRow {
    pub a: String,
    pub b: String,
    pub turns: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SegmentRow {
    pub session_id: String,
    pub level: String,
    pub start_ts: i64,
    pub end_ts: i64,
    pub first_uuid: String,
    pub last_uuid: String,
    pub turns: u32,
    pub entities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmbeddingRow {
    pub uuid: String,
    pub model: String,
    pub dim: u32,
    /// Digest of the vector rounded to 1e-4; see `store::vector_digest`.
    pub digest: String,
}
