//! The test harness for `zeromem-core`.
//!
//! Three things live here, all of them ours and none of them the engine:
//!
//! - [`corpus`]: a deterministic generator for multi-session dialogue with
//!   named people, projects, places, tools and dates, plus the labeled
//!   queries that go with it. Every fact the generator writes into a turn it
//!   also knows the answer to, so relevance labels fall out of generation
//!   rather than annotation.
//! - [`eval`]: recall@k, MRR and nDCG over a ranked list against those
//!   labels. This is the quality gate for retrieval; every other test in the
//!   suite only detects *change*.
//! - [`fixtures`]: the committed JSONL under `fixtures/`, regenerated with
//!   `cargo run -p zeromem-harness -- gen` and checked for freshness by this
//!   crate's own tests.
//!
//! The crate does not depend on `zeromem-core`; the engine's tests depend on
//! it. Turns are emitted in the engine's JSONL ingest shape.

pub mod compare;
pub mod corpus;
pub mod eval;
pub mod fixtures;
pub mod rng;
