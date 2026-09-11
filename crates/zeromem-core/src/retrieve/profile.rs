//! What kind of question is this? Read once, used by routing and fusion.

use serde::{Deserialize, Serialize};

use crate::entities;
use crate::text::{is_stopword, normalise, words};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Profile {
    /// The question, whitespace-collapsed.
    pub text: String,
    /// Content words, normalised, in order, without repeats.
    pub tokens: Vec<String>,
    /// Entity keys the question mentions, in order, without repeats.
    pub entities: Vec<String>,
    /// Asks about the present or the recent past.
    pub temporal: bool,
    /// Phrased as a question.
    pub question: bool,
}

const TEMPORAL_CUES: &[&str] = &[
    "current",
    "currently",
    "latest",
    "last",
    "lately",
    "now",
    "nowadays",
    "recent",
    "recently",
    "still",
    "today",
    "yesterday",
    "this week",
    "these days",
    "at the moment",
    "as of",
];

pub fn profile(query: &str) -> Profile {
    let text = query.split_whitespace().collect::<Vec<_>>().join(" ");
    let lower = text.to_lowercase();
    let mut tokens: Vec<String> = Vec::new();
    for w in words(&text) {
        let n = normalise(w.text);
        if n.chars().count() < 2 || is_stopword(&n) || tokens.contains(&n) {
            continue;
        }
        tokens.push(n);
    }
    let mut keys: Vec<String> = Vec::new();
    for m in entities::extract(&text) {
        if !keys.contains(&m.key) {
            keys.push(m.key);
        }
    }
    let temporal = TEMPORAL_CUES.iter().any(|cue| contains_phrase(&lower, cue));
    let question = text.trim_end().ends_with('?')
        || ["what", "who", "when", "where", "which", "how", "why", "is", "are", "does", "do", "did", "was", "were"]
            .iter()
            .any(|q| lower.starts_with(q) && lower[q.len()..].starts_with(' '));
    Profile { text, tokens, entities: keys, temporal, question }
}

/// Whole-word containment of a (possibly multi-word) phrase.
fn contains_phrase(haystack: &str, phrase: &str) -> bool {
    let mut from = 0;
    while let Some(pos) = haystack[from..].find(phrase) {
        let start = from + pos;
        let end = start + phrase.len();
        let before_ok = start == 0 || !haystack[..start].ends_with(|c: char| c.is_alphanumeric());
        let after_ok = end == haystack.len() || !haystack[end..].starts_with(|c: char| c.is_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_tokens_entities_and_cues() {
        let p = profile("Who currently owns   the billing service on Project Heron?");
        assert_eq!(p.text, "Who currently owns the billing service on Project Heron?");
        assert!(p.tokens.contains(&"billing".to_string()));
        assert!(p.tokens.contains(&"heron".to_string()));
        assert!(!p.tokens.contains(&"the".to_string()));
        assert_eq!(p.entities, vec!["project heron"]);
        assert!(p.temporal);
        assert!(p.question);
    }

    #[test]
    fn plain_statement_has_no_cues() {
        let p = profile("Maya Okafor budget");
        assert!(!p.temporal);
        assert!(!p.question);
        assert_eq!(p.entities, vec!["maya okafor"]);
    }

    #[test]
    fn cue_matches_whole_words_only() {
        assert!(!profile("the lastly known ballast").temporal);
        assert!(profile("as of today").temporal);
        assert!(!profile("nowhere near").temporal);
    }
}
