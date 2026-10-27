//! Axum HTTP + WebSocket surface for the live loop (roadmap step 3).
//! Lane A owns this and the SQLite schema; the client consumes the
//! normalized events from `crate::events` and nothing else.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::events::{EventPayload, Outcome, Source, StoredEvent};
use crate::store::Store;
use crate::watch::RepoWatcher;

pub struct AppState {
    pub store: Arc<Store>,
    pub tx: broadcast::Sender<StoredEvent>,
    watchers: Mutex<HashMap<String, RepoWatcher>>,
    children: Mutex<HashMap<String, tokio::process::Child>>,
    /// Sessions whose agent spawn is in flight but whose child is
    /// not registered yet; /stop waits briefly for these.
    spawning: Mutex<std::collections::HashSet<String>>,
    /// Serializes append+broadcast so the channel can never deliver
    /// events out of global-id order (a live client drops any event
    /// whose id is below the last one it saw).
    emit_lock: Arc<Mutex<()>>,
    debounce: Duration,
}

impl AppState {
    /// Append through the store (which redacts) and broadcast the
    /// stored form. This is the only way events enter the log.
    pub fn emit(
        &self,
        session_id: &str,
        source: Source,
        payload: EventPayload,
    ) -> Result<StoredEvent, String> {
        let _guard = self.emit_lock.lock().unwrap();
        let event = self.store.append(session_id, source, payload)?;
        let _ = self.tx.send(event.clone());
        Ok(event)
    }

    fn start_watcher(&self, session_id: &str, root: &std::path::Path) {
        let state_root = root.to_path_buf();
        let store = self.store.clone();
        let tx = self.tx.clone();
        let emit_lock = self.emit_lock.clone();
        let sid = session_id.to_string();
        match RepoWatcher::spawn(root, self.debounce, move |payload| {
            let _guard = emit_lock.lock().unwrap();
            if let Ok(event) = store.append(&sid, Source::Watcher, payload) {
                let _ = tx.send(event);
            }
        }) {
            Ok(watcher) => {
                let _ = state_root;
                self.watchers
                    .lock()
                    .unwrap()
                    .insert(session_id.to_string(), watcher);
            }
            Err(e) => eprintln!("watcher failed for {session_id}: {e}"),
        }
        // git-status backstop (D8: notify + git status): poll every
        // 5 s and emit watcher touches for change-set transitions the
        // notify stream missed. The seen-set keeps a persistent
        // uncommitted change from re-emitting on every tick.
        {
            let store = self.store.clone();
            let tx = self.tx.clone();
            let emit_lock = self.emit_lock.clone();
            let sid = session_id.to_string();
            let root = root.to_path_buf();
            tokio::spawn(async move {
                // Seed with the pre-existing dirty state: files that
                // were already uncommitted when the session started
                // are not touches by this session and never emit.
                let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
                let seed_root = root.clone();
                if let Ok(Ok(initial)) = tokio::task::spawn_blocking(move || {
                    crate::watch::git_status_changes(&seed_root)
                })
                .await
                {
                    for c in &initial {
                        seen.insert(format!("{}:{:?}", c.path, c.change));
                    }
                }
                let mut tick = tokio::time::interval(Duration::from_secs(5));
                loop {
                    tick.tick().await;
                    // The backstop dies with the session: a stopped or
                    // finished session must not keep logging touches.
                    match store.get_session(&sid) {
                        Ok(Some(s)) if s.state == "working" => {}
                        _ => break,
                    }
                    let Ok(changes) = tokio::task::spawn_blocking({
                        let r = root.clone();
                        move || crate::watch::git_status_changes(&r)
                    })
                    .await
                    .unwrap_or_else(|e| Err(e.to_string())) else {
                        continue;
                    };
                    let mut current = std::collections::HashSet::new();
                    // Fetched once per tick, not once per path.
                    let recent = store.events_for(&sid, 0).unwrap_or_default();
                    for c in changes {
                        // Directories are not buildings, and a path
                        // the notify stream just reported is not a
                        // second touch: the backstop only fills gaps.
                        if c.change != crate::events::ChangeKind::Deleted
                            && root.join(&c.path).is_dir()
                        {
                            continue;
                        }
                        let just_seen = recent.iter().rev().take(50).any(|e| {
                            matches!(&e.payload, EventPayload::FileTouched { path, .. } if path == &c.path)
                                && crate::events::now_ms() - e.ts_ms < 10_000
                        });
                        if just_seen {
                            seen.insert(format!("{}:{:?}", c.path, c.change));
                            current.insert(format!("{}:{:?}", c.path, c.change));
                            continue;
                        }
                        let key = format!("{}:{:?}", c.path, c.change);
                        current.insert(key.clone());
                        if seen.insert(key) {
                            let _guard = emit_lock.lock().unwrap();
                            if let Ok(event) = store.append(
                                &sid,
                                Source::Watcher,
                                EventPayload::FileTouched {
                                    path: c.path,
                                    change: c.change,
                                },
                            ) {
                                let _ = tx.send(event);
                            }
                        }
                    }
                    seen.retain(|k| current.contains(k));
                }
            });
        }
    }
}

