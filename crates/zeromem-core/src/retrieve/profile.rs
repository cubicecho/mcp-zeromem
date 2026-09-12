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

/// How many words a candidate key may span. `project heron rollout` is
/// plausible; beyond that an n-gram is a sentence, not a name.
pub const MAX_KEY_WORDS: usize = 4;

/// The question's word n-grams, longest first, in `entities::name_key`
/// space, as candidates to resolve against what the store already holds.
///
/// This is the query-side half of a problem the embedder has too: documents
/// and questions have to produce keys in the same space or the view returns
/// nothing. `entities::extract` is case-driven, so a lowercase question
/// yields no keys at all and `route::plan` drops the entity view.
///
/// The lookup that follows is exact, so this recovers case and not more: a
/// question saying `heron` still misses a store that only ever wrote
/// `Project Heron`.
///
/// Pure, so it stays unit-testable; the caller does the lookup.
pub fn candidate_keys(text: &str, max_words: usize) -> Vec<String> {
    let ws: Vec<&str> = words(text).into_iter().map(|w| w.text).collect();
    let mut out: Vec<String> = Vec::new();
    for n in (1..=max_words.min(ws.len())).rev() {
        for span in ws.windows(n) {
            // All-stopword spans are noise; one content word is enough to
            // make an n-gram worth asking about.
            if span.iter().all(|w| is_stopword(&normalise(w))) {
                continue;
            }
            let key = entities::name_key(&span.join(" "));
            if key.chars().count() < 2 || out.contains(&key) {
                continue;
            }
            out.push(key);
        }
    }
    out
}

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
    fn candidate_keys_are_longest_first_and_skip_all_stopword_spans() {
        let keys = candidate_keys("who owns the billing service on project heron?", MAX_KEY_WORDS);
        let at = |k: &str| keys.iter().position(|c| c == k).unwrap_or_else(|| panic!("missing {k}: {keys:?}"));
        assert!(at("who owns the billing") < at("project heron"), "{keys:?}");
        assert!(at("project heron") < at("heron"), "longer spans have to be offered first: {keys:?}");
        assert!(!keys.iter().any(|k| k == "on the" || k == "the"), "an all-stopword span is noise: {keys:?}");
        assert_eq!(keys.iter().filter(|k| *k == "heron").count(), 1, "no duplicates: {keys:?}");
        assert!(keys.iter().all(|k| k.split(' ').count() <= MAX_KEY_WORDS), "{keys:?}");
    }

    #[test]
    fn candidate_keys_are_in_the_same_space_as_a_mention() {
        // `entities::name_key` strips the possessive and the `?`, so a
        // question about `Sparrow's` resolves against the key a statement
        // about `Sparrow` wrote.
        let keys = candidate_keys("what date is Sparrow's code freeze?", MAX_KEY_WORDS);
        assert!(keys.contains(&"sparrow".to_string()), "{keys:?}");
        assert!(keys.iter().all(|k| k == &k.to_lowercase()), "{keys:?}");
    }

    #[test]
    fn cue_matches_whole_words_only() {
        assert!(!profile("the lastly known ballast").temporal);
        assert!(profile("as of today").temporal);
        assert!(!profile("nowhere near").temporal);
    }
}
