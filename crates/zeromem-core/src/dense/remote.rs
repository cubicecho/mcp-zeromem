//! An embedder behind an OpenAI-compatible `/v1/embeddings` endpoint.
//!
//! One `POST {url}/embeddings` per batch of [`BATCH`] texts, `Bearer` auth
//! when there is a key, vectors L2-normalised and length-checked. Nothing is
//! probed at construction — `open` runs inside every hook and before the
//! server listens, and a dead box must not stall either — so the dimension
//! comes from the stored spec and the first real call validates it.
//!
//! A circuit breaker keeps a dead endpoint cheap: after [`BREAKER_TRIP`]
//! consecutive failures every call fails at once for [`BREAKER_COOLDOWN`],
//! so a recall under the engine lock never pays the timeout per query. The
//! store's backlog is the retry; nothing here retries beyond one attempt
//! on a timeout or a 5xx.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::{normalise, Embedder};
use crate::error::{Error, Result};

/// Texts per request.
pub const BATCH: usize = 64;
const BREAKER_TRIP: u32 = 3;
const BREAKER_COOLDOWN: Duration = Duration::from_secs(30);
pub const DEFAULT_TIMEOUT_MS: u64 = 5000;
pub const DEFAULT_MAX_CHARS: usize = 8000;

/// Where and how to reach the endpoint. Stored in the store's `meta`, key
/// included; `redacted()` on the enclosing spec drops the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteSpec {
    /// Base URL up to and including `/v1`, e.g. `http://npu-box:8080/v1`.
    pub url: String,
    pub model: String,
    /// Vector length; learned from the first response when unset.
    #[serde(default)]
    pub dim: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Prepended to questions; e.g. `query: ` for E5-style models.
    #[serde(default)]
    pub query_prefix: String,
    /// Prepended to turns being stored.
    #[serde(default)]
    pub document_prefix: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    /// Texts are clipped to this many characters before sending.
    #[serde(default = "default_max_chars")]
    pub max_chars: usize,
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

fn default_max_chars() -> usize {
    DEFAULT_MAX_CHARS
}

impl Default for RemoteSpec {
    fn default() -> Self {
        RemoteSpec {
            url: String::new(),
            model: String::new(),
            dim: None,
            api_key: None,
            query_prefix: String::new(),
            document_prefix: String::new(),
            timeout_ms: DEFAULT_TIMEOUT_MS,
            max_chars: DEFAULT_MAX_CHARS,
        }
    }
}

impl RemoteSpec {
    /// `openai:<model>@<dim>`; without a dimension yet, `openai:<model>`.
    pub fn name(&self) -> String {
        match self.dim {
            Some(d) => format!("openai:{}@{d}", self.model),
            None => format!("openai:{}", self.model),
        }
    }

    pub fn validate(&self) -> Result<()> {
        let url = self.url.trim();
        if url.is_empty() {
            return Err(Error::Embedder("the endpoint needs a url".into()));
        }
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(Error::Embedder(format!("endpoint url `{url}` must start with http:// or https://")));
        }
        if self.model.trim().is_empty() {
            return Err(Error::Embedder("the endpoint needs a model name".into()));
        }
        if self.timeout_ms == 0 {
            return Err(Error::Embedder("timeout_ms must be positive".into()));
        }
        if self.max_chars == 0 {
            return Err(Error::Embedder("max_chars must be positive".into()));
        }
        Ok(())
    }

    fn endpoint(&self) -> String {
        format!("{}/embeddings", self.url.trim().trim_end_matches('/'))
    }
}

pub struct RemoteEmbedder {
    spec: RemoteSpec,
    name: String,
    key: Option<String>,
    agent: ureq::Agent,
    failures: u32,
    open_until: Option<Instant>,
    last_error: Option<String>,
}

#[derive(Serialize)]
struct RequestBody<'a> {
    model: &'a str,
    input: &'a [String],
}

#[derive(Deserialize)]
struct ResponseBody {
    data: Vec<Datum>,
}

#[derive(Deserialize)]
struct Datum {
    index: usize,
    embedding: Vec<f32>,
}

/// What went wrong, and whether trying once more is worth it.
enum CallError {
    Retryable(String),
    Fatal(String),
}

