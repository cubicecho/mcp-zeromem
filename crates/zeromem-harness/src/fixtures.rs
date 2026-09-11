//! The committed corpora under `crates/zeromem-harness/fixtures/<profile>/`.
//!
//! `turns.jsonl` is what `zm ingest` reads; `queries.jsonl` is what the eval
//! reads. Both are regenerated with `cargo run -p zeromem-harness -- gen`,
//! and `fixtures_are_fresh` in this crate fails if the committed bytes and
//! the generator disagree — change the generator, regenerate, commit both.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::corpus::{self, Corpus, Profile, Query, Turn};

pub fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

pub fn profile_dir(profile: &Profile) -> PathBuf {
    dir().join(profile.name)
}

pub fn turns_path(profile: &Profile) -> PathBuf {
    profile_dir(profile).join("turns.jsonl")
}

pub fn queries_path(profile: &Profile) -> PathBuf {
    profile_dir(profile).join("queries.jsonl")
}

/// One JSON document per line, newline-terminated.
pub fn to_jsonl<T: Serialize>(items: &[T]) -> Result<String> {
    let mut out = String::new();
    for item in items {
        out.push_str(&serde_json::to_string(item)?);
        out.push('\n');
    }
    Ok(out)
}

pub fn from_jsonl<T: DeserializeOwned>(text: &str) -> Result<Vec<T>> {
    text.lines()
        .enumerate()
        .filter(|(_, l)| !l.trim().is_empty())
        .map(|(n, l)| serde_json::from_str(l).with_context(|| format!("line {}", n + 1)))
        .collect()
}

/// Render a corpus as the two files it is committed as.
pub fn render(corpus: &Corpus) -> Result<(String, String)> {
    Ok((to_jsonl(&corpus.turns)?, to_jsonl(&corpus.queries)?))
}

/// Regenerate and write every profile. Returns the files written.
pub fn write_all() -> Result<Vec<PathBuf>> {
    let mut written = Vec::new();
    for profile in corpus::PROFILES {
        let corpus = corpus::generate(profile);
        let (turns, queries) = render(&corpus)?;
        let dir = profile_dir(profile);
        std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
        for (name, body) in [("turns.jsonl", turns), ("queries.jsonl", queries)] {
            let path = dir.join(name);
            std::fs::write(&path, body).with_context(|| format!("writing {}", path.display()))?;
            written.push(path);
        }
    }
    Ok(written)
}

/// Load the committed corpus for a profile.
pub fn load(profile: &Profile) -> Result<Corpus> {
    let turns = std::fs::read_to_string(turns_path(profile)).with_context(|| {
        format!("reading {}; run `cargo run -p zeromem-harness -- gen`", turns_path(profile).display())
    })?;
    let queries = std::fs::read_to_string(queries_path(profile))
        .with_context(|| format!("reading {}", queries_path(profile).display()))?;
    Ok(Corpus { turns: from_jsonl::<Turn>(&turns)?, queries: from_jsonl::<Query>(&queries)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The committed files are exactly what the generator produces today.
    #[test]
    fn fixtures_are_fresh() {
        for profile in corpus::PROFILES {
            let (turns, queries) = render(&corpus::generate(profile)).unwrap();
            let on_disk = std::fs::read_to_string(turns_path(profile)).unwrap_or_default();
            assert!(
                on_disk == turns,
                "{}/turns.jsonl is stale; run `cargo run -p zeromem-harness -- gen` and commit the result",
                profile.name
            );
            let on_disk = std::fs::read_to_string(queries_path(profile)).unwrap_or_default();
            assert!(on_disk == queries, "{}/queries.jsonl is stale; regenerate and commit", profile.name);
        }
    }

    #[test]
    fn jsonl_round_trips() {
        let corpus = corpus::generate(&corpus::SMALL);
        let (turns, queries) = render(&corpus).unwrap();
        assert_eq!(from_jsonl::<Turn>(&turns).unwrap(), corpus.turns);
        assert_eq!(from_jsonl::<Query>(&queries).unwrap(), corpus.queries);
    }

    #[test]
    fn load_reads_what_write_wrote() {
        let loaded = load(&corpus::SMALL).unwrap();
        assert_eq!(loaded, corpus::generate(&corpus::SMALL));
    }
}
