//! Entity extraction with no model: names, dates, quantities, paths, code
//! symbols and env vars found by shape. This is what the entity graph and the entity view of retrieval are
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
    /// A file path: `server/src/engine/embed-worker.ts`, `./run.sh`.
    Path,
    /// A code symbol: `quill::billing::flush`, `rebuild_aggregates`, `refresh()`.
    Symbol,
    /// An environment variable: `ZEROMEM_HOME`, `HERON_LEDGER_URL`.
    Env,
}

impl EntityKind {
    pub const ALL: [EntityKind; 6] = [
        EntityKind::Name,
        EntityKind::Date,
        EntityKind::Quantity,
        EntityKind::Path,
        EntityKind::Symbol,
        EntityKind::Env,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            EntityKind::Name => "name",
            EntityKind::Date => "date",
            EntityKind::Quantity => "quantity",
            EntityKind::Path => "path",
            EntityKind::Symbol => "symbol",
            EntityKind::Env => "env",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "name" => Some(EntityKind::Name),
            "date" => Some(EntityKind::Date),
            "quantity" => Some(EntityKind::Quantity),
            "path" => Some(EntityKind::Path),
            "symbol" => Some(EntityKind::Symbol),
            "env" => Some(EntityKind::Env),
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

/// `$230k`, `€1,200`, `12%`, `v2.1`, `3.5x`, `250ms`, `16GB`, `-5%`.
///
/// A unit suffix alone is not enough: the token has to *start* like a
/// number, so `embed-gemma-300m`, `k8s-1m` and `h264x` stay out. Those are
/// names that happen to end in a digit and a unit letter, and kinding them as
/// quantities put model and package names on the quantity axis.
fn quantity(word: &str) -> Option<String> {
    let w = word.to_lowercase().replace(',', "");
    let starts_money = w.starts_with(['$', '€', '£']);
    if !w.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    let is_version = w.starts_with('v') && w[1..].chars().next().is_some_and(|c| c.is_ascii_digit()) && w.contains('.');
    let unsigned = w.strip_prefix(['-', '+']).unwrap_or(&w);
    let starts_numeric = unsigned.starts_with(|c: char| c.is_ascii_digit());
    let ends_unit =
        w.ends_with('%') || w.ends_with(['k', 'm', 'x']) || w.ends_with("ms") || w.ends_with("gb") || w.ends_with("mb");
    let all_digits = unsigned.chars().all(|c| c.is_ascii_digit() || c == '.');
    if starts_money || is_version || (starts_numeric && ends_unit && !all_digits) {
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

/// File extensions that make a slash-free token a path (`Cargo.toml`) or a
/// one-slash token one (`src/lib.rs`, where `and/or` is not).
const EXTENSIONS: &[&str] = &[
    "c", "cc", "cjs", "cpp", "css", "go", "h", "html", "java", "js", "json", "jsonl", "jsx", "kt", "lock", "md", "mjs",
    "py", "rb", "rs", "sh", "sql", "swift", "toml", "ts", "tsx", "txt", "yaml", "yml",
];

fn is_ident(part: &str) -> bool {
    let mut chars = part.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn has_extension(segment: &str) -> bool {
    segment
        .rsplit_once('.')
        .is_some_and(|(stem, ext)| !stem.is_empty() && EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// `[A-Z][A-Z0-9]*` joined by `_`, at least two parts, with an optional
/// `=value` that is not part of the key: `ZEROMEM_HOME`, `TIMEOUT_MS=5000`.
fn env_var(token: &str) -> Option<&str> {
    let name = token.split_once('=').map_or(token, |(name, _)| name);
    let mut parts = name.split('_');
    let first = parts.next()?;
    let upper = |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    (first.starts_with(|c: char| c.is_ascii_uppercase()) && upper(first) && name.contains('_') && parts.all(upper))
        .then_some(name)
}

/// `a::b::c`, `snake_case`, or any identifier called as `name()`. The `()`
/// is not part of the key, so `refresh()` and `refresh` in a later turn are
/// one entity only when both are called — a bare `refresh` is a word.
fn symbol(token: &str) -> Option<&str> {
    let name = token.strip_suffix("()").unwrap_or(token);
    let called = name.len() < token.len();
    let qualified = name.contains("::") && name.split("::").all(is_ident);
    let snake = is_ident(name)
        && name.contains('_')
        && name.chars().any(|c| c.is_ascii_lowercase())
        && !name.starts_with('_')
        && !name.ends_with('_');
    let dotted_call = called && name.split('.').all(is_ident);
    (qualified || snake || dotted_call).then_some(name)
}

/// A token with a slash that reads as a path, not `and/or` or `24/7`: it is
/// rooted (`/`, `./`, `../`, `~/`), or has two slashes, or ends in a known
/// extension. A bare `Cargo.toml` counts too. URLs do not; a trailing
/// `:line[:col]` is dropped.
fn path(token: &str) -> Option<&str> {
    if token.contains("://") {
        return None;
    }
    let mut name = token;
    for _ in 0..2 {
        if let Some((head, tail)) = name.rsplit_once(':') {
            if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) {
                name = head;
            }
        }
    }
    let segment_ok = |seg: &str| seg.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '@' | '~'));
    let segments: Vec<&str> = name.trim_start_matches('/').trim_end_matches('/').split('/').collect();
    if segments.iter().any(|seg| seg.is_empty() || !segment_ok(seg)) {
        return None;
    }
    if !segments.iter().any(|seg| seg.chars().any(|c| c.is_alphabetic())) {
        return None;
    }
    let last = segments.last().copied().unwrap_or_default();
    let slashes = name.matches('/').count();
    let rooted = ["/", "./", "../", "~/"].iter().any(|r| name.starts_with(r));
    // `Node.js` and `Next.js` are products; `index.js` is a file.
    let product = slashes == 0 && last.ends_with(".js") && last.starts_with(char::is_uppercase);
    let shaped =
        if slashes == 0 { has_extension(last) && !product } else { rooted || slashes >= 2 || has_extension(last) };
    // A bare `v2.1` or `e.g` is not a file, and a bare name needs a real stem.
    (shaped && !(slashes == 0 && last.split('.').next().is_some_and(|s| s.len() < 2))).then_some(name)
}

/// Paths, symbols and env vars, found on whitespace-separated tokens before
/// `words()` sees the text: `words()` splits on `_` and `:` (and must, since
/// it also feeds the hash embedder), so a symbol would otherwise arrive in
/// pieces and an env var as a run of acronyms.
fn technical(text: &str) -> Vec<Mention> {
    let mut out = Vec::new();
    let mut offset = 0;
    for raw in text.split_inclusive(char::is_whitespace) {
        let start_of_raw = offset;
        offset += raw.len();
        let token = raw.trim_end();
        let lead = token.len() - token.trim_start_matches(['(', '[', '{', '"', '\'', '`', '<', '*']).len();
        // Trailing punctuation goes, and so does any `)` that closes
        // something opened before the token — but `refresh()` keeps its own.
        let mut trimmed = &token[lead..];
        loop {
            let before = trimmed.len();
            trimmed = trimmed.trim_end_matches([',', ';', '.', '!', '?', ']', '}', '"', '\'', '`', '>', '*', ':']);
            if trimmed.ends_with(')') && trimmed.matches(')').count() > trimmed.matches('(').count() {
                trimmed = &trimmed[..trimmed.len() - 1];
            }
            if trimmed.len() == before {
                break;
            }
        }
        if trimmed.is_empty() {
            continue;
        }
        let start = start_of_raw + lead;
        let found = if let Some(name) = env_var(trimmed) {
            Some((EntityKind::Env, name))
        } else if let Some(name) = path(trimmed) {
            Some((EntityKind::Path, name))
        } else {
            symbol(trimmed).map(|name| (EntityKind::Symbol, name))
        };
        if let Some((kind, name)) = found {
            out.push(Mention {
                key: name.to_lowercase(),
                kind,
                surface: name.to_string(),
                start,
                end: start + name.len(),
            });
        }
    }
    out
}

pub fn extract(text: &str) -> Vec<Mention> {
    let mut out = technical(text);
    let all = words(text);
    // The words between technical tokens, a run each, so a name or a date
    // never spans one: `Maya HERON_URL Okafor` is not a name.
    let mut runs: Vec<Vec<Word<'_>>> = vec![Vec::new()];
    for w in all {
        if out.iter().any(|m| w.start < m.end && m.start < w.end) {
            runs.push(Vec::new());
        } else {
            runs.last_mut().expect("never empty").push(w);
        }
    }
    for ws in &runs {
        shaped(text, ws, &mut out);
    }
    out.sort_by_key(|m| m.start);
    out
}

/// Names, dates and quantities in one run of words.
fn shaped(text: &str, ws: &[Word<'_>], out: &mut Vec<Mention>) {
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
    fn a_quantity_starts_like_a_number() {
        for q in ["$230k", "12%", "-5%", "v2.1", "3.5x", "250ms", "16GB", "300m"] {
            assert_eq!(quantity(q).as_deref(), Some(q.to_lowercase().as_str()), "{q}");
        }
        for not in ["embed-gemma-300m", "k8s-1m", "h264x", "o", "2025", "abc%"] {
            assert_eq!(quantity(not), None, "{not}");
        }
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
    fn paths_symbols_and_env_vars_are_whole_tokens() {
        assert_eq!(
            keys("the embed worker lives in `server/src/engine/embed-worker.ts:42` now, see Cargo.toml."),
            vec![
                ("server/src/engine/embed-worker.ts".into(), EntityKind::Path),
                ("cargo.toml".into(), EntityKind::Path)
            ]
        );
        assert_eq!(
            keys("set ZEROMEM_HOME=/data and HERON_LEDGER_URL, then call quill::billing::flush or rebuild_aggregates."),
            vec![
                ("zeromem_home".into(), EntityKind::Env),
                ("heron_ledger_url".into(), EntityKind::Env),
                ("quill::billing::flush".into(), EntityKind::Symbol),
                ("rebuild_aggregates".into(), EntityKind::Symbol),
            ]
        );
        assert_eq!(keys("(it is in refresh())."), vec![("refresh".into(), EntityKind::Symbol)]);
        // The same key whichever way it is typed, so a question finds it.
        assert_eq!(keys("HERON_LEDGER_URL")[0].0, keys("heron_ledger_url")[0].0);
    }

    #[test]
    fn slashes_and_dots_in_prose_are_not_paths() {
        for text in
            ["and/or", "24/7", "I/O", "e.g.", "v2.1", "https://example.com/a/b.rs", "3/14", "Node.js", "refresh"]
        {
            assert!(keys(text).iter().all(|(_, k)| !matches!(k, EntityKind::Path | EntityKind::Symbol)), "{text}");
        }
        assert_eq!(keys("TODO: ship it"), vec![("todo".into(), EntityKind::Name)], "an acronym is not an env var");
    }

    #[test]
    fn a_name_does_not_run_across_a_technical_token() {
        let text = "Maya HERON_URL Okafor pinged me about src/heron/ledger.rs today.";
        assert_eq!(
            keys(text),
            vec![
                ("maya".into(), EntityKind::Name),
                ("heron_url".into(), EntityKind::Env),
                ("okafor".into(), EntityKind::Name),
                ("src/heron/ledger.rs".into(), EntityKind::Path),
            ]
        );
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
