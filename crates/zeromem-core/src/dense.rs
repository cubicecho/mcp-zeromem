//! Dense vectors for turns, and nearest-neighbour search over them.
//!
//! Three embedders. `Onnx` is BGE-small-en-v1.5 via ONNX Runtime, 384 dims,
//! downloaded on first use into `<home>/models`. `Hash` is a feature-hashed
//! bag of words and character trigrams in the same 384 dims — it needs no
//! model and no network, and it is deterministic, which is why the golden
//! tests use it. It is a fallback, and the engine says so in `stats()`; it
//! is never chosen silently. `Remote` is any server speaking the OpenAI
//! `/v1/embeddings` shape (an NPU box, Ollama, vLLM, the hosted API); see
//! [`remote`].
//!
//! A store records which embedder built it, as an [`EmbedderSpec`] in its
//! `meta` table, and every process that opens the store follows that spec.
//! Mixing vectors from two embedders in one index would make cosine
//! similarity meaningless, so a change of embedder always drops every
//! vector and re-embeds; that is [`crate::ZeroMem::set_embedder`].

pub mod remote;

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::text::{stem, words};

pub use remote::RemoteSpec;

/// Dimension of the two built-in embedders.
pub const HASH_DIM: usize = 384;
pub const ONNX_DIM: usize = 384;
pub const ONNX_NAME: &str = "bge-small-en-v1.5";
pub const HASH_NAME: &str = "hash-384";

/// Which embedder a *process* asks for. A fresh store is seeded with it;
/// an existing store follows its own spec and this is only a request,
/// refused when it differs unless a switch is allowed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbedderChoice {
    /// Follow the store; on a fresh store ONNX if it can be loaded, else the
    /// hash fallback, loudly.
    #[default]
    Auto,
    Onnx,
    Hash,
    /// An OpenAI-compatible endpoint; needs a [`RemoteSpec`] alongside.
    #[serde(rename = "openai")]
    OpenAi,
    /// No dense view at all in this process; nothing is embedded.
    None,
}

impl EmbedderChoice {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(Self::Auto),
            "onnx" => Some(Self::Onnx),
            "hash" => Some(Self::Hash),
            "openai" => Some(Self::OpenAi),
            "none" => Some(Self::None),
            _ => None,
        }
    }
}

/// What built a store's vectors. Serialised into the store's `meta` as
/// `embedder_spec`; the store's copy of a remote key is inside it, so it
/// is redacted before crossing any API.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EmbedderSpec {
    Onnx,
    Hash,
    #[serde(rename = "openai")]
    Remote(RemoteSpec),
}

impl EmbedderSpec {
    /// The name stamped on every vector; two specs with the same name make
    /// interchangeable vectors.
    pub fn name(&self) -> String {
        match self {
            Self::Onnx => ONNX_NAME.to_string(),
            Self::Hash => HASH_NAME.to_string(),
            Self::Remote(r) => r.name(),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Onnx => "onnx",
            Self::Hash => "hash",
            Self::Remote(_) => "openai",
        }
    }

    /// Known before anything is built for the built-ins; for a remote model
    /// only once a probe has filled it in.
    pub fn dim(&self) -> Option<usize> {
        match self {
            Self::Onnx => Some(ONNX_DIM),
            Self::Hash => Some(HASH_DIM),
            Self::Remote(r) => r.dim,
        }
    }

    /// The stored API key, if any.
    pub fn api_key(&self) -> Option<&str> {
        match self {
            Self::Remote(r) => r.api_key.as_deref(),
            _ => None,
        }
    }

    /// A copy safe to show: the key is dropped.
    pub fn redacted(&self) -> Self {
        match self {
            Self::Remote(r) => Self::Remote(RemoteSpec { api_key: None, ..r.clone() }),
            other => other.clone(),
        }
    }

