//! Convert an outside benchmark into this harness's corpus shape, so the
//! eval and `zm-harness compare` can run over something the generator did not
//! write. The output is a local file for a local run: it is never committed
//! and no floor reads it.
//!
//! The one format read today is LongMemEval's: a JSON array with one object
//! per question, each carrying the sessions to search (`haystack_sessions`,
//! with `haystack_session_ids` and `haystack_dates` beside them) and the
//! sessions that hold the answer (`answer_session_ids`). Parsing is by field
//! name over `serde_json::Value`, so a field this does not use, or a release
//! that adds one, does not break the import; what it cannot place is counted
//! in the [`Report`] instead of failing the file.

use std::collections::{HashMap, HashSet};

use anyhow::{bail, Context, Result};
use serde::Serialize;
use serde_json::Value;

use crate::corpus::{days_from_civil, Ask, Corpus, Query, Relevance, Turn, DAY_MS};

/// Turns of one session are a minute apart: the file dates a session, not a turn.
const TURN_GAP_MS: i64 = 60_000;

/// What an import kept and what it could not place.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct Report {
    pub questions: usize,
    pub sessions: usize,
    pub turns: usize,
    /// Questions marked unanswerable, written as `abstain` probes.
    pub abstain: usize,
    /// Answerable questions whose answer turns were marked in the file (grade 2).
    pub labeled_by_turn: usize,
    /// Answerable questions with no marked turn, labeled by answer session instead (grade 1).
    pub labeled_by_session: usize,
    /// Answerable questions with neither, left out: nothing to score them against.
    pub unlabeled: usize,
    /// Sessions whose date did not parse; their turns are stamped from zero.
    pub undated_sessions: usize,
}

/// Read a LongMemEval file into one merged corpus: every session once, however
/// many questions search it, and one query per question.
pub fn longmemeval(text: &str) -> Result<(Corpus, Report)> {
    let root: Value = serde_json::from_str(text).context("not JSON")?;
    let Some(items) = root.as_array() else { bail!("expected a JSON array of questions") };

    let mut report = Report::default();
    let mut turns = Vec::new();
    let mut queries = Vec::new();
    let mut probes = Vec::new();
    // session id → (uuid, marked as holding an answer) per turn, and the session's date.
    let mut seen: HashMap<String, Vec<String>> = HashMap::new();
    let mut dates: HashMap<String, i64> = HashMap::new();

    for (n, item) in items.iter().enumerate() {
        let Some(question) = item.get("question").and_then(Value::as_str) else { continue };
        report.questions += 1;
        let id = text_of(item.get("question_id")).unwrap_or_else(|| format!("q{n:05}"));
        let kind = text_of(item.get("question_type")).unwrap_or_else(|| "unknown".into());

        let sessions = item.get("haystack_sessions").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        let ids = item.get("haystack_session_ids").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        let when = item.get("haystack_dates").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        // A turn is marked per question, so the marks are collected here and
        // not stored with the session.
        let mut marked = Vec::new();
        for (s, session) in sessions.iter().enumerate() {
            let session_id = ids.get(s).and_then(|v| text_of(Some(v))).unwrap_or_else(|| format!("{id}-s{s:03}"));
            let Some(messages) = session.as_array() else { continue };
            if !seen.contains_key(&session_id) {
                let start = match when.get(s).and_then(Value::as_str).and_then(parse_date) {
                    Some(ms) => ms,
                    None => {
                        report.undated_sessions += 1;
                        0
                    }
                };
                dates.insert(session_id.clone(), start);
                let mut uuids = Vec::new();
                for (t, message) in messages.iter().enumerate() {
                    let Some(body) = message.get("content").and_then(Value::as_str) else { continue };
                    if body.trim().is_empty() {
                        continue;
                    }
                    let uuid = format!("{session_id}#{t}");
                    turns.push(Turn {
                        session_id: session_id.clone(),
                        speaker: text_of(message.get("role")).unwrap_or_else(|| "user".into()),
                        text: body.to_string(),
                        ts: start + t as i64 * TURN_GAP_MS,
                        uuid: uuid.clone(),
                    });
                    uuids.push(uuid);
                }
                report.sessions += 1;
                seen.insert(session_id.clone(), uuids);
            }
            for (t, message) in messages.iter().enumerate() {
                if message.get("has_answer").and_then(Value::as_bool) == Some(true) {
                    marked.push(format!("{session_id}#{t}"));
                }
            }
        }

        let answer_sessions: Vec<String> = item
            .get("answer_session_ids")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| text_of(Some(v))).collect())
            .unwrap_or_default();
        let latest_session_id =
            answer_sessions.iter().max_by_key(|s| dates.get(*s).copied().unwrap_or(0)).cloned().unwrap_or_default();

        // LongMemEval marks a question with no answer in the haystack by its id.
        if id.ends_with("_abs") {
            report.abstain += 1;
            probes.push(Query {
                id,
                kind,
                query: question.to_string(),
                latest_session_id: String::new(),
                relevant: Vec::new(),
                ask: Ask::Abstain,
            });
            continue;
        }

        let stored: HashSet<&str> = seen.values().flatten().map(String::as_str).collect();
        let mut relevant: Vec<Relevance> = marked
            .iter()
            .filter(|u| stored.contains(u.as_str()))
            .map(|u| Relevance { uuid: u.clone(), grade: 2 })
            .collect();
        if relevant.is_empty() {
            relevant = answer_sessions
                .iter()
                .filter_map(|s| seen.get(s))
                .flatten()
                .map(|u| Relevance { uuid: u.clone(), grade: 1 })
                .collect();
            if relevant.is_empty() {
                report.unlabeled += 1;
                continue;
            }
            report.labeled_by_session += 1;
        } else {
            report.labeled_by_turn += 1;
        }
        queries.push(Query { id, kind, query: question.to_string(), latest_session_id, relevant, ask: Ask::Current });
    }

    if report.questions == 0 {
        bail!("no object in the array has a `question`");
    }
    report.turns = turns.len();
    Ok((Corpus { turns, queries, probes }, report))
}

