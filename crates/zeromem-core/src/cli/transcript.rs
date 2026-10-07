//! Reading a Claude Code transcript into turns.
//!
//! The transcript is JSON Lines; each line has a `type` (`user`,
//! `assistant`, and others we skip), a `message` whose `content` is a string
//! or an array of blocks of which only `{"type":"text"}` matter, a
//! `timestamp` (RFC 3339) and a `uuid`. Anything that does not fit is
//! skipped rather than failing the hook — the hook must never break the
//! session it is watching.

use serde_json::Value;

use zeromem_core::dates::parse_rfc3339_ms;
use zeromem_core::TurnInput;

pub fn parse(session_id: &str, scope: Option<&str>, jsonl: &str) -> Vec<TurnInput> {
    jsonl.lines().filter_map(|line| turn_from_line(session_id, scope, line)).collect()
}

fn turn_from_line(session_id: &str, scope: Option<&str>, line: &str) -> Option<TurnInput> {
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
    Some(TurnInput {
        session_id: session_id.to_string(),
        speaker: speaker.into(),
        text,
        ts,
        uuid,
        scope: scope.map(str::to_string),
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_user_and_assistant_text_only() {
        let jsonl = r#"{"type":"user","uuid":"u1","timestamp":"2025-03-14T10:20:30Z","message":{"role":"user","content":"Who owns billing?"}}
{"type":"assistant","uuid":"a1","timestamp":"2025-03-14T10:20:31Z","message":{"role":"assistant","content":[{"type":"text","text":"Maya does."},{"type":"tool_use","name":"x"}]}}
{"type":"progress","message":{"content":"ignored"}}
{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","content":"ignored too"}]}}
not json
"#;
        let turns = parse("sess", None, jsonl);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].speaker, "user");
        assert_eq!(turns[0].uuid.as_deref(), Some("u1"));
        assert_eq!(turns[0].ts, Some(1_741_947_630_000));
        assert_eq!(turns[1].text, "Maya does.");
    }
}