    /// Same model, ignoring what only a probe or the operator fills in (the
    /// dimension, the key, timeouts). Used to decide whether a request
    /// matches the store.
    pub fn same_model(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Remote(a), Self::Remote(b)) => {
                a.url.trim_end_matches('/') == b.url.trim_end_matches('/') && a.model == b.model
            }
            (a, b) => a == b,
        }
    }

    /// The spec a legacy store implied through its `embedder` name alone.
    pub fn from_legacy_name(name: &str) -> Option<Self> {
        match name {
            ONNX_NAME => Some(Self::Onnx),
            HASH_NAME => Some(Self::Hash),
            _ => None,
        }
    }

    /// Build the embedder. `api_key_override` (the environment's key) wins
    /// over the stored one. A remote embedder is not probed here; the first
    /// embed validates it.
    pub fn build(&self, home: &Path, api_key_override: Option<&str>) -> Result<Box<dyn Embedder>> {
        match self {
            Self::Hash => Ok(Box::new(HashEmbedder)),
            Self::Onnx => Ok(Box::new(onnx::open(&models_dir(home))?)),
            Self::Remote(r) => Ok(Box::new(remote::RemoteEmbedder::new(r.clone(), api_key_override)?)),
        }
    }
}

pub trait Embedder: Send {
    /// The name stamped on every vector this embedder makes.
    fn name(&self) -> &str;
    /// Vector length; fixed for the life of the embedder once known.
    fn dim(&self) -> usize;
    fn is_fallback(&self) -> bool;
    fn embed(&mut self, texts: &[&str]) -> Result<Vec<Vec<f32>>>;
    /// Turns being stored. Asymmetric models prefix these differently from
    /// questions; the built-ins do not.
    fn embed_documents(&mut self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        self.embed(texts)
    }
    /// A question being asked.
    fn embed_query(&mut self, text: &str) -> Result<Vec<f32>> {
        Ok(self.embed(&[text])?.into_iter().next().unwrap_or_default())
    }
    /// Something the operator should see, e.g. an endpoint that is down.
    fn warning(&self) -> Option<String> {
        None
    }
}

/// Environment variable naming the model cache; `<home>/models` otherwise.
pub const MODELS_ENV: &str = "ZEROMEM_MODELS";

/// Where model files are downloaded to and loaded from.
pub fn models_dir(home: &Path) -> std::path::PathBuf {
    match std::env::var_os(MODELS_ENV).filter(|v| !v.is_empty()) {
        Some(dir) => std::path::PathBuf::from(dir),
        None => home.join("models"),
    }
}

/// The ONNX model from an explicit cache directory, downloading it on first
/// use. Tests use it to share one cache.
pub fn open_onnx(cache: &Path) -> Result<Box<dyn Embedder>> {
    Ok(Box::new(onnx::open(cache)?))
}

/// Whether this build can load the ONNX model at all.
pub fn onnx_available() -> bool {
    cfg!(feature = "onnx")
}

/// What `auto` picks for a store that has no embedder yet: ONNX, else the
/// hash fallback with the reason.
pub fn auto_spec(home: &Path) -> (EmbedderSpec, Box<dyn Embedder>, Option<String>) {
    match onnx::open(&models_dir(home)) {
        Ok(e) => (EmbedderSpec::Onnx, Box::new(e), None),
        Err(e) => {
            let warning = format!("dense embedder unavailable, using the hash fallback: {e}");
            log::warn!("{warning}");
            (EmbedderSpec::Hash, Box::new(HashEmbedder), Some(warning))
        }
    }
}

// --- hash embedder ---------------------------------------------------------

pub struct HashEmbedder;

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

/// Words weighted 1, stemmed words 0.5, character trigrams 0.25; sign and
/// slot from the hash; L2-normalised. Cosine between two of these is a
/// blend of exact-word overlap and spelling similarity.
pub fn hash_embed(text: &str) -> Vec<f32> {
    let mut v = vec![0f32; HASH_DIM];
    let mut add = |feature: &str, weight: f32| {
        let h = fnv1a(feature.as_bytes());
        let slot = (h % HASH_DIM as u64) as usize;
        let sign = if (h >> 63) == 0 { 1.0 } else { -1.0 };
        v[slot] += sign * weight;
    };
    for w in words(text) {
        let lower = w.text.to_lowercase();
        add(&format!("w:{lower}"), 1.0);
        add(&format!("s:{}", stem(&lower)), 0.5);
        let chars: Vec<char> = format!(" {lower} ").chars().collect();
        for tri in chars.windows(3) {
            let tri: String = tri.iter().collect();
            add(&format!("t:{tri}"), 0.25);
        }
    }
    normalise(&mut v);
    v
}