/// A string, or a number written as one: ids are both in the wild.
fn text_of(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// `2023/05/20 (Sat) 02:21`, and the same with dashes or without the weekday
/// or the time, as UTC milliseconds.
fn parse_date(text: &str) -> Option<i64> {
    let mut numbers =
        text.split(|c: char| !c.is_ascii_digit()).filter(|part| !part.is_empty()).map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (numbers.next()??, numbers.next()??, numbers.next()??);
    let hour = numbers.next().flatten().unwrap_or(0);
    let minute = numbers.next().flatten().unwrap_or(0);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    Some(days_from_civil(year, month, day) * DAY_MS + (hour * 60 + minute) * 60_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hand-written sample in the published shape, not an excerpt of the dataset.
    const SAMPLE: &str = r#"[
      {
        "question_id": "a1", "question_type": "knowledge-update",
        "question": "Where does Priya work now?", "answer": "Northwind",
        "question_date": "2023/06/01 (Thu) 09:00",
        "haystack_session_ids": ["s-old", "s-new", "s-other"],
        "haystack_dates": ["2023/05/01 (Mon) 10:00", "2023/05/20 (Sat) 02:21", "2023/05/02 (Tue) 08:00"],
        "haystack_sessions": [
          [{"role": "user", "content": "I work at Contoso."}, {"role": "assistant", "content": "Noted."}],
          [{"role": "user", "content": "I moved to Northwind.", "has_answer": true}, {"role": "assistant", "content": ""}],
          [{"role": "user", "content": "What is a good soup?"}]
        ],
        "answer_session_ids": ["s-old", "s-new"]
      },
      {
        "question_id": "a2", "question_type": "multi-session",
        "question": "What soup did I ask about?",
        "haystack_session_ids": ["s-other"],
        "haystack_dates": ["2023/05/02 (Tue) 08:00"],
        "haystack_sessions": [[{"role": "user", "content": "What is a good soup?"}]],
        "answer_session_ids": ["s-other"]
      },
      {
        "question_id": "a3_abs", "question_type": "single-session-user",
        "question": "What is my cat called?",
        "haystack_session_ids": ["s-other"],
        "haystack_dates": ["not a date"],
        "haystack_sessions": [[{"role": "user", "content": "What is a good soup?"}]],
        "answer_session_ids": []
      },
      {"question_id": 7, "question": "Nothing to search", "haystack_sessions": []}
    ]"#;

    #[test]
    fn a_sample_in_the_published_shape_becomes_one_merged_corpus() {
        let (corpus, report) = longmemeval(SAMPLE).unwrap();
        // s-other is searched by three questions and stored once; the empty turn is dropped.
        assert_eq!(report.sessions, 3);
        assert_eq!(corpus.turns.len(), 4);
        assert_eq!(report.turns, 4);
        assert_eq!(report.undated_sessions, 0, "a session keeps the first date it was given");

        let northwind = corpus.turns.iter().find(|t| t.uuid == "s-new#0").unwrap();
        assert_eq!(northwind.ts, 1_684_549_260_000);
        assert_eq!(corpus.turns.iter().find(|t| t.uuid == "s-old#1").unwrap().ts, 1_682_935_260_000);

        assert_eq!(corpus.queries.len(), 2);
        let update = &corpus.queries[0];
        assert_eq!((update.id.as_str(), update.kind.as_str()), ("a1", "knowledge-update"));
        assert_eq!(update.relevant, vec![Relevance { uuid: "s-new#0".into(), grade: 2 }]);
        assert_eq!(update.latest_session_id, "s-new");
        // No turn is marked, so the whole answer session stands in at grade 1.
        assert_eq!(corpus.queries[1].relevant, vec![Relevance { uuid: "s-other#0".into(), grade: 1 }]);

        assert_eq!(corpus.probes.len(), 1);
        assert_eq!(corpus.probes[0].ask, Ask::Abstain);
        assert!(corpus.probes[0].relevant.is_empty());

        assert_eq!(
            report,
            Report {
                questions: 4,
                sessions: 3,
                turns: 4,
                abstain: 1,
                labeled_by_turn: 1,
                labeled_by_session: 1,
                unlabeled: 1,
                undated_sessions: 0,
            }
        );
    }

    #[test]
    fn dates_parse_in_the_shapes_seen() {
        assert_eq!(parse_date("2023/05/20 (Sat) 02:21"), Some(1_684_549_260_000));
        assert_eq!(parse_date("2023-05-20"), Some(1_684_540_800_000));
        assert_eq!(parse_date("2023/13/01"), None);
        assert_eq!(parse_date("soon"), None);
    }

    #[test]
    fn a_file_that_is_not_the_format_is_refused() {
        assert!(longmemeval("{}").is_err());
        assert!(longmemeval("[{\"q\": 1}]").is_err());
    }
}
