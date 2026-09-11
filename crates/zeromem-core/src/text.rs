//! Word tokenisation shared by entity extraction, the hash embedder and
//! query profiling. One tokenizer, so a term means the same thing in every
//! index; the lexical index uses SQLite's own porter tokenizer, which agrees
//! on word boundaries for the ASCII case and is close enough elsewhere.

/// A word with its byte span in the source text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Word<'a> {
    pub text: &'a str,
    pub start: usize,
    pub end: usize,
    /// True when the word begins a sentence (first word, or follows . ! ?).
    pub sentence_start: bool,
}

/// Split on anything that is not alphanumeric, `'`, `-`, `.`, `$`, `%`,
/// `#`, `/` or `+` — the characters that appear inside things we want to
/// keep whole: `Quill's`, `v2.1`, `$230k`, `12%`, `C++`, `2025-03-14`.
/// Trailing punctuation is trimmed so "review." yields "review".
pub fn words(text: &str) -> Vec<Word<'_>> {
    let mut out = Vec::new();
    let mut sentence_start = true;
    let mut i = 0;
    let bytes = text.as_bytes();
    while i < text.len() {
        let c = text[i..].chars().next().unwrap();
        if is_word_char(c) {
            let start = i;
            let mut j = i;
            while j < text.len() {
                let c = text[j..].chars().next().unwrap();
                if !is_word_char(c) {
                    break;
                }
                j += c.len_utf8();
            }
            // Trim trailing punctuation that is not part of a token.
            let mut end = j;
            while end > start && matches!(bytes[end - 1], b'.' | b'\'' | b'-' | b'/' | b'#') {
                end -= 1;
            }
            let ended_sentence = end < j && text[end..j].contains('.');
            if end > start {
                out.push(Word { text: &text[start..end], start, end, sentence_start });
                sentence_start = ended_sentence;
            }
            i = j;
        } else {
            if matches!(c, '.' | '!' | '?' | '\n') {
                sentence_start = true;
            }
            i += c.len_utf8();
        }
    }
    out
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '\'' | '-' | '.' | '$' | '%' | '#' | '/' | '+' | '’')
}

/// Lower-case, possessive stripped, light suffix stemming. Used for the
/// hash embedder and for query-side matching; not for display.
pub fn normalise(word: &str) -> String {
    let mut w = word.to_lowercase();
    for suffix in ["'s", "’s", "'"] {
        if let Some(stripped) = w.strip_suffix(suffix) {
            w = stripped.to_string();
            break;
        }
    }
    w
}

/// A very light stemmer: enough that "flags"/"flag", "owns"/"own" and
/// "deployments"/"deployment" agree. Deliberately conservative; the lexical
/// index has a real porter stemmer and this only feeds the hash embedder
/// and entity keys.
pub fn stem(word: &str) -> String {
    let w = normalise(word);
    if w.len() <= 3 {
        return w;
    }
    for (suffix, keep_min) in [("ies", 3), ("sses", 4), ("ing", 4), ("ed", 4), ("s", 3)] {
        if let Some(base) = w.strip_suffix(suffix) {
            if base.len() >= keep_min && !base.ends_with('s') {
                return if suffix == "ies" { format!("{base}y") } else { base.to_string() };
            }
        }
    }
    w
}

pub fn is_stopword(word: &str) -> bool {
    STOPWORDS.binary_search(&word).is_ok()
}

/// Function words plus the verbs and adverbs that open a sentence in notes
/// ("Spent the afternoon…"), so a capital at the start of a sentence is not
/// mistaken for a name. Must stay sorted for the binary search.
const STOPWORDS: &[&str] = &[
    "a",
    "about",
    "above",
    "after",
    "again",
    "against",
    "all",
    "also",
    "am",
    "an",
    "and",
    "another",
    "any",
    "anything",
    "are",
    "around",
    "as",
    "at",
    "back",
    "be",
    "because",
    "been",
    "before",
    "being",
    "below",
    "between",
    "both",
    "but",
    "by",
    "can",
    "catching",
    "change",
    "coffee",
    "correction",
    "could",
    "did",
    "do",
    "does",
    "doing",
    "down",
    "during",
    "each",
    "else",
    "few",
    "finance",
    "for",
    "from",
    "further",
    "get",
    "got",
    "had",
    "has",
    "have",
    "having",
    "he",
    "heads",
    "her",
    "here",
    "hers",
    "him",
    "his",
    "how",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "just",
    "let",
    "like",
    "made",
    "make",
    "makes",
    "me",
    "might",
    "more",
    "most",
    "much",
    "must",
    "my",
    "need",
    "no",
    "nor",
    "not",
    "noted",
    "now",
    "of",
    "off",
    "okay",
    "on",
    "once",
    "one",
    "only",
    "or",
    "other",
    "our",
    "out",
    "over",
    "own",
    "picking",
    "please",
    "quick",
    "reminder",
    "right",
    "same",
    "she",
    "should",
    "since",
    "so",
    "some",
    "spent",
    "still",
    "such",
    "than",
    "thanks",
    "that",
    "the",
    "their",
    "theirs",
    "them",
    "then",
    "there",
    "these",
    "they",
    "this",
    "those",
    "through",
    "to",
    "today",
    "tomorrow",
    "too",
    "under",
    "understood",
    "until",
    "up",
    "update",
    "us",
    "very",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "while",
    "who",
    "whom",
    "why",
    "will",
    "with",
    "would",
    "yes",
    "yesterday",
    "you",
    "your",
    "yours",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopwords_are_sorted() {
        assert!(STOPWORDS.windows(2).all(|w| w[0] < w[1]), "keep STOPWORDS sorted");
    }

    #[test]
    fn words_keep_spans_and_sentence_starts() {
        let w = words("Quill's review is on March 14. Finance approved $230k for Quill.");
        let texts: Vec<_> = w.iter().map(|w| w.text).collect();
        assert_eq!(
            texts,
            ["Quill's", "review", "is", "on", "March", "14", "Finance", "approved", "$230k", "for", "Quill"]
        );
        assert!(w[0].sentence_start && w[6].sentence_start && !w[1].sentence_start);
        assert_eq!(&"Quill's review"[w[1].start..w[1].end], "review");
    }

    #[test]
    fn words_handle_unicode_and_versions() {
        let w = words("Kraków — v2.1 (Montréal), 2025-03-14!");
        let texts: Vec<_> = w.iter().map(|w| w.text).collect();
        assert_eq!(texts, ["Kraków", "v2.1", "Montréal", "2025-03-14"]);
    }

    #[test]
    fn stem_is_conservative() {
        assert_eq!(stem("Flags"), "flag");
        assert_eq!(stem("deployments"), "deployment");
        assert_eq!(stem("Quill's"), "quill");
        assert_eq!(stem("is"), "is");
        assert_eq!(stem("boss"), "boss");
        assert_eq!(stem("caching"), "cach");
    }
}