impl Embedder for HashEmbedder {
    fn name(&self) -> &str {
        HASH_NAME
    }
    fn dim(&self) -> usize {
        HASH_DIM
    }
    fn is_fallback(&self) -> bool {
        true
    }
    fn embed(&mut self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        Ok(texts.iter().map(|t| hash_embed(t)).collect())
    }
}

pub fn normalise(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

// --- onnx embedder ---------------------------------------------------------

#[cfg(feature = "onnx")]
mod onnx {
    use super::*;
    use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};

    pub struct OnnxEmbedder {
        model: TextEmbedding,
    }

    pub fn open(cache: &Path) -> Result<OnnxEmbedder> {
        std::fs::create_dir_all(cache).map_err(|e| Error::Embedder(format!("creating {}: {e}", cache.display())))?;
        let options = InitOptions::new(EmbeddingModel::BGESmallENV15)
            .with_cache_dir(cache.to_path_buf())
            .with_show_download_progress(false);
        let model =
            TextEmbedding::try_new(options).map_err(|e| Error::Embedder(format!("loading {ONNX_NAME}: {e}")))?;
        Ok(OnnxEmbedder { model })
    }

    impl Embedder for OnnxEmbedder {
        fn name(&self) -> &str {
            ONNX_NAME
        }
        fn dim(&self) -> usize {
            ONNX_DIM
        }
        fn is_fallback(&self) -> bool {
            false
        }
        fn embed(&mut self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
            if texts.is_empty() {
                return Ok(Vec::new());
            }
            let mut out = self.model.embed(texts, Some(64)).map_err(|e| Error::Embedder(e.to_string()))?;
            for v in &mut out {
                if v.len() != ONNX_DIM {
                    return Err(Error::Embedder(format!("model returned {} dims, expected {ONNX_DIM}", v.len())));
                }
                normalise(v);
            }
            Ok(out)
        }
    }
}

#[cfg(not(feature = "onnx"))]
mod onnx {
    use super::*;

    pub struct OnnxEmbedder;

    pub fn open(_cache: &Path) -> Result<OnnxEmbedder> {
        Err(Error::Embedder("built without the `onnx` feature".into()))
    }

    impl Embedder for OnnxEmbedder {
        fn name(&self) -> &str {
            ONNX_NAME
        }
        fn dim(&self) -> usize {
            ONNX_DIM
        }
        fn is_fallback(&self) -> bool {
            false
        }
        fn embed(&mut self, _texts: &[&str]) -> Result<Vec<Vec<f32>>> {
            Err(Error::Embedder("built without the `onnx` feature".into()))
        }
    }
}

// --- the in-memory index ---------------------------------------------------

/// Every stored vector, flat, for brute-force cosine. At 384 dims a 50k-turn
/// store is ~75 MB and a full scan is a few milliseconds; good enough until
/// stores are far larger than any transcript archive.
pub struct VectorIndex {
    dim: usize,
    ids: Vec<i64>,
    data: Vec<f32>,
    /// Position of each id in `ids`, so a re-embedded turn replaces its
    /// row instead of appearing twice.
    positions: HashMap<i64, usize>,
}

impl VectorIndex {
    pub fn new(dim: usize) -> Self {
        VectorIndex { dim, ids: Vec::new(), data: Vec::new(), positions: HashMap::new() }
    }

    pub fn dim(&self) -> usize {
        self.dim
    }

    pub fn len(&self) -> usize {
        self.ids.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }

    pub fn clear(&mut self) {
        self.ids.clear();
        self.data.clear();
        self.positions.clear();
    }

    /// Add a vector, or replace the one already held for `id`.
    pub fn push(&mut self, id: i64, vec: &[f32]) {
        debug_assert_eq!(vec.len(), self.dim);
        if let Some(&pos) = self.positions.get(&id) {
            self.data[pos * self.dim..(pos + 1) * self.dim].copy_from_slice(vec);
            return;
        }
        self.positions.insert(id, self.ids.len());
        self.ids.push(id);
        self.data.extend_from_slice(vec);
    }

    pub fn contains(&self, id: i64) -> bool {
        self.positions.contains_key(&id)
    }

    pub fn vector(&self, id: i64) -> Option<&[f32]> {
        let pos = *self.positions.get(&id)?;
        Some(&self.data[pos * self.dim..(pos + 1) * self.dim])
    }

