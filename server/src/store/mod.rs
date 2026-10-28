//! SQLite store (design D3/R1): session CRUD plus an append-only
//! event log with a gapless per-session sequence. One file owned by
//! the server binary; the connection is serialized behind a mutex,
//! which is fine at the committed scale (at most 3 sessions).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::events::{redact, EventPayload, Source, StoredEvent};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Session {
    pub id: String,
    pub repo_path: String,
    pub worktree_path: Option<String>,
    /// Target district/island chosen at creation, if any.
    pub island_id: Option<String>,
    pub task: Option<String>,
    /// working | paused | stopped | finished | failed | archived
    pub state: String,
    pub cli_session_id: Option<String>,
    /// Agent choices chosen at creation (T12 form). None = the
    /// CLI's own defaults. Ignored for watcher-only sessions.
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Which agent CLI runs the quest: `claude` or `muse`.
    /// None for watcher-only sessions (no agent runs).
    pub agent: Option<String>,
    /// A message queued for the agent (talk-to-agent): runs
    /// when the current run finishes, or on resume when paused.
    pub pending_task: Option<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
}

pub struct Store {
    conn: Mutex<Connection>,
    secrets: Vec<String>,
}

/// Why a state move did not happen. Not found maps to HTTP 404;
/// a bad move maps to HTTP 409.
#[derive(Debug, PartialEq)]
pub enum TransitionError {
    NotFound,
    BadMove { from: String, to: String },
    /// The 3-quest cap is full; the string names the running quests.
    CapReached(String),
    Other(String),
}

/// Why a guarded create did not happen.
#[derive(Debug, PartialEq)]
pub enum CreateError {
    IslandLocked { holder_id: String, holder_state: String },
    /// The string names the running quests.
    CapReached(String),
    Other(String),
}

impl std::fmt::Display for CreateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CreateError::IslandLocked { holder_id, holder_state } => {
                write!(f, "island is held by session {holder_id} ({holder_state})")
            }
            CreateError::CapReached(names) => {
                write!(f, "3 quests are running ({names}); stop one first")
            }
            CreateError::Other(e) => write!(f, "{e}"),
        }
    }
}

impl std::fmt::Display for TransitionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransitionError::NotFound => write!(f, "session not found"),
            TransitionError::BadMove { from, to } => {
                write!(f, "session is {from}; it cannot move to {to}")
            }
            TransitionError::CapReached(names) => {
                write!(f, "3 quests are running ({names}); stop one first")
            }
            TransitionError::Other(e) => write!(f, "{e}"),
        }
    }
}

fn payload_json(payload: &EventPayload) -> Result<String, String> {
    serde_json::to_string(payload).map_err(|e| e.to_string())
}

fn source_str(source: Source) -> &'static str {
    match source {
        Source::Cli => "cli",
        Source::Watcher => "watcher",
        Source::System => "system",
    }
}