pub fn build_app(store: Arc<Store>) -> Router {
    build_app_with(store, Duration::from_millis(300))
}

pub fn build_app_with(store: Arc<Store>, debounce: Duration) -> Router {
    let (tx, _) = broadcast::channel(1024);
    let state = Arc::new(AppState {
        store,
        tx,
        watchers: Mutex::new(HashMap::new()),
        children: Mutex::new(HashMap::new()),
        spawning: Mutex::new(std::collections::HashSet::new()),
        emit_lock: Arc::new(Mutex::new(())),
        debounce,
    });
    Router::new()
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({"ok": true})) }),
        )
        .route("/api/extraction", get(extraction))
        .route("/api/sessions", post(create_session).get(list_sessions))
        .route("/api/sessions/{id}", get(get_session))
        .route("/api/sessions/{id}/events", get(session_events))
        .route("/api/sessions/{id}/report", get(session_report))
        .route("/api/sessions/{id}/stop", post(stop_session))
        .route("/ws", get(ws_handler))
        .with_state(state)
}

fn err(status: StatusCode, msg: String) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(serde_json::json!({ "error": msg })))
}

#[derive(Deserialize)]
struct ExtractionQuery {
    path: String,
}

async fn extraction(Query(q): Query<ExtractionQuery>) -> impl IntoResponse {
    match tokio::task::spawn_blocking(move || {
        crate::extract::extract_repo(std::path::Path::new(&q.path))
    })
    .await
    {
        Ok(Ok(extraction)) => (
            StatusCode::OK,
            Json(serde_json::to_value(extraction).unwrap()),
        )
            .into_response(),
        Ok(Err(e)) => err(StatusCode::BAD_REQUEST, e.to_string()).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct CreateSession {
    repo_path: String,
    island_id: Option<String>,
    task: Option<String>,
    /// Spawn the Claude adapter on `task` in the repo. Default false:
    /// the session is attached to the watcher only, which is honest —
    /// file events then come from real edits, whoever makes them.
    #[serde(default)]
    spawn: bool,
}

async fn create_session(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateSession>,
) -> impl IntoResponse {
    let root = PathBuf::from(&body.repo_path);
    if !root.is_dir() {
        return err(
            StatusCode::BAD_REQUEST,
            format!("repo_path is not a directory: {}", body.repo_path),
        )
        .into_response();
    }
    let session = match state.store.create_session(
        &body.repo_path,
        None,
        body.island_id.as_deref(),
        body.task.as_deref(),
    ) {
        Ok(s) => s,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    if let Err(e) = state.emit(
        &session.id,
        Source::System,
        EventPayload::SessionStarted {
            cli_session_id: None,
        },
    ) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
    }
    state.start_watcher(&session.id, &root);
    if body.spawn {
        if let Some(task) = body.task.clone() {
            spawn_claude(state.clone(), session.id.clone(), root, task);
        }
    }
    (
        StatusCode::CREATED,
        Json(serde_json::to_value(session).unwrap()),
    )
        .into_response()
}

/// Run the Claude adapter for one session. Permission handling here
/// is the spike default (`acceptEdits` inside the session repo);
/// T8 owns the permission bridge and may tighten this.
fn spawn_claude(state: Arc<AppState>, session_id: String, cwd: PathBuf, task: String) {
    // Marked synchronously so a /stop racing the spawn can wait for
    // the child to register instead of missing it entirely.
    state.spawning.lock().unwrap().insert(session_id.clone());
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut child = match tokio::process::Command::new("claude")
            .args([
                "-p",
                &task,
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                "acceptEdits",
            ])
            .current_dir(&cwd)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = state.emit(
                    &session_id,
                    Source::System,
                    EventPayload::SessionFinished {
                        outcome: Outcome::Failed,
                        reason: Some(format!("could not start claude: {e}")),
                    },
                );
                let _ = state.store.set_state(&session_id, "failed");
                state.spawning.lock().unwrap().remove(&session_id);
                return;
            }
        };
        let Some(stdout) = child.stdout.take() else {
            return;
        };
        // Registered so /stop can kill the agent; the reader task
        // below owns the exit wait through this same handle.
        state
            .children
            .lock()
            .unwrap()
            .insert(session_id.clone(), child);
        state.spawning.lock().unwrap().remove(&session_id);
        // The CLI reports canonical paths (e.g. /private/tmp on
        // macOS); strip the canonical session root, not the raw one.
        let cwd = std::fs::canonicalize(&cwd).unwrap_or(cwd);
        let mut lines = BufReader::new(stdout).lines();
        let mut finish_state: Option<&'static str> = None;
        while let Ok(Some(line)) = lines.next_line().await {
            // A stopped session logs nothing more: buffered CLI
            // output after /stop must not resurrect it as finished.
            if state
                .store
                .get_session(&session_id)
                .ok()
                .flatten()
                .is_some_and(|s| s.state == "stopped")
            {
                break;
            }
            let t = crate::adapters::claude::translate_line(&line);
            if let Some(cli_id) = &t.cli_session_id {
                let _ = state.store.set_cli_session_id(&session_id, cli_id);
            }
            for payload in t.events {
                if let EventPayload::SessionFinished { outcome, .. } = &payload {
                    finish_state = Some(match outcome {
                        Outcome::Completed => "finished",
                        Outcome::Failed => "failed",
                        Outcome::Stopped => "stopped",
                    });
                }
                // CLI paths arrive absolute; the watcher (ground
                // truth) speaks repo-relative. Normalize CLI paths to
                // the same frame so both map to the same building.
                let payload = match payload {
                    EventPayload::FileTouched { path, change } => {
                        let rel = std::path::Path::new(&path)
                            .strip_prefix(&cwd)
                            .map(|p| p.to_string_lossy().replace('\\', "/"))
                            .unwrap_or(path);
                        EventPayload::FileTouched { path: rel, change }
                    }
                    other => other,
                };
                // Never log a finish after a stop, even if the line
                // was read just before the stop landed.
                if matches!(payload, EventPayload::SessionFinished { .. })
                    && state
                        .store
                        .get_session(&session_id)
                        .ok()
                        .flatten()
                        .is_some_and(|s| s.state == "stopped")
                {
                    continue;
                }
                let _ = state.emit(&session_id, Source::Cli, payload);
            }
        }
        // If /stop killed the child, it already removed the handle
        // and set the state; do not overwrite either.
        let mut child = state.children.lock().unwrap().remove(&session_id);
        let stopped_externally = child.is_none()
            || state
                .store
                .get_session(&session_id)
                .ok()
                .flatten()
                .is_some_and(|s| s.state == "stopped");
        let status = match child.as_mut() {
            Some(c) => c.wait().await.map_err(|e| e.to_string()),
            None => Err("child already reaped".to_string()),
        };
        if stopped_externally {
            return;
        }
        if finish_state.is_none() {
            let ok = status.map(|s| s.success()).unwrap_or(false);
            let _ = state.emit(
                &session_id,
                Source::System,
                EventPayload::SessionFinished {
                    outcome: if ok {
                        Outcome::Completed
                    } else {
                        Outcome::Failed
                    },
                    reason: if ok {
                        None
                    } else {
                        Some("claude exited without a result event".to_string())
                    },
                },
            );
            let _ = state
                .store
                .set_state(&session_id, if ok { "finished" } else { "failed" });
        } else if let Some(state_name) = finish_state {
            let _ = state.store.set_state(&session_id, state_name);
        }
    });
}

