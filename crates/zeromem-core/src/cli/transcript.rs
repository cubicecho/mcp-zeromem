//! Reading a Claude Code transcript into turns.
//!
//! The transcript is JSON Lines; each line has a `type` (`user`,
//! `assistant`, and others we skip), a `message` whose `content` is a string
//! or an array of blocks of which only `{"type":"text"}` matter, a
//! `timestamp` (RFC 3339) and a `uuid`. Anything that does not fit is
//! skipped rather than failing the hook — the hook must never break the
//! session it is watching.

use serde_json::Value;

use zeromem_core::TurnInput;

pub fn parse(session_id: &str, jsonl: &str) -> Vec<TurnInput> {
    jsonl.lines().filter_map(|line| turn_from_line(session_id, line)).collect()
}

fn turn_from_line(session_id: &str, line: &str) -> Option<TurnInput> {
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let speaker = match v.get("type")?.as_str()? {
        "user" => "user",
        "assistant" => "assistant",
        _ => return None,
    };
    let text = text_of(v.get("message")?.get("content")?)?;
    if text.trim().is_empty() {
        return None;
    }
    let ts = v.get("timestamp").and_then(Value::as_str).and_then(parse_rfc3339_ms);
    let uuid = v.get("uuid").and_then(Value::as_str).map(str::to_string);
    Some(TurnInput { session_id: session_id.to_string(), speaker: speaker.into(), text, ts, uuid })
}

fn text_of(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => {
            let parts: Vec<&str> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n\n"))
            }
        }
        _ => None,
    }
}

/// `2025-03-14T10:20:30.123Z` (or without fraction, or with a numeric
/// offset) to milliseconds since the epoch. Written by hand so the CLI does
/// not pull a date crate in for one field.
pub fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, rest) = s.split_once(['T', 't', ' '])?;
    let mut d = date.split('-');
    let (y, m, day): (i64, u32, u32) = (d.next()?.parse().ok()?, d.next()?.parse().ok()?, d.next()?.parse().ok()?);
    let (time, offset) = match rest.find(['Z', 'z', '+', '-']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "Z"),
    };
    let mut t = time.split(':');
    let (h, min): (i64, i64) = (t.next()?.parse().ok()?, t.next()?.parse().ok()?);
    let sec_str = t.next().unwrap_or("0");
    let (sec, frac) = sec_str.split_once('.').unwrap_or((sec_str, ""));
    let sec: i64 = sec.parse().ok()?;
    let millis: i64 = if frac.is_empty() {
        0
    } else {
        let digits: String = frac.chars().filter(char::is_ascii_digit).take(3).collect();
        let padded = format!("{digits:0<3}");
        padded.parse().ok()?
    };
    let offset_min: i64 = match offset {
        "Z" | "z" => 0,
        _ => {
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let body = &offset[1..];
            let (oh, om) = body.split_once(':').unwrap_or((body.get(..2)?, body.get(2..).unwrap_or("0")));
            sign * (oh.parse::<i64>().ok()? * 60 + om.parse::<i64>().unwrap_or(0))
        }
    };
    let days = days_from_civil(y, m, day);
    Some(((days * 86_400 + h * 3_600 + min * 60 + sec - offset_min * 60) * 1_000) + millis)
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (i64::from(m) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dates() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("2025-03-14T10:20:30.123Z"), Some(1_741_947_630_123));
        assert_eq!(parse_rfc3339_ms("2025-03-14T10:20:30+02:00"), Some(1_741_947_630_000 - 7_200_000));
        assert_eq!(parse_rfc3339_ms("nope"), None);
    }

    #[test]
    fn reads_user_and_assistant_text_only() {
        let jsonl = r#"{"type":"user","uuid":"u1","timestamp":"2025-03-14T10:20:30Z","message":{"role":"user","content":"Who owns billing?"}}
{"type":"assistant","uuid":"a1","timestamp":"2025-03-14T10:20:31Z","message":{"role":"assistant","content":[{"type":"text","text":"Maya does."},{"type":"tool_use","name":"x"}]}}
{"type":"progress","message":{"content":"ignored"}}
{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","content":"ignored too"}]}}
not json
"#;
        let turns = parse("sess", jsonl);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].speaker, "user");
        assert_eq!(turns[0].uuid.as_deref(), Some("u1"));
        assert_eq!(turns[0].ts, Some(1_741_947_630_000));
        assert_eq!(turns[1].text, "Maya does.");
    }
}