impl Store {
    pub fn open(path: &Path) -> Result<Store, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        Self::init(conn)
    }

    pub fn in_memory() -> Result<Store, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Store, String> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS sessions (
               id TEXT PRIMARY KEY,
               repo_path TEXT NOT NULL,
               worktree_path TEXT,
               island_id TEXT,
               task TEXT,
               state TEXT NOT NULL,
               cli_session_id TEXT,
               created_ms INTEGER NOT NULL,
               updated_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS events (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               session_id TEXT NOT NULL REFERENCES sessions(id),
               seq INTEGER NOT NULL,
               ts_ms INTEGER NOT NULL,
               source TEXT NOT NULL,
               payload TEXT NOT NULL,
               UNIQUE(session_id, seq)
             );
             CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_id, seq);",
        )
        .map_err(|e| e.to_string())?;
        // T12 added model/effort. ALTER has no IF NOT EXISTS, so a
        // duplicate-column error on an already-migrated DB is fine.
        // Any other error (locked DB, read-only file) must surface:
        // reads map `model`/`effort` from every row, so a missing
        // column would break every session query (Opus review).
        for col in ["model", "effort", "agent", "pending_task"] {
            if let Err(e) = conn.execute(&format!("ALTER TABLE sessions ADD COLUMN {col} TEXT"), []) {
                if !e.to_string().contains("duplicate column name") {
                    return Err(e.to_string());
                }
            }
        }
        Ok(Store {
            conn: Mutex::new(conn),
            secrets: redact::secret_values_from_env(),
        })
    }

    pub fn create_session(
        &self,
        repo_path: &str,
        worktree_path: Option<&str>,
        island_id: Option<&str>,
        task: Option<&str>,
    ) -> Result<Session, String> {
        self.create_session_chosen(repo_path, worktree_path, island_id, task, None, None, None)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_session_chosen(
        &self,
        repo_path: &str,
        worktree_path: Option<&str>,
        island_id: Option<&str>,
        task: Option<&str>,
        model: Option<&str>,
        effort: Option<&str>,
        agent: Option<&str>,
    ) -> Result<Session, String> {
        let now = crate::events::now_ms();
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            repo_path: repo_path.to_string(),
            worktree_path: worktree_path.map(str::to_string),
            island_id: island_id.map(str::to_string),
            // The task is free text from the user and can quote a
            // credential; it is stored only after redaction.
            task: task.map(|t| redact::redact_text(t, &self.secrets)),
            state: "working".to_string(),
            cli_session_id: None,
            model: model.map(str::to_string),
            effort: effort.map(str::to_string),
            agent: agent.map(str::to_string),
            pending_task: None,
            created_ms: now,
            updated_ms: now,
        };
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO sessions (id, repo_path, worktree_path, island_id, task, state, cli_session_id, model, effort, agent, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10, ?10)",
            params![session.id, session.repo_path, session.worktree_path, session.island_id, session.task, session.state, session.model, session.effort, session.agent, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(session)
    }

    fn row_to_session(row: &rusqlite::Row) -> rusqlite::Result<Session> {
        Ok(Session {
            id: row.get("id")?,
            repo_path: row.get("repo_path")?,
            worktree_path: row.get("worktree_path")?,
            island_id: row.get("island_id")?,
            task: row.get("task")?,
            state: row.get("state")?,
            cli_session_id: row.get("cli_session_id")?,
            model: row.get("model")?,
            effort: row.get("effort")?,
            agent: row.get("agent")?,
            pending_task: row.get("pending_task")?,
            created_ms: row.get("created_ms")?,
            updated_ms: row.get("updated_ms")?,
        })
    }

    pub fn get_session(&self, id: &str) -> Result<Option<Session>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT * FROM sessions WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map(params![id], Self::row_to_session)
            .map_err(|e| e.to_string())?;
        match rows.next() {
            Some(r) => Ok(Some(r.map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    pub fn list_sessions(&self) -> Result<Vec<Session>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT * FROM sessions ORDER BY created_ms")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], Self::row_to_session)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn set_state(&self, id: &str, state: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sessions SET state = ?2, updated_ms = ?3 WHERE id = ?1",
            params![id, state, crate::events::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_worktree_path(&self, id: &str, path: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sessions SET worktree_path = ?2, updated_ms = ?3 WHERE id = ?1",
            params![id, path, crate::events::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_task(&self, id: &str, task: &str) -> Result<(), String> {
        let task = redact::redact_text(task, &self.secrets);
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sessions SET task = ?2, updated_ms = ?3 WHERE id = ?1",
            params![id, task, crate::events::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Queue (or clear) a message for the agent. Stored
    /// redacted, like the task itself.
    pub fn set_pending_task(&self, id: &str, task: Option<&str>) -> Result<(), String> {
        let task = task.map(|t| redact::redact_text(t, &self.secrets));
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sessions SET pending_task = ?2, updated_ms = ?3 WHERE id = ?1",
            params![id, task, crate::events::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Clear the queued message only if it is still the one the
    /// caller read. A newer message stored meanwhile survives
    /// (Codex review: unconditional clear erased it).
    pub fn clear_pending_task_if(&self, id: &str, expected: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let n = conn
            .execute(
                "UPDATE sessions SET pending_task = NULL, updated_ms = ?3 WHERE id = ?1 AND pending_task = ?2",
                params![id, expected, crate::events::now_ms()],
            )
            .map_err(|e| e.to_string())?;
        Ok(n == 1)
    }

    /// Move a session to `to` only from one of `allowed_from`.
    /// A bad move is an error, never a silent no-op: the client
    /// must not show a state the server did not take. The check
    /// and the write run under one connection lock, so two
    /// requests cannot both win the same move.
    pub fn transition_state(
        &self,
        id: &str,
        allowed_from: &[&str],
        to: &str,
    ) -> Result<Session, TransitionError> {
        let conn = self.conn.lock().map_err(|e| TransitionError::Other(e.to_string()))?;
        let from: String = match conn.query_row(
            "SELECT state FROM sessions WHERE id = ?1",
            params![id],
            |r| r.get(0),
        ) {
            Ok(state) => state,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                return Err(TransitionError::NotFound)
            }
            Err(e) => return Err(TransitionError::Other(e.to_string())),
        };
        if !allowed_from.contains(&from.as_str()) {
            return Err(TransitionError::BadMove {
                from,
                to: to.to_string(),
            });
        }
        // A move into `working` checks the 3-spawned-quest cap in
        // this same lock. A session with no worktree runs no agent
        // and does not count toward the cap.
        if to == "working" {
            let own_worktree: Option<String> = conn
                .query_row(
                    "SELECT worktree_path FROM sessions WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .map_err(|e| TransitionError::Other(e.to_string()))?;
            if own_worktree.is_some() {
                let mut stmt = conn
                    .prepare(
                        "SELECT COALESCE(task, id) FROM sessions WHERE state = 'working' AND worktree_path IS NOT NULL AND id != ?1",
                    )
                    .map_err(|e| TransitionError::Other(e.to_string()))?;
                let names = stmt
                    .query_map(params![id], |r| r.get::<_, String>(0))
                    .map_err(|e| TransitionError::Other(e.to_string()))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| TransitionError::Other(e.to_string()))?;
                if names.len() >= 3 {
                    return Err(TransitionError::CapReached(names.join(", ")));
                }
            }
        }
        conn.execute(
            "UPDATE sessions SET state = ?2, updated_ms = ?3 WHERE id = ?1 AND state = ?4",
            params![id, to, crate::events::now_ms(), from],
        )
        .map_err(|e| TransitionError::Other(e.to_string()))?;
        let session = conn
            .query_row("SELECT * FROM sessions WHERE id = ?1", params![id], Self::row_to_session)
            .map_err(|e| TransitionError::Other(e.to_string()))?;
        Ok(session)
    }

    /// Create a session with the island lock and the spawned-quest
    /// cap checked in the same lock as the insert, so a double
    /// submit cannot take one island twice or pass the cap. The
    /// worktree path is written at insert (the caller creates the
    /// worktree at that exact path next), so a just-created quest
    /// already counts toward the cap.
    #[allow(clippy::too_many_arguments)]
    pub fn create_session_guarded(
        &self,
        repo_path: &str,
        island_id: Option<&str>,
        task: Option<&str>,
        worktree_root: Option<&str>,
        model: Option<&str>,
        effort: Option<&str>,
        agent: Option<&str>,
    ) -> Result<Session, CreateError> {
        let now = crate::events::now_ms();
        let id = uuid::Uuid::new_v4().to_string();
        let session = Session {
            worktree_path: worktree_root.map(|root| format!("{root}/{id}")),
            id,
            repo_path: repo_path.to_string(),
            island_id: island_id.map(str::to_string),
            task: task.map(|t| redact::redact_text(t, &self.secrets)),
            state: "working".to_string(),
            cli_session_id: None,
            model: model.map(str::to_string),
            effort: effort.map(str::to_string),
            agent: agent.map(str::to_string),
            pending_task: None,
            created_ms: now,
            updated_ms: now,
        };
        let conn = self.conn.lock().map_err(|e| CreateError::Other(e.to_string()))?;
        if let Some(island_id) = island_id {
            let holder: Option<(String, String)> = conn
                .query_row(
                    "SELECT id, state FROM sessions WHERE repo_path = ?1 AND island_id = ?2 AND state IN ('working','paused') LIMIT 1",
                    params![repo_path, island_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();
            if let Some((holder_id, holder_state)) = holder {
                return Err(CreateError::IslandLocked {
                    holder_id,
                    holder_state,
                });
            }
        }
        if worktree_root.is_some() {
            let mut stmt = conn
                .prepare(
                    "SELECT COALESCE(task, id) FROM sessions WHERE state = 'working' AND worktree_path IS NOT NULL",
                )
                .map_err(|e| CreateError::Other(e.to_string()))?;
            let names = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| CreateError::Other(e.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| CreateError::Other(e.to_string()))?;
            if names.len() >= 3 {
                return Err(CreateError::CapReached(names.join(", ")));
            }
        }
        conn.execute(
            "INSERT INTO sessions (id, repo_path, worktree_path, island_id, task, state, cli_session_id, model, effort, agent, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, 'working', NULL, ?6, ?7, ?8, ?9, ?9)",
            params![session.id, session.repo_path, session.worktree_path, session.island_id, session.task, session.model, session.effort, session.agent, now],
        )
        .map_err(|e| CreateError::Other(e.to_string()))?;
        Ok(session)
    }

    /// The working or paused session that holds the lock on one
    /// island of one repo, if any. Paused holds the lock: resume
    /// must be able to take its island back. Terminal states and
    /// archived release it. `exclude_id` skips the caller itself.
    pub fn island_lock_holder(
        &self,
        repo_path: &str,
        island_id: &str,
        exclude_id: Option<&str>,
    ) -> Result<Option<Session>, String> {
        Ok(self
            .list_sessions()?
            .into_iter()
            .find(|s| {
                s.repo_path == repo_path
                    && s.island_id.as_deref() == Some(island_id)
                    && (s.state == "working" || s.state == "paused")
                    && Some(s.id.as_str()) != exclude_id
            }))
    }

    pub fn set_cli_session_id(&self, id: &str, cli_session_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE sessions SET cli_session_id = ?2, updated_ms = ?3 WHERE id = ?1",
            params![id, cli_session_id, crate::events::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Append one event, assigning the next per-session sequence.
    /// Text fields are redacted before the row is written, so a
    /// planted secret never reaches SQLite (T8 test surface).
    pub fn append(
        &self,
        session_id: &str,
        source: Source,
        payload: EventPayload,
    ) -> Result<StoredEvent, String> {
        let payload = payload.redacted(&self.secrets);
        let json = payload_json(&payload)?;
        let ts_ms = crate::events::now_ms();
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let seq: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE session_id = ?1",
                params![session_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO events (session_id, seq, ts_ms, source, payload) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_id, seq, ts_ms, source_str(source), json],
        )
        .map_err(|e| e.to_string())?;
        let id = tx.last_insert_rowid();
        tx.commit().map_err(|e| e.to_string())?;
        Ok(StoredEvent {
            id,
            session_id: session_id.to_string(),
            seq,
            ts_ms,
            source,
            payload,
        })
    }

    fn row_to_event(row: &rusqlite::Row) -> rusqlite::Result<StoredEvent> {
        let payload_json: String = row.get("payload")?;
        let source_str: String = row.get("source")?;
        let payload: EventPayload = serde_json::from_str(&payload_json).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?;
        Ok(StoredEvent {
            id: row.get("id")?,
            session_id: row.get("session_id")?,
            seq: row.get("seq")?,
            ts_ms: row.get("ts_ms")?,
            source: match source_str.as_str() {
                "cli" => Source::Cli,
                "watcher" => Source::Watcher,
                _ => Source::System,
            },
            payload,
        })
    }

    /// Events of one session after `since_seq` (0 = from the start).
    pub fn events_for(&self, session_id: &str, since_seq: i64) -> Result<Vec<StoredEvent>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT * FROM events WHERE session_id = ?1 AND seq > ?2 ORDER BY seq")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![session_id, since_seq], Self::row_to_event)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    /// Global feed after `since_id`, for WebSocket reconnect replay.
    pub fn events_since(&self, since_id: i64, limit: i64) -> Result<Vec<StoredEvent>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT * FROM events WHERE id > ?1 ORDER BY id LIMIT ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![since_id, limit], Self::row_to_event)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    /// Raw stored payloads, for the planted-secret test: what is
    /// actually on disk, not what the API returns.
    #[cfg(test)]
    pub fn raw_payloads(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT payload FROM events ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{ChangeKind, Outcome};

    fn store_with_session() -> (Store, Session) {
        let store = Store::in_memory().unwrap();
        let s = store
            .create_session("/repo", None, Some("api"), Some("task"))
            .unwrap();
        (store, s)
    }

    #[test]
    fn append_assigns_gapless_per_session_seq() {
        let (store, s) = store_with_session();
        let other = store.create_session("/repo", None, None, None).unwrap();
        let a = store
            .append(
                &s.id,
                Source::System,
                EventPayload::SessionStarted {
                    cli_session_id: None,
                },
            )
            .unwrap();
        let b = store
            .append(
                &s.id,
                Source::Watcher,
                EventPayload::FileTouched {
                    path: "a.ts".into(),
                    change: ChangeKind::Modified,
                },
            )
            .unwrap();
        let c = store
            .append(
                &other.id,
                Source::System,
                EventPayload::SessionStarted {
                    cli_session_id: None,
                },
            )
            .unwrap();
        assert_eq!((a.seq, b.seq, c.seq), (1, 2, 1));
        assert!(a.id < b.id && b.id < c.id);
        let replay = store.events_for(&s.id, 1).unwrap();
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].seq, 2);
    }

    #[test]
    fn planted_secret_never_reaches_sqlite() {
        let (store, s) = store_with_session();
        // Assembled at runtime so no literal credential sits in source.
        let planted = ["sk-", "abcdefghijklmnopqrst", "uvwxyz0123456789"].concat();
        store
            .append(
                &s.id,
                Source::Cli,
                EventPayload::AgentMessage {
                    text: format!("leaked {planted} here"),
                },
            )
            .unwrap();
        store
            .append(
                &s.id,
                Source::Cli,
                EventPayload::SessionFinished {
                    outcome: Outcome::Completed,
                    reason: None,
                },
            )
            .unwrap();
        for raw in store.raw_payloads().unwrap() {
            assert!(!raw.contains("sk-abcdef"), "secret on disk: {raw}");
        }
        let events = store.events_for(&s.id, 0).unwrap();
        assert!(
            matches!(&events[0].payload, EventPayload::AgentMessage { text } if text.contains("[redacted]"))
        );
    }

    #[test]
    fn session_task_is_redacted_before_storage() {
        let store = Store::in_memory().unwrap();
        // Assembled at runtime so no literal credential sits in source.
        let planted = ["sk-", "abcdefghijklmnopqrst", "uvwxyz0123456789"].concat();
        let s = store
            .create_session(
                "/repo",
                None,
                None,
                Some(&format!("use key {planted} please")),
            )
            .unwrap();
        assert!(
            s.task
                .as_deref()
                .is_some_and(|t| t.contains("[redacted]") && !t.contains(&planted[..8])),
            "task: {:?}",
            s.task
        );
        let got = store.get_session(&s.id).unwrap().unwrap();
        assert_eq!(got.task, s.task);
    }

    #[test]
    fn transitions_allow_good_moves_and_reject_bad_ones() {
        let (store, s) = store_with_session();
        let paused = store
            .transition_state(&s.id, &["working"], "paused")
            .unwrap();
        assert_eq!(paused.state, "paused");
        // Paused cannot pause again, and cannot archive.
        assert_eq!(
            store.transition_state(&s.id, &["working"], "paused"),
            Err(TransitionError::BadMove {
                from: "paused".into(),
                to: "paused".into()
            })
        );
        assert!(matches!(
            store.transition_state(&s.id, &["finished", "failed", "stopped"], "archived"),
            Err(TransitionError::BadMove { .. })
        ));
        let working = store
            .transition_state(&s.id, &["paused"], "working")
            .unwrap();
        assert_eq!(working.state, "working");
        assert_eq!(
            store.transition_state("no-such-id", &["working"], "paused"),
            Err(TransitionError::NotFound)
        );
    }

    #[test]
    fn island_lock_is_held_by_working_and_paused_only() {
        let (store, s) = store_with_session();
        let holder = store
            .island_lock_holder("/repo", "api", None)
            .unwrap()
            .unwrap();
        assert_eq!(holder.id, s.id);
        // The holder does not block itself.
        assert!(store
            .island_lock_holder("/repo", "api", Some(&s.id))
            .unwrap()
            .is_none());
        store.set_state(&s.id, "paused").unwrap();
        assert!(store.island_lock_holder("/repo", "api", None).unwrap().is_some());
        store.set_state(&s.id, "stopped").unwrap();
        assert!(store.island_lock_holder("/repo", "api", None).unwrap().is_none());
        // A different island or repo is a different lock.
        assert!(store.island_lock_holder("/repo", "web", None).unwrap().is_none());
    }

    #[test]
    fn guarded_create_holds_lock_and_cap_at_insert() {
        let store = Store::in_memory().unwrap();
        let a = store
            .create_session_guarded("/repo", Some("api"), Some("one"), Some("/wts"), None, None, None)
            .unwrap();
        assert!(a.worktree_path.as_deref().is_some_and(|p| p.ends_with(&a.id)));
        // Same island is locked at insert, not after a race window.
        assert!(matches!(
            store.create_session_guarded("/repo", Some("api"), Some("two"), None, None, None, None),
            Err(CreateError::IslandLocked { .. })
        ));
        store
            .create_session_guarded("/repo", Some("web"), Some("two"), Some("/wts"), None, None, None)
            .unwrap();
        store
            .create_session_guarded("/repo", Some("db"), Some("three"), Some("/wts"), None, None, None)
            .unwrap();
        // Three spawned quests run: the fourth is refused by name.
        match store.create_session_guarded("/repo", None, Some("four"), Some("/wts"), None, None, None) {
            Err(CreateError::CapReached(names)) => {
                assert!(names.contains("one") && names.contains("three"), "{names}")
            }
            other => panic!("expected cap, got {other:?}"),
        }
        // Watcher-only sessions do not count and are not refused.
        assert!(store
            .create_session_guarded("/repo", None, Some("watch"), None, None, None, None)
            .is_ok());
    }

    #[test]
    fn model_and_effort_are_stored_and_returned() {
        let store = Store::in_memory().unwrap();
        let s = store
            .create_session_guarded("/repo", Some("api"), Some("t"), Some("/wts"), Some("opus"), Some("high"), None)
            .unwrap();
        assert_eq!(s.model.as_deref(), Some("opus"));
        assert_eq!(s.effort.as_deref(), Some("high"));
        let back = store.get_session(&s.id).unwrap().unwrap();
        assert_eq!(back.model.as_deref(), Some("opus"));
        assert_eq!(back.effort.as_deref(), Some("high"));
        let plain = store
            .create_session_guarded("/repo", Some("web"), Some("t"), None, None, None, None)
            .unwrap();
        assert!(plain.model.is_none() && plain.effort.is_none());
    }

    #[test]
    fn pending_task_queues_and_clears() {
        let store = Store::in_memory().unwrap();
        let s = store
            .create_session_guarded("/repo", Some("api"), Some("t"), Some("/wts"), None, None, Some("muse"))
            .unwrap();
        assert!(s.pending_task.is_none());
        store.set_pending_task(&s.id, Some("also check totals")).unwrap();
        let back = store.get_session(&s.id).unwrap().unwrap();
        assert_eq!(back.pending_task.as_deref(), Some("also check totals"));
        store.set_pending_task(&s.id, None).unwrap();
        assert!(store.get_session(&s.id).unwrap().unwrap().pending_task.is_none());
    }

    #[test]
    fn clear_pending_task_if_keeps_a_newer_message() {
        let store = Store::in_memory().unwrap();
        let s = store
            .create_session_guarded("/repo", Some("api"), Some("t"), Some("/wts"), None, None, Some("muse"))
            .unwrap();
        store.set_pending_task(&s.id, Some("first")).unwrap();
        store.set_pending_task(&s.id, Some("second")).unwrap();
        // Taking "first" must fail and keep "second" queued.
        assert!(!store.clear_pending_task_if(&s.id, "first").unwrap());
        assert_eq!(
            store.get_session(&s.id).unwrap().unwrap().pending_task.as_deref(),
            Some("second")
        );
        assert!(store.clear_pending_task_if(&s.id, "second").unwrap());
        assert!(store.get_session(&s.id).unwrap().unwrap().pending_task.is_none());
    }

    #[test]
    fn agent_is_stored_and_returned() {
        let store = Store::in_memory().unwrap();
        let s = store
            .create_session_guarded("/repo", Some("api"), Some("t"), Some("/wts"), Some("muse-spark-1.3"), Some("ultra"), Some("muse"))
            .unwrap();
        assert_eq!(s.agent.as_deref(), Some("muse"));
        let back = store.get_session(&s.id).unwrap().unwrap();
        assert_eq!(back.agent.as_deref(), Some("muse"));
        assert_eq!(back.model.as_deref(), Some("muse-spark-1.3"));
        let watch = store
            .create_session_guarded("/repo", Some("web"), Some("t"), None, None, None, None)
            .unwrap();
        assert!(watch.agent.is_none());
    }

    #[test]
    fn move_into_working_checks_the_cap_in_the_same_move() {
        let store = Store::in_memory().unwrap();
        let mut ids = Vec::new();
        for island in ["a", "b", "c"] {
            ids.push(
                store
                    .create_session_guarded("/repo", Some(island), Some(island), Some("/wts"), None, None, None)
                    .unwrap()
                    .id,
            );
        }
        store.transition_state(&ids[2], &["working"], "paused").unwrap();
        let d = store
            .create_session_guarded("/repo", Some("d"), Some("d-task"), Some("/wts"), None, None, None)
            .unwrap();
        store.transition_state(&d.id, &["working"], "paused").unwrap();
        // Resume c: 3 run again. Resume d: the cap refuses the move.
        store.transition_state(&ids[2], &["paused"], "working").unwrap();
        match store.transition_state(&d.id, &["paused"], "working") {
            Err(TransitionError::CapReached(names)) => {
                assert!(names.contains('a') && !names.contains("d-task"), "{names}")
            }
            other => panic!("expected cap, got {other:?}"),
        }
        assert_eq!(store.get_session(&d.id).unwrap().unwrap().state, "paused");
    }

    #[test]
    fn session_state_roundtrip() {
        let (store, s) = store_with_session();
        store.set_state(&s.id, "paused").unwrap();
        store.set_cli_session_id(&s.id, "cli-123").unwrap();
        let got = store.get_session(&s.id).unwrap().unwrap();
        assert_eq!(got.state, "paused");
        assert_eq!(got.cli_session_id.as_deref(), Some("cli-123"));
        assert_eq!(store.list_sessions().unwrap().len(), 1);
    }
}
