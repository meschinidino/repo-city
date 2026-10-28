//! Normalized event contract (design D4): both CLI adapters and the
//! filesystem watcher translate into this one enum. It is stored in
//! SQLite and broadcast over WebSocket; raw CLI events never reach the
//! client. Unmapped CLI events are counted by the adapters, not passed
//! through.

pub mod redact;

use serde::{Deserialize, Serialize};

/// Where an event came from. The watcher is ground truth for file
/// touches (D8); CLI events carry intent and narration only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Cli,
    Watcher,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Created,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Completed,
    Failed,
    Stopped,
}

/// The normalized payload. Mirrors the list committed in the design
/// doc: session started, file touched (path), command run, test
/// result, agent message, session finished/failed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventPayload {
    SessionStarted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cli_session_id: Option<String>,
    },
    FileTouched {
        /// Repo-relative path when known, else the path as reported.
        path: String,
        change: ChangeKind,
    },
    CommandRun {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
    },
    TestResult {
        passed: bool,
        summary: String,
    },
    AgentMessage {
        text: String,
    },
    /// The agent's own reasoning text, when the CLI stream
    /// carries it (Claude thinking blocks). Muse's stream
    /// carries only a reasoning token count, so Muse quests
    /// never produce this event; nothing is invented for them.
    AgentReasoning {
        text: String,
    },
    /// The quest paused: process dead, conversation kept. The
    /// map needs this as a state, not a chat line, or a paused
    /// quest replays as working (Codex review).
    SessionPaused,
    SessionFinished {
        outcome: Outcome,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

impl EventPayload {
    /// Scrub secrets out of any free-text field before storage or
    /// broadcast (T8 redaction seam, L1: env-value matching plus
    /// token-shape patterns).
    pub fn redacted(mut self, secrets: &[String]) -> Self {
        match &mut self {
            EventPayload::CommandRun { command, .. } => {
                *command = redact::redact_text(command, secrets);
            }
            EventPayload::TestResult { summary, .. } => {
                *summary = redact::redact_text(summary, secrets);
            }
            EventPayload::AgentMessage { text } => {
                *text = redact::redact_text(text, secrets);
            }
            EventPayload::AgentReasoning { text } => {
                *text = redact::redact_text(text, secrets);
            }
            EventPayload::SessionFinished {
                reason: Some(reason),
                ..
            } => {
                *reason = redact::redact_text(reason, secrets);
            }
            _ => {}
        }
        self
    }
}

/// One stored/broadcast event: the payload plus its position in the
/// append-only log. `seq` is per-session and gapless; `id` is the
/// global log position used for WebSocket reconnect replay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredEvent {
    pub id: i64,
    pub session_id: String,
    pub seq: i64,
    pub ts_ms: i64,
    pub source: Source,
    #[serde(flatten)]
    pub payload: EventPayload,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
