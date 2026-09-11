//! Entity extraction with no model: names, dates and quantities found by
//! shape. This is what the entity graph and the entity view of retrieval are
//! built from, so it errs toward precision — a missed name costs one edge, a
//! false one pollutes the graph for every turn that shares the word.
//!
//! Spans are written with the turn and never recomputed; a change here
//! needs `ZeroMem::rebuild` to reach old turns.

use serde::{Deserialize, Serialize};

use crate::text::{is_stopword, words, Word};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    /// A capitalised run: a person, a project, a place, a product.
    Name,
    /// A calendar date, in any of the shapes `parse_date` accepts.
    Date,
    /// Money, percentages, versions, or a number with a unit.
    Quantity,
}

impl EntityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EntityKind::Name => "name",
            EntityKind::Date => "date",
            EntityKind::Quantity => "quantity",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "name" => Some(EntityKind::Name),
            "date" => Some(EntityKind::Date),
            "quantity" => Some(EntityKind::Quantity),
            _ => None,
        }
    }
}

/// One mention in one turn. `key` is the normalised identity shared across
/// mentions ("maya okafor", "march 14", "$230k"); `surface` is the text as
/// written; the span is in bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mention {
    pub key: String,
    pub kind: EntityKind,
    pub surface: String,
    pub start: usize,
    pub end: usize,
}

const MONTHS: &[(&str, u32)] = &[
    ("january", 1),
    ("jan", 1),
    ("february", 2),
    ("feb", 2),
    ("march", 3),
    ("mar", 3),
    ("april", 4),
    ("apr", 4),
    ("may", 5),
    ("june", 6),
    ("jun", 6),
    ("july", 7),
    ("jul", 7),
    ("august", 8),
    ("aug", 8),
    ("september", 9),
    ("sep", 9),
    ("sept", 9),
    ("october", 10),
    ("oct", 10),
    ("november", 11),
    ("nov", 11),
    ("december", 12),
    ("dec", 12),
];

fn month(word: &str) -> Option<u32> {
    let w = word.to_lowercase();
    MONTHS.iter().find(|(m, _)| *m == w).map(|(_, n)| *n)
}

fn day(word: &str) -> Option<u32> {
    let w = word.trim_end_matches([',', '.']);
    let w = w
        .strip_suffix("st")
        .or_else(|| w.strip_suffix("nd"))
        .or_else(|| w.strip_suffix("rd"))
        .or_else(|| w.strip_suffix("th"))
        .unwrap_or(w);
    let d: u32 = w.parse().ok()?;
    (1..=31).contains(&d).then_some(d)
}

fn year(word: &str) -> Option<u32> {
    let y: u32 = word.trim_end_matches(',').parse().ok()?;
    (1900..=2200).contains(&y).then_some(y)
}