impl RemoteEmbedder {
    /// `api_key_override` (the environment's) wins over the stored key.
    pub fn new(spec: RemoteSpec, api_key_override: Option<&str>) -> Result<Self> {
        spec.validate()?;
        let key = api_key_override
            .map(str::to_string)
            .filter(|k| !k.is_empty())
            .or_else(|| spec.api_key.clone().filter(|k| !k.is_empty()));
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_millis(spec.timeout_ms)))
            .http_status_as_error(false)
            .build();
        Ok(RemoteEmbedder {
            name: spec.name(),
            spec,
            key,
            agent: config.into(),
            failures: 0,
            open_until: None,
            last_error: None,
        })
    }

    pub fn spec(&self) -> &RemoteSpec {
        &self.spec
    }

    fn clip(&self, text: &str, prefix: &str) -> String {
        let body: String = text.chars().take(self.spec.max_chars).collect();
        format!("{prefix}{body}")
    }

    fn embed_with_prefix(&mut self, texts: &[&str], prefix: &str) -> Result<Vec<Vec<f32>>> {
        let mut out = Vec::with_capacity(texts.len());
        for chunk in texts.chunks(BATCH) {
            let inputs: Vec<String> = chunk.iter().map(|t| self.clip(t, prefix)).collect();
            out.extend(self.call(&inputs)?);
        }
        Ok(out)
    }

    /// One batch through the breaker, with a single retry on a transient
    /// failure.
    fn call(&mut self, inputs: &[String]) -> Result<Vec<Vec<f32>>> {
        if let Some(until) = self.open_until {
            if Instant::now() < until {
                let why = self.last_error.clone().unwrap_or_default();
                return Err(Error::Embedder(format!(
                    "{} is unavailable ({why}); retrying after a cooldown",
                    self.name
                )));
            }
            self.open_until = None;
        }
        let result = match self.request(inputs) {
            Err(CallError::Retryable(first)) => {
                log::debug!("embedding request failed ({first}); retrying once");
                self.request(inputs)
            }
            other => other,
        };
        match result {
            Ok(vectors) => {
                self.failures = 0;
                self.last_error = None;
                Ok(vectors)
            }
            Err(CallError::Retryable(msg) | CallError::Fatal(msg)) => {
                self.failures += 1;
                self.last_error = Some(msg.clone());
                if self.failures >= BREAKER_TRIP {
                    self.open_until = Some(Instant::now() + BREAKER_COOLDOWN);
                    log::warn!(
                        "{}: {} consecutive failures; pausing for {:?}",
                        self.name,
                        self.failures,
                        BREAKER_COOLDOWN
                    );
                }
                Err(Error::Embedder(msg))
            }
        }
    }

    fn request(&mut self, inputs: &[String]) -> std::result::Result<Vec<Vec<f32>>, CallError> {
        let endpoint = self.spec.endpoint();
        let mut req = self.agent.post(&endpoint).header("Content-Type", "application/json");
        if let Some(key) = &self.key {
            req = req.header("Authorization", &format!("Bearer {key}"));
        }
        let body = RequestBody { model: &self.spec.model, input: inputs };
        let mut resp = req.send_json(&body).map_err(|e| match e {
            ureq::Error::Timeout(_) => {
                CallError::Retryable(format!("{endpoint}: timed out after {} ms", self.spec.timeout_ms))
            }
            ureq::Error::Io(e) => CallError::Retryable(format!("{endpoint}: {e}")),
            e => CallError::Fatal(format!("{endpoint}: {e}")),
        })?;
        let status = resp.status().as_u16();
        if status != 200 {
            let text = resp.body_mut().read_to_string().unwrap_or_default();
            let detail = short(&text);
            let msg = format!("{endpoint} returned HTTP {status}: {detail}");
            return Err(if status >= 500 { CallError::Retryable(msg) } else { CallError::Fatal(msg) });
        }
        let parsed: ResponseBody = resp
            .body_mut()
            .read_json()
            .map_err(|e| CallError::Fatal(format!("{endpoint}: unreadable response: {e}")))?;
        if parsed.data.len() != inputs.len() {
            return Err(CallError::Fatal(format!(
                "{endpoint} returned {} vectors for {} inputs",
                parsed.data.len(),
                inputs.len()
            )));
        }
        let mut data = parsed.data;
        data.sort_by_key(|d| d.index);
        let mut out = Vec::with_capacity(data.len());
        for (i, d) in data.into_iter().enumerate() {
            if d.index != i {
                return Err(CallError::Fatal(format!("{endpoint} returned vectors with gaps in their indexes")));
            }
            let mut v = d.embedding;
            match self.spec.dim {
                Some(dim) if v.len() != dim => {
                    return Err(CallError::Fatal(format!(
                        "{} returned {} dims, expected {dim}",
                        self.spec.model,
                        v.len()
                    )));
                }
                Some(_) => {}
                None => {
                    if v.is_empty() {
                        return Err(CallError::Fatal(format!("{} returned an empty vector", self.spec.model)));
                    }
                    self.spec.dim = Some(v.len());
                    self.name = self.spec.name();
                }
            }
            normalise(&mut v);
            out.push(v);
        }
        Ok(out)
    }
}

