//! Claude Code adapter: translates `claude -p --output-format
//! stream-json` lines into normalized events.
//!
//! Format (verified against the installed CLI 2.1.293): one JSON
//! object per line — `system/init` carries `session_id`; `assistant`
//! messages carry `text` and `tool_use` blocks (`Edit`/`Write` with
//! `file_path`, `Bash` with `command`); `result` closes the run with
//! `is_error`. Anything else is counted as unmapped, never forwarded.

use serde_json::Value;

use crate::events::{ChangeKind, EventPayload, Outcome};

use super::Stats;

/// One translated line: zero or more normalized events, the CLI
/// session id when the line carries one, and the raw type label when
/// the line produced nothing (for the unmapped count).
pub struct Translated {
    pub events: Vec<EventPayload>,
    pub cli_session_id: Option<String>,
    pub unmapped_kind: Option<String>,
}

fn unmapped(kind: String) -> Translated {
    Translated {
        events: Vec::new(),
        cli_session_id: None,
        unmapped_kind: Some(kind),
    }
}

fn file_touched(content: &Value) -> Option<EventPayload> {
    let name = content.get("name")?.as_str()?;
    let input = content.get("input")?;
    match name {
        "Edit" | "Write" | "NotebookEdit" => {
            let path = input
                .get("file_path")
                .or_else(|| input.get("notebook_path"))?
                .as_str()?;
            Some(EventPayload::FileTouched {
                path: path.to_string(),
                change: if name == "Write" {
                    ChangeKind::Created
                } else {
                    ChangeKind::Modified
                },
            })
        }
        "Bash" => Some(EventPayload::CommandRun {
            command: input.get("command")?.as_str()?.to_string(),
            exit_code: None,
        }),
        _ => None,
    }
}

/// Translate one stream-json line. Never fails: a line that does not
/// parse or does not map is reported through `unmapped_kind`.
pub fn translate_line(line: &str) -> Translated {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return unmapped("non_json".to_string());
    };
    let Some(kind) = value.get("type").and_then(Value::as_str) else {
        return unmapped("missing_type".to_string());
    };
    match kind {
        "system" => {
            let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
            if subtype == "init" {
                let cli_session_id = value
                    .get("session_id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                Translated {
                    events: vec![EventPayload::SessionStarted {
                        cli_session_id: cli_session_id.clone(),
                    }],
                    cli_session_id,
                    unmapped_kind: None,
                }
            } else {
                unmapped(format!("system:{subtype}"))
            }
        }
        "assistant" => {
            let mut events = Vec::new();
            let mut kinds: Vec<String> = Vec::new();
            if let Some(content) = value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
            {
                for block in content {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(text) = block.get("text").and_then(Value::as_str) {
                                if !text.trim().is_empty() {
                                    events.push(EventPayload::AgentMessage {
                                        text: text.to_string(),
                                    });
                                }
                            }
                        }
                        Some("tool_use") => match file_touched(block) {
                            Some(event) => events.push(event),
                            None => kinds.push(format!(
                                "tool_use:{}",
                                block.get("name").and_then(Value::as_str).unwrap_or("?")
                            )),
                        },
                        other => kinds.push(format!("assistant:{}", other.unwrap_or("?"))),
                    }
                }
            }
            if events.is_empty() {
                unmapped(
                    kinds
                        .into_iter()
                        .next()
                        .unwrap_or_else(|| "assistant:empty".to_string()),
                )
            } else {
                Translated {
                    events,
                    cli_session_id: None,
                    unmapped_kind: None,
                }
            }
        }
        "result" => {
            let is_error = value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let reason = value
                .get("result")
                .and_then(Value::as_str)
                .map(str::to_string);
            Translated {
                events: vec![EventPayload::SessionFinished {
                    outcome: if is_error {
                        Outcome::Failed
                    } else {
                        Outcome::Completed
                    },
                    reason: if is_error { reason } else { None },
                }],
                cli_session_id: value
                    .get("session_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                unmapped_kind: None,
            }
        }
        other => unmapped(other.to_string()),
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
