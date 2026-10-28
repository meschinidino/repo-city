//! Muse adapter: translates `muse exec --json` lines into
//! normalized events.
//!
//! Format (verified against the installed Muse CLI, one real run
//! plus one echo-provider run, 2026-10-28): one JSON object per
//! line. The envelope carries `payload_type` and `payload`, and the
//! top-level `stream.id` is the Muse session id. The payloads that
//! map are:
//! - `run.lifecycle.started` -> the run is live (SessionStarted).
//! - `tool.result` with `edit_facts` -> a file write or edit; the
//!   path is workspace-relative already.
//! - `run.terminal.completed` (and its failed/cancelled kin) ->
//!   the final agent text plus SessionFinished.
//!
//! `run.output.delta` lines are text fragments; the terminal line
//! carries the full text, so deltas are counted, not forwarded.
//! Anything else is counted as unmapped, never forwarded (R17/L2).

use serde_json::Value;

use crate::events::{ChangeKind, EventPayload, Outcome};

use super::claude::Translated;
use super::Stats;

fn unmapped(kind: String) -> Translated {
    Translated {
        events: Vec::new(),
        cli_session_id: None,
        unmapped_kind: Some(kind),
    }
}

/// Translate one `muse exec --json` line. Never fails: a line that
/// does not parse or does not map is reported through
/// `unmapped_kind`.
pub fn translate_line(line: &str) -> Translated {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return unmapped("non_json".to_string());
    };
    // Every line names its session in the envelope; that id is
    // what a later `muse exec --session-id` continues.
    let cli_session_id = value
        .get("stream")
        .filter(|s| s.get("kind").and_then(Value::as_str) == Some("session"))
        .and_then(|s| s.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(kind) = value.get("payload_type").and_then(Value::as_str) else {
        return Translated {
            events: Vec::new(),
            cli_session_id,
            unmapped_kind: Some("missing_type".to_string()),
        };
    };
    let payload = value.get("payload").cloned().unwrap_or(Value::Null);
    let with_id = |events: Vec<EventPayload>| Translated {
        events,
        cli_session_id: cli_session_id.clone(),
        unmapped_kind: None,
    };
    match kind {
        "run.lifecycle.started" => with_id(vec![EventPayload::SessionStarted {
            cli_session_id: cli_session_id.clone(),
        }]),
        "tool.result" => {
            let facts = payload.get("edit_facts");
            let path = facts
                .and_then(|f| f.get("path"))
                .and_then(Value::as_str);
            // A failed or refused write did not touch the file:
            // the map must not show an edit that never happened.
            let outcome = payload
                .get("correlation_facts")
                .and_then(|f| f.get("outcome"))
                .and_then(Value::as_str);
            let path = match outcome {
                Some("success") | None => path,
                Some(_) => None,
            };
            match path {
                Some(path) => {
                    let tool = facts
                        .and_then(|f| f.get("tool_name"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    with_id(vec![EventPayload::FileTouched {
                        path: path.to_string(),
                        change: if tool.contains("write") {
                            ChangeKind::Created
                        } else {
                            ChangeKind::Modified
                        },
                    }])
                }
                None => {
                    let tool = payload
                        .get("correlation_facts")
                        .and_then(|f| f.get("tool_name"))
                        .and_then(Value::as_str)
                        .unwrap_or("?");
                    let failed = outcome.is_some_and(|o| o != "success");
                    Translated {
                        events: Vec::new(),
                        cli_session_id,
                        unmapped_kind: Some(format!(
                            "tool_result{}:{tool}",
                            if failed { "_failed" } else { "" }
                        )),
                    }
                }
            }
        }
        _ if kind.starts_with("run.terminal.") => {
            // The terminal word is authoritative when present;
            // fall back to the payload_type suffix when it is not.
            let terminal = payload
                .get("terminal")
                .and_then(Value::as_str)
                .unwrap_or_else(|| kind.rsplit('.').next().unwrap_or(""));
            let outcome = match terminal {
                "completed" => Outcome::Completed,
                "cancelled" => Outcome::Stopped,
                _ => Outcome::Failed,
            };
            let text = payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let mut events = Vec::new();
            if !text.is_empty() && outcome == Outcome::Completed {
                events.push(EventPayload::AgentMessage { text: text.clone() });
            }
            let reason = match outcome {
                Outcome::Completed => None,
                _ => payload
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| (!text.is_empty()).then_some(text)),
            };
            events.push(EventPayload::SessionFinished { outcome, reason });
            with_id(events)
        }
        other => Translated {
            events: Vec::new(),
            cli_session_id,
            unmapped_kind: Some(other.to_string()),
        },
    }
}

/// Translate a whole recorded stream, accumulating pass-bar stats.
pub fn translate_stream(lines: &str) -> (Vec<EventPayload>, Option<String>, Stats) {
    let mut events = Vec::new();
    let mut cli_session_id = None;
    let mut stats = Stats::default();
    for line in lines.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let t = translate_line(line);
        if t.cli_session_id.is_some() {
            cli_session_id = t.cli_session_id;
        }
        if let Some(kind) = t.unmapped_kind {
            stats.unmapped += 1;
            stats.unmapped_kinds.push(kind);
        } else {
            stats.mapped += t.events.len();
        }
        events.extend(t.events);
    }
    (events, cli_session_id, stats)
}