/// `2025-03-14`, `March 14`, `March 14, 2025`, `14 March`, `14 March 2025`.
/// The key is `YYYY-MM-DD` when a year is present and `MM-DD` otherwise, so
/// "March 14" and "Mar 14" agree.
fn parse_date(ws: &[Word<'_>]) -> Option<(String, usize)> {
    let first = ws.first()?;
    if let Some((y, rest)) = first.text.split_once('-') {
        if let Some((m, d)) = rest.split_once('-') {
            if let (Some(y), Ok(m), Ok(d)) = (year(y), m.parse::<u32>(), d.parse::<u32>()) {
                if (1..=12).contains(&m) && (1..=31).contains(&d) {
                    return Some((format!("{y:04}-{m:02}-{d:02}"), 1));
                }
            }
        }
    }
    if let Some(m) = month(first.text) {
        let d = ws.get(1).and_then(|w| day(w.text))?;
        if let Some(y) = ws.get(2).and_then(|w| year(w.text)) {
            return Some((format!("{y:04}-{m:02}-{d:02}"), 3));
        }
        return Some((format!("{m:02}-{d:02}"), 2));
    }
    if let Some(d) = day(first.text) {
        let m = ws.get(1).and_then(|w| month(w.text))?;
        if let Some(y) = ws.get(2).and_then(|w| year(w.text)) {
            return Some((format!("{y:04}-{m:02}-{d:02}"), 3));
        }
        return Some((format!("{m:02}-{d:02}"), 2));
    }
    None
}

/// `$230k`, `€1,200`, `12%`, `v2.1`, `3.5x`, `250ms`, `16GB`.
fn quantity(word: &str) -> Option<String> {
    let w = word.to_lowercase().replace(',', "");
    let starts_money = w.starts_with(['$', '€', '£']);
    let has_digit = w.chars().any(|c| c.is_ascii_digit());
    if !has_digit {
        return None;
    }
    let is_version = w.starts_with('v') && w[1..].chars().next().is_some_and(|c| c.is_ascii_digit()) && w.contains('.');
    let ends_unit =
        w.ends_with('%') || w.ends_with(['k', 'm', 'x']) || w.ends_with("ms") || w.ends_with("gb") || w.ends_with("mb");
    let all_digits = w.chars().all(|c| c.is_ascii_digit() || c == '.');
    if starts_money || is_version || (ends_unit && !all_digits && w.chars().filter(|c| c.is_ascii_digit()).count() >= 1)
    {
        return Some(w);
    }
    None
}

fn is_capitalised(word: &str) -> bool {
    let mut chars = word.chars();
    match chars.next() {
        Some(c) if c.is_uppercase() => chars.all(|c| c.is_alphanumeric() || matches!(c, '\'' | '’' | '-' | '.')),
        _ => false,
    }
}

fn is_acronym(word: &str) -> bool {
    word.len() >= 2
        && word.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && word.chars().any(|c| c.is_ascii_alphabetic())
}

/// Connectors allowed inside a multi-word name when both sides are capitalised.
const CONNECTORS: &[&str] = &["of", "de", "van", "von", "der", "and", "&", "the"];

pub fn extract(text: &str) -> Vec<Mention> {
    let ws = words(text);
    let mut out = Vec::new();
    let mut i = 0;
    while i < ws.len() {
        let w = &ws[i];
        if let Some((key, n)) = parse_date(&ws[i..]) {
            let end = ws[i + n - 1].end;
            out.push(Mention {
                key,
                kind: EntityKind::Date,
                surface: text[w.start..end].to_string(),
                start: w.start,
                end,
            });
            i += n;
            continue;
        }
        if let Some(key) = quantity(w.text) {
            out.push(Mention {
                key,
                kind: EntityKind::Quantity,
                surface: w.text.to_string(),
                start: w.start,
                end: w.end,
            });
            i += 1;
            continue;
        }
        if is_name_token(w) {
            // Extend over further capitalised tokens, allowing one connector.
            let mut j = i + 1;
            while j < ws.len() {
                if is_capitalised(ws[j].text) && !ws[j].sentence_start && !is_stopword(&ws[j].text.to_lowercase()) {
                    j += 1;
                } else if j + 1 < ws.len()
                    && CONNECTORS.contains(&ws[j].text.to_lowercase().as_str())
                    && is_capitalised(ws[j + 1].text)
                    && !ws[j + 1].sentence_start
                {
                    j += 2;
                } else {
                    break;
                }
            }
            let end = ws[j - 1].end;
            let surface = &text[w.start..end];
            let key = name_key(surface);
            if !key.is_empty() {
                out.push(Mention { key, kind: EntityKind::Name, surface: surface.to_string(), start: w.start, end });
            }
            i = j;
            continue;
        }
        i += 1;
    }
    out
}

fn is_name_token(w: &Word<'_>) -> bool {
    if is_acronym(w.text) {
        return true;
    }
    if !is_capitalised(w.text) {
        return false;
    }
    let lower = w.text.to_lowercase();
    let lower = lower.trim_end_matches("'s").trim_end_matches("’s");
    if is_stopword(lower) {
        return false;
    }
    // A lone capital at the start of a sentence is more often a sentence
    // than a name, unless it looks like one: has an internal capital or a
    // digit, is an acronym, or is followed by another capitalised word.
    !w.sentence_start
        || w.text.chars().skip(1).any(|c| c.is_uppercase() || c.is_ascii_digit())
        || month(w.text).is_none() && looks_like_name_start(w.text)
}

/// Heuristic for sentence-initial capitals: proper nouns in notes are mostly
/// short, and the common-word filter has already run; keep them. Days and
/// months are dates, not names.
fn looks_like_name_start(word: &str) -> bool {
    !matches!(
        word.to_lowercase().as_str(),
        "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday"
    )
}

/// Lower-case, possessive stripped, inner whitespace collapsed.
pub fn name_key(surface: &str) -> String {
    let lowered = surface.to_lowercase();
    lowered
        .split_whitespace()
        .map(|w| w.trim_end_matches("'s").trim_end_matches("’s").trim_end_matches('\''))
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(text: &str) -> Vec<(String, EntityKind)> {
        extract(text).into_iter().map(|m| (m.key, m.kind)).collect()
    }

    #[test]
    fn names_dates_and_money() {
        let got = keys("Maya Okafor owns the billing service on Project Heron; the launch is on March 14 and finance approved $230k.");
        assert_eq!(
            got,
            vec![
                ("maya okafor".into(), EntityKind::Name),
                ("project heron".into(), EntityKind::Name),
                ("03-14".into(), EntityKind::Date),
                ("$230k".into(), EntityKind::Quantity),
            ]
        );
    }

    #[test]
    fn sentence_initial_common_words_are_not_names() {
        assert_eq!(
            keys("The notification worker tests were flaky again on Quill."),
            vec![("quill".into(), EntityKind::Name)]
        );
        assert_eq!(
            keys("Spent the afternoon reading through Quill tickets."),
            vec![("quill".into(), EntityKind::Name)]
        );
        assert_eq!(keys("Noted."), vec![]);
        assert_eq!(
            keys("Heads up, we've set Quill's security review for January 11."),
            vec![("quill".into(), EntityKind::Name), ("01-11".into(), EntityKind::Date)]
        );
    }

    #[test]
    fn sentence_initial_names_survive() {
        assert_eq!(
            keys("Kenji Morimoto is based in Osaka."),
            vec![("kenji morimoto".into(), EntityKind::Name), ("osaka".into(), EntityKind::Name)]
        );
        assert_eq!(
            keys("Quill has $400k to spend this quarter."),
            vec![("quill".into(), EntityKind::Name), ("$400k".into(), EntityKind::Quantity)]
        );
    }

    #[test]
    fn date_shapes_agree_on_a_key() {
        assert_eq!(keys("on 2025-03-14"), keys("on March 14, 2025"));
        assert_eq!(keys("on 14 March 2025"), keys("on Mar 14th, 2025"));
        assert_eq!(keys("Sept 3")[0].0, "09-03");
    }

    #[test]
    fn spans_index_the_source() {
        let text = "Tomasz Wierzbicki pinged me about Project Basalt.";
        for m in extract(text) {
            assert_eq!(&text[m.start..m.end], m.surface);
        }
    }

    #[test]
    fn acronyms_and_connectors() {
        assert_eq!(
            keys("we're using SQL on the Bank of Ireland account"),
            vec![("sql".into(), EntityKind::Name), ("bank of ireland".into(), EntityKind::Name)]
        );
        assert_eq!(
            keys("v2.1 ships at 12% over 250ms"),
            vec![
                ("v2.1".into(), EntityKind::Quantity),
                ("12%".into(), EntityKind::Quantity),
                ("250ms".into(), EntityKind::Quantity)
            ]
        );
    }
}
