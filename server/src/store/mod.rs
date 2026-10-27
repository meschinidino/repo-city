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
    pub created_ms: i64,
    pub updated_ms: i64,
}

pub struct Store {
    conn: Mutex<Connection>,
    secrets: Vec<String>,
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
        let now = crate::events::now_ms();
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            repo_path: repo_path.to_string(),
            worktree_path: worktree_path.map(str::to_string),
            island_id: island_id.map(str::to_string),
            task: task.map(str::to_string),
            state: "working".to_string(),
            cli_session_id: None,
            created_ms: now,
            updated_ms: now,
        };
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO sessions (id, repo_path, worktree_path, island_id, task, state, cli_session_id, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)",
            params![session.id, session.repo_path, session.worktree_path, session.island_id, session.task, session.state, now],
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