async fn list_sessions(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.store.list_sessions() {
        Ok(sessions) => (
            StatusCode::OK,
            Json(serde_json::to_value(sessions).unwrap()),
        )
            .into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn get_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.get_session(&id) {
        Ok(Some(session)) => {
            (StatusCode::OK, Json(serde_json::to_value(session).unwrap())).into_response()
        }
        Ok(None) => err(StatusCode::NOT_FOUND, "session not found".to_string()).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(default)]
    since_seq: i64,
}

async fn session_events(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<EventsQuery>,
) -> impl IntoResponse {
    match state.store.events_for(&id, q.since_seq) {
        Ok(events) => (StatusCode::OK, Json(serde_json::to_value(events).unwrap())).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

async fn session_report(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let session = match state.store.get_session(&id) {
        Ok(Some(s)) => s,
        Ok(None) => {
            return err(StatusCode::NOT_FOUND, "session not found".to_string()).into_response()
        }
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    let root = PathBuf::from(
        session
            .worktree_path
            .as_deref()
            .unwrap_or(&session.repo_path),
    );
    let report = tokio::task::spawn_blocking(move || crate::report::diff_report(&root))
        .await
        .unwrap_or_else(|e| crate::report::DiffReport {
            generated_by: "template_from_diff".to_string(),
            available: false,
            reason: Some(e.to_string()),
            files: Vec::new(),
            insertions: 0,
            deletions: 0,
            summary: String::new(),
        });
    let mut body = serde_json::to_value(&report).unwrap();
    if !report.available {
        // Failure contract: raw event list with the unavailable
        // label, never a polished fake report.
        let events = state.store.events_for(&id, 0).unwrap_or_default();
        body["events"] = serde_json::to_value(events).unwrap();
    }
    (StatusCode::OK, Json(body)).into_response()
}

async fn stop_session(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.store.get_session(&id) {
        Ok(Some(_)) => {}
        Ok(None) => {
            return err(StatusCode::NOT_FOUND, "session not found".to_string()).into_response()
        }
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
    // State first: the CLI reader checks it before logging anything
    // more, so nothing can land after the stopped event.
    let _ = state.store.set_state(&id, "stopped");
    // Take the watcher out first so the mutex is not held while its
    // thread joins, then kill the agent so it cannot keep editing
    // unwatched after the stop.
    let watcher = state.watchers.lock().unwrap().remove(&id);
    if let Some(watcher) = watcher {
        watcher.stop();
    }
    // If the agent spawn is still in flight, wait briefly for the
    // child to register so it can be killed rather than orphaned.
    for _ in 0..50 {
        if state.children.lock().unwrap().contains_key(&id)
            || !state.spawning.lock().unwrap().contains(&id)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let mut child = state.children.lock().unwrap().remove(&id);
    if let Some(child) = child.as_mut() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    match state.emit(
        &id,
        Source::System,
        EventPayload::SessionFinished {
            outcome: Outcome::Stopped,
            reason: None,
        },
    ) {
        Ok(event) => (StatusCode::OK, Json(serde_json::to_value(event).unwrap())).into_response(),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    }
}

#[derive(Deserialize)]
struct WsQuery {
    /// Global event id to replay after; omit for the live feed only
    /// after a full replay from the start of the log.
    #[serde(default)]
    since_id: i64,
}

async fn ws_handler(
    State(state): State<Arc<AppState>>,
    Query(q): Query<WsQuery>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    upgrade.on_upgrade(move |socket| ws_socket(state, q.since_id, socket))
}

async fn ws_socket(state: Arc<AppState>, since_id: i64, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let mut rx = state.tx.subscribe();
    // Replay first, server-paced: first event immediately, then one
    // per 50 ms, so a bare reconnect cannot burst the client.
    let mut last_id = since_id;
    if let Ok(replay) = state.store.events_since(since_id, 100_000) {
        for (i, event) in replay.iter().enumerate() {
            if i > 0 {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            last_id = event.id;
            let Ok(text) = serde_json::to_string(event) else {
                continue;
            };
            if sink.send(Message::Text(text.into())).await.is_err() {
                return;
            }
        }
    }
    loop {
        tokio::select! {
            received = rx.recv() => {
                match received {
                    Ok(event) => {
                        if event.id <= last_id { continue; }
                        last_id = event.id;
                        let Ok(text) = serde_json::to_string(&event) else { continue };
                        if sink.send(Message::Text(text.into())).await.is_err() { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // The channel dropped events while we were
                        // busy; recover them from SQLite instead of
                        // silently losing them.
                        if let Ok(missed) = state.store.events_since(last_id, 100_000) {
                            for event in missed {
                                last_id = event.id;
                                let Ok(text) = serde_json::to_string(&event) else { continue };
                                if sink.send(Message::Text(text.into())).await.is_err() { return; }
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
}
