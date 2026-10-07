//! The period a question names, read from its words with no model.
//!
//! `in March 2025`, `2025-03-14`, `yesterday`, `last week`, `3 days ago`,
//! `in 2024`. Everything is UTC and whole calendar units: a day, a
//! Monday-to-Sunday week, a month, a year. Relative phrases count from the
//! newest turn in the store, the same "now" recency is measured from, so a
//! store that was last written to a month ago still answers `yesterday` with
//! its own last day rather than with nothing.
//!
//! A bare month (`in March`) is not read: it names an event's date as often
//! as the time a statement was made, and without a year it is a guess. So is
//! a bare number that could be a year, unless a preposition introduces it.

use serde::{Deserialize, Serialize};

use crate::dates::{civil_from_days, days_from_civil, DAY_MS};

/// `[start, end)` in milliseconds since the epoch.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Window {
    pub start: i64,
    pub end: i64,
}

const MONTHS: &[&str] = &[
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

const COUNTS: &[&str] =
    &["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/// Words that make a bare four-digit number a year.
const YEAR_INTRODUCERS: &[&str] = &["in", "during", "of", "for", "throughout"];

fn month_number(word: &str) -> Option<u32> {
    let full = MONTHS.iter().position(|m| *m == word);
    let short = || MONTHS.iter().position(|m| word.len() == 3 && m.starts_with(word)).or((word == "sept").then_some(8));
    full.or_else(short).map(|i| i as u32 + 1)
}

fn year(word: &str) -> Option<i64> {
    (word.len() == 4 && word.bytes().all(|b| b.is_ascii_digit()))
        .then(|| word.parse::<i64>().ok())
        .flatten()
        .filter(|y| (1970..2200).contains(y))
}

fn day_of_month(word: &str) -> Option<u32> {
    let digits = word.trim_end_matches(|c: char| c.is_ascii_alphabetic());
    let suffix = &word[digits.len()..];
    if !matches!(suffix, "" | "st" | "nd" | "rd" | "th") {
        return None;
    }
    digits.parse::<u32>().ok().filter(|d| (1..=31).contains(d))
}

fn count(word: &str) -> Option<i64> {
    match word {
        "a" | "an" => Some(1),
        _ => COUNTS.iter().position(|c| *c == word).map(|i| i as i64 + 1).or_else(|| word.parse().ok()),
    }
    .filter(|n| (1..=1_000).contains(n))
}

fn day(y: i64, m: u32, d: u32) -> Option<Window> {
    let days = days_from_civil(y, m, d);
    // Reject the 31st of a 30-day month instead of rolling it over.
    (civil_from_days(days) == (y, m, d)).then_some(Window { start: days * DAY_MS, end: (days + 1) * DAY_MS })
}

/// The month `offset` months after `(y, m)`.
fn month(y: i64, m: u32, offset: i64) -> Window {
    let at = |index: i64| days_from_civil(index.div_euclid(12), index.rem_euclid(12) as u32 + 1, 1) * DAY_MS;
    let index = y * 12 + i64::from(m) - 1 + offset;
    Window { start: at(index), end: at(index + 1) }
}

fn whole_year(y: i64) -> Window {
    Window { start: days_from_civil(y, 1, 1) * DAY_MS, end: days_from_civil(y + 1, 1, 1) * DAY_MS }
}

/// `2025-03-14` or `2025-03`.
fn iso(word: &str) -> Option<Window> {
    let mut parts = word.split('-');
    let (y, m) = (year(parts.next()?)?, parts.next()?);
    let m = (m.len() == 2).then(|| m.parse::<u32>().ok()).flatten().filter(|m| (1..=12).contains(m))?;
    match parts.next() {
        None => Some(month(y, m, 0)),
        Some(d) if d.len() == 2 && parts.next().is_none() => day(y, m, d.parse().ok()?),
        Some(_) => None,
    }
}

/// `n` units back from `now`, as the whole calendar unit that lands in.
fn back(now: i64, n: i64, unit: &str) -> Option<Window> {
    let today = now.div_euclid(DAY_MS);
    let (y, m, _) = civil_from_days(today);
    match unit.trim_end_matches('s') {
        "day" => Some(Window { start: (today - n) * DAY_MS, end: (today - n + 1) * DAY_MS }),
        "week" => {
            // 1970-01-01 was a Thursday; weeks start on Monday.
            let monday = today - (today + 3).rem_euclid(7) - 7 * n;
            Some(Window { start: monday * DAY_MS, end: (monday + 7) * DAY_MS })
        }
        "month" => Some(month(y, m, -n)),
        "year" => Some(whole_year(y - n)),
        _ => None,
    }
}

/// The period `text` names, if it names one. `now` anchors the relative
/// phrases. The most specific reading wins: a date, then a month and year,
/// then a relative phrase, then a bare year.
pub fn parse(text: &str, now: i64) -> Option<Window> {
    let lower = text.to_lowercase();
    let words: Vec<&str> = lower
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()))
        .map(|w| w.strip_suffix("'s").unwrap_or(w))
        .filter(|w| !w.is_empty())
        .collect();
    let at = |i: usize| words.get(i).copied().unwrap_or("");

    if let Some(w) = words.iter().find_map(|w| iso(w)) {
        return Some(w);
    }
    for (i, w) in words.iter().enumerate() {
        let Some(m) = month_number(w) else { continue };
        // `14 March 2025`, `March 14 2025`, `March 2025`.
        if let Some(y) = year(at(i + 1)) {
            let d = i.checked_sub(1).and_then(|j| day_of_month(words[j]));
            return d.and_then(|d| day(y, m, d)).or(Some(month(y, m, 0)));
        }
        if let (Some(d), Some(y)) = (day_of_month(at(i + 1)), year(at(i + 2))) {
            if let Some(w) = day(y, m, d) {
                return Some(w);
            }
        }
    }
    for (i, w) in words.iter().enumerate() {
        let found = match *w {
            "yesterday" => back(now, 1, "day"),
            "last" => back(now, 1, at(i + 1)).filter(|_| !at(i + 1).ends_with('s')),
            "ago" if i >= 2 => count(words[i - 2]).and_then(|n| back(now, n, words[i - 1])),
            _ => None,
        };
        if found.is_some() {
            return found;
        }
    }
    words.iter().enumerate().find_map(|(i, w)| {
        let introduced = i.checked_sub(1).is_some_and(|j| YEAR_INTRODUCERS.contains(&words[j]));
        year(w).filter(|_| introduced).map(whole_year)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dates::parse_rfc3339_ms;

    fn ms(date: &str) -> i64 {
        parse_rfc3339_ms(&format!("{date}T00:00:00Z")).unwrap()
    }

    fn window(start: &str, end: &str) -> Option<Window> {
        Some(Window { start: ms(start), end: ms(end) })
    }

    /// A Wednesday.
    const NOW: &str = "2025-06-18";

    fn read(text: &str) -> Option<Window> {
        parse(text, ms(NOW) + 13 * 3_600_000)
    }

    #[test]
    fn reads_absolute_dates() {
        assert_eq!(read("Who owned the importer in March 2025?"), window("2025-03-01", "2025-04-01"));
        assert_eq!(read("In December 2024, where was Maya based?"), window("2024-12-01", "2025-01-01"));
        assert_eq!(read("what changed in sept 2024"), window("2024-09-01", "2024-10-01"));
        assert_eq!(read("what did we decide on 2025-03-14?"), window("2025-03-14", "2025-03-15"));
        assert_eq!(read("the plan as of 2025-02"), window("2025-02-01", "2025-03-01"));
        assert_eq!(read("who was on call on March 14, 2025"), window("2025-03-14", "2025-03-15"));
        assert_eq!(read("who was on call on 14th March 2025"), window("2025-03-14", "2025-03-15"));
        assert_eq!(read("the budget in 2024"), window("2024-01-01", "2025-01-01"));
        assert_eq!(read("the budget as of 2024?"), window("2024-01-01", "2025-01-01"));
    }

    #[test]
    fn reads_relative_phrases_from_now() {
        assert_eq!(read("what did we decide yesterday?"), window("2025-06-17", "2025-06-18"));
        assert_eq!(read("what broke 3 days ago"), window("2025-06-15", "2025-06-16"));
        assert_eq!(read("what did we ship last week?"), window("2025-06-09", "2025-06-16"));
        assert_eq!(read("the plan two weeks ago"), window("2025-06-02", "2025-06-09"));
        assert_eq!(read("who was on call last month"), window("2025-05-01", "2025-06-01"));
        assert_eq!(read("a month ago"), window("2025-05-01", "2025-06-01"));
        assert_eq!(read("what was the budget last year?"), window("2024-01-01", "2025-01-01"));
        assert_eq!(parse("7 months ago", ms("2025-03-31")), window("2024-08-01", "2024-09-01"));
    }

    #[test]
    fn leaves_what_is_not_a_period_alone() {
        for text in [
            "When is the Atlas launch in March?",
            "what listens on port 2025",
            "what may 2 people do",
            "the last change to the importer",
            "the last weeks were rough",
            "who owns billing?",
            "see 2025-13-01 and 2025-02-30",
            "long ago",
        ] {
            assert_eq!(read(text), None, "{text}");
        }
    }

    #[test]
    fn a_date_wins_over_a_looser_phrase() {
        assert_eq!(read("last week we said March 2025 was the deadline"), window("2025-03-01", "2025-04-01"));
    }
}
