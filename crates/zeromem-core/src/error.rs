use std::path::PathBuf;

/// Every failure the engine can report. The binding turns these into JS
/// errors and the CLI into exit codes, so the messages are written to be read
/// by an operator, not matched by code — except `Duplicate`, which callers
/// branch on.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("store home {0} does not exist and could not be created: {1}")]
    Home(PathBuf, std::io::Error),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("invalid turn: {0}")]
    InvalidTurn(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("embedder: {0}")]
    Embedder(String),
    #[error(
        "this store was built with the `{stored}` embedder but `{requested}` was requested; \
         switching would re-embed every turn — pass allow_embedder_switch to do that"
    )]
    EmbedderMismatch { stored: String, requested: String },
    /// Another process switched the store's embedder under this one; the
    /// write went through without vectors and the caller should re-read
    /// the store's spec.
    #[error("the store's embedder changed while this process was embedding with `{0}`")]
    EmbedderChanged(String),
    /// The store's generation moved (a delete, a clear, a switch) while this
    /// process was embedding a batch. The vectors were dropped: after a
    /// clear, the turn ids they were computed for can name other turns.
    #[error("the store changed while this process was embedding a batch")]
    StoreChanged,
}

pub type Result<T> = std::result::Result<T, Error>;