    /// Top `k` by cosine, ties broken by higher id (newer first). Vectors are
    /// unit length so the dot product is the cosine.
    pub fn search(&self, query: &[f32], k: usize, filter: impl Fn(i64) -> bool) -> Vec<(i64, f32)> {
        if query.len() != self.dim {
            return Vec::new();
        }
        let mut scored: Vec<(i64, f32)> = self
            .ids
            .iter()
            .enumerate()
            .filter(|(_, id)| filter(**id))
            .map(|(i, id)| (*id, dot(query, &self.data[i * self.dim..(i + 1) * self.dim])))
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(b.0.cmp(&a.0)));
        scored.truncate(k);
        scored
    }
}

pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

pub fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

pub fn from_blob(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_embedding_is_unit_and_deterministic() {
        let a = hash_embed("Maya Okafor owns the billing service on Heron.");
        let b = hash_embed("Maya Okafor owns the billing service on Heron.");
        assert_eq!(a, b);
        assert!((dot(&a, &a) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn hash_embedding_prefers_shared_words() {
        let q = hash_embed("who owns the billing service on Heron");
        let hit = hash_embed("Maya Okafor owns the billing service on Project Heron.");
        let miss = hash_embed("Coffee with Kenji turned into an hour on Basalt.");
        assert!(dot(&q, &hit) > dot(&q, &miss) + 0.2);
    }

    #[test]
    fn index_searches_and_filters() {
        let mut idx = VectorIndex::new(HASH_DIM);
        idx.push(1, &hash_embed("alpha beta"));
        idx.push(2, &hash_embed("gamma delta"));
        idx.push(3, &hash_embed("alpha beta gamma"));
        let top = idx.search(&hash_embed("alpha beta"), 2, |_| true);
        assert_eq!(top[0].0, 1);
        assert_eq!(top.len(), 2);
        let filtered = idx.search(&hash_embed("alpha beta"), 2, |id| id != 1);
        assert_eq!(filtered[0].0, 3);
        assert!(idx.contains(3));
    }

    #[test]
    fn index_replaces_a_re_embedded_turn() {
        let mut idx = VectorIndex::new(HASH_DIM);
        idx.push(1, &hash_embed("old text"));
        idx.push(2, &hash_embed("other"));
        idx.push(1, &hash_embed("new text"));
        assert_eq!(idx.len(), 2);
        assert_eq!(idx.vector(1), Some(hash_embed("new text").as_slice()));
        assert!(idx.search(&hash_embed("wrong length"), 1, |_| true).len() == 1);
        assert!(idx.search(&[1.0, 0.0], 1, |_| true).is_empty(), "a query of the wrong length matches nothing");
    }

    #[test]
    fn blob_round_trips() {
        let v = hash_embed("round trip");
        assert_eq!(from_blob(&to_blob(&v)), v);
    }

    #[test]
    fn spec_names_and_serialises() {
        assert_eq!(EmbedderSpec::Hash.name(), "hash-384");
        assert_eq!(serde_json::to_string(&EmbedderSpec::Onnx).unwrap(), r#"{"kind":"onnx"}"#);
        let remote = EmbedderSpec::Remote(RemoteSpec {
            url: "http://npu:8080/v1/".into(),
            model: "nomic-embed-text".into(),
            dim: Some(768),
            api_key: Some("secret".into()),
            ..RemoteSpec::default()
        });
        assert_eq!(remote.name(), "openai:nomic-embed-text@768");
        assert_eq!(remote.kind(), "openai");
        assert_eq!(remote.redacted().api_key(), None);
        let json = serde_json::to_string(&remote).unwrap();
        assert!(json.contains(r#""kind":"openai""#));
        assert_eq!(serde_json::from_str::<EmbedderSpec>(&json).unwrap(), remote);
        let minimal: EmbedderSpec =
            serde_json::from_str(r#"{"kind":"openai","url":"http://npu:8080/v1","model":"nomic-embed-text"}"#).unwrap();
        assert!(minimal.same_model(&remote));
        assert_eq!(minimal.dim(), None);
        assert_eq!(EmbedderSpec::from_legacy_name("bge-small-en-v1.5"), Some(EmbedderSpec::Onnx));
    }
}