fn short(text: &str) -> String {
    let t = text.trim();
    match t.char_indices().nth(200) {
        Some((i, _)) => format!("{}…", &t[..i]),
        None => t.to_string(),
    }
}

impl Embedder for RemoteEmbedder {
    fn name(&self) -> &str {
        &self.name
    }
    fn dim(&self) -> usize {
        self.spec.dim.unwrap_or(0)
    }
    fn is_fallback(&self) -> bool {
        false
    }
    fn embed(&mut self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        self.embed_documents(texts)
    }
    fn embed_documents(&mut self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let prefix = self.spec.document_prefix.clone();
        self.embed_with_prefix(texts, &prefix)
    }
    fn embed_query(&mut self, text: &str) -> Result<Vec<f32>> {
        let prefix = self.spec.query_prefix.clone();
        Ok(self.embed_with_prefix(&[text], &prefix)?.into_iter().next().unwrap_or_default())
    }
    fn warning(&self) -> Option<String> {
        let why = self.last_error.as_ref()?;
        Some(match self.open_until {
            Some(until) if Instant::now() < until => {
                format!("{} is unavailable and paused for {}s: {why}", self.name, (until - Instant::now()).as_secs())
            }
            _ => format!("{}: last request failed: {why}", self.name),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_is_validated() {
        assert!(RemoteSpec::default().validate().is_err());
        let ok = RemoteSpec { url: "http://x/v1".into(), model: "m".into(), ..Default::default() };
        assert!(ok.validate().is_ok());
        assert_eq!(ok.endpoint(), "http://x/v1/embeddings");
        let slash = RemoteSpec { url: "http://x/v1/".into(), ..ok.clone() };
        assert_eq!(slash.endpoint(), "http://x/v1/embeddings");
        let ftp = RemoteSpec { url: "ftp://x".into(), ..ok };
        assert!(ftp.validate().is_err());
    }

    #[test]
    fn override_key_wins_and_empty_keys_are_ignored() {
        let spec = RemoteSpec {
            url: "http://x/v1".into(),
            model: "m".into(),
            api_key: Some("stored".into()),
            ..Default::default()
        };
        assert_eq!(RemoteEmbedder::new(spec.clone(), Some("env")).unwrap().key.as_deref(), Some("env"));
        assert_eq!(RemoteEmbedder::new(spec.clone(), Some("")).unwrap().key.as_deref(), Some("stored"));
        assert_eq!(RemoteEmbedder::new(spec, None).unwrap().key.as_deref(), Some("stored"));
    }

    #[test]
    fn a_dead_endpoint_trips_the_breaker() {
        // Port 9 (discard) is closed on any sane machine; the connection is refused fast.
        let spec = RemoteSpec {
            url: "http://127.0.0.1:9/v1".into(),
            model: "m".into(),
            timeout_ms: 500,
            ..Default::default()
        };
        let mut e = RemoteEmbedder::new(spec, None).unwrap();
        for _ in 0..BREAKER_TRIP {
            assert!(e.embed(&["x"]).is_err());
        }
        assert!(e.open_until.is_some());
        let err = e.embed(&["x"]).unwrap_err().to_string();
        assert!(err.contains("cooldown"), "{err}");
        assert!(e.warning().unwrap().contains("paused"));
    }
}
