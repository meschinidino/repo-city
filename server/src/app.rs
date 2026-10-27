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
use crate::store::{Store, TransitionError};
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
        // A stopped/finished session logs nothing more from the CLI
        // or the watcher: racing producers are dropped here, at the
        // single entry point. The state check runs under the emit
        // lock so it cannot race the stop path's state write plus
        // stopped-event append. System events (the stop itself,
        // lifecycle bookkeeping) still land.
        let _guard = self.emit_lock.lock().unwrap();
        if source != Source::System {
            match self.store.get_session(session_id) {
                Ok(Some(s)) if s.state == "working" => {}
                Ok(Some(s)) => return Err(format!("session is {}", s.state)),
                Ok(None) => return Err("session not found".to_string()),
                Err(e) => return Err(e),
            }
        }
        let event = self.store.append(session_id, source, payload)?;
        let _ = self.tx.send(event.clone());
        Ok(event)
    }

    /// Stop the watcher and kill the agent child of one session.
    /// The caller sets the new state first, so no producer can log
    /// after the move. Used by pause and stop; resume starts a
    /// fresh watcher and, when a CLI session id is known, a fresh
    /// `claude --resume` process.
    async fn teardown_runtime(&self, session_id: &str) {
        let watcher = self.watchers.lock().unwrap().remove(session_id);
        if let Some(watcher) = watcher {
            watcher.stop();
        }
        for _ in 0..50 {
            if self.children.lock().unwrap().contains_key(session_id)
                || !self.spawning.lock().unwrap().contains(session_id)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let mut child = self.children.lock().unwrap().remove(session_id);
        if let Some(child) = child.as_mut() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }

    fn start_watcher(&self, session_id: &str, root: &std::path::Path) {
        let state_root = root.to_path_buf();
        let store = self.store.clone();
        let tx = self.tx.clone();
        let emit_lock = self.emit_lock.clone();
        let sid = session_id.to_string();
        match RepoWatcher::spawn(root, self.debounce, move |payload| {
            // Same gate as AppState::emit, checked under the lock:
            // a stopped session logs nothing more from the watcher.
            let _guard = emit_lock.lock().unwrap();
            match store.get_session(&sid) {
                Ok(Some(s)) if s.state == "working" => {}
                _ => return,
            }
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
                            // Rechecked under the lock at append time:
                            // the session may have stopped during the
                            // git call.
                            let _guard = emit_lock.lock().unwrap();
                            match store.get_session(&sid) {
                                Ok(Some(s)) if s.state == "working" => {}
                                _ => continue,
                            }
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
        .route("/api/sessions/{id}/pause", post(pause_session))
        .route("/api/sessions/{id}/resume", post(resume_session))
        .route("/api/sessions/{id}/archive", post(archive_session))
        .route("/api/sessions/{id}/follow-up", post(follow_up_session))
        .route("/ws", get(ws_handler))
        // Local single-user tool: only loopback pages (the Vite dev
        // client) may call this API from a browser. A permissive
        // layer would let any web page spawn agents in local repos.
        .layer(
            tower_http::cors::CorsLayer::new()
                .allow_origin(tower_http::cors::AllowOrigin::predicate(
                    |origin: &axum::http::HeaderValue, _| {
                        origin.to_str().map(is_loopback_origin).unwrap_or(false)
                    },
                ))
                .allow_methods(tower_http::cors::Any)
                .allow_headers(tower_http::cors::Any),
        )
        .with_state(state)
}

fn err(status: StatusCode, msg: String) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(serde_json::json!({ "error": msg })))
}

/// Browser boundary for this local tool: pages may only talk to
/// the server from a loopback origin (the Vite dev server, on
/// whatever port it picked). Mutating POSTs additionally require
/// the `x-repo-city` header — a cross-site form POST cannot set it
/// (and setting it forces a CORS preflight), which closes the CSRF
/// hole that CORS alone leaves open. Non-browser clients (curl,
/// tests) send no Origin and are bound to loopback anyway.
fn is_loopback_origin(origin: &str) -> bool {
    origin.starts_with("http://localhost:") || origin.starts_with("http://127.0.0.1:")
}

fn origin_allowed(headers: &axum::http::HeaderMap) -> bool {
    match headers.get(axum::http::header::ORIGIN) {
        None => true,
        Some(origin) => origin.to_str().map(is_loopback_origin).unwrap_or(false),
    }
}

fn mutation_allowed(headers: &axum::http::HeaderMap) -> bool {
    // Browsers always send Origin on POST: those requests must come
    // from a dev origin and carry the header. Headerless local
    // clients (curl, tests) reach a loopback-only server already.
    if headers.contains_key(axum::http::header::ORIGIN) {
        origin_allowed(headers) && headers.contains_key("x-repo-city")
    } else {
        true
    }
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
    headers: axum::http::HeaderMap,
    Json(body): Json<CreateSession>,
) -> impl IntoResponse {
    if !mutation_allowed(&headers) {
        return err(
            StatusCode::FORBIDDEN,
            "browser mutations need a dev origin and the x-repo-city header".to_string(),
        )
        .into_response();
    }
    let root = PathBuf::from(&body.repo_path);
    if !root.is_dir() {
        return err(
            StatusCode::BAD_REQUEST,
            format!("repo_path is not a directory: {}", body.repo_path),
        )
        .into_response();
    }
    // Island lock (T5): one working or paused quest per island.
    if let Some(island_id) = body.island_id.as_deref() {
        match state
            .store
            .island_lock_holder(&body.repo_path, island_id, None)
        {
            Ok(Some(holder)) => {
                return err(
                    StatusCode::CONFLICT,
                    format!(
                        "island {island_id} is held by session {} ({})",
                        holder.id, holder.state
                    ),
                )
                .into_response()
            }
            Ok(None) => {}
            Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        }
    }
    // Cap (D-cap): at most 3 running agent quests. Watcher-only
    // sessions do not count; they run no agent.
    if body.spawn {
        match state.store.list_sessions() {
            Ok(all) => {
                let running: Vec<&crate::store::Session> = all
                    .iter()
                    .filter(|s| s.state == "working" && s.worktree_path.is_some())
                    .collect();
                if running.len() >= 3 {
                    let names = running
                        .iter()
                        .map(|s| s.task.as_deref().unwrap_or(&s.id))
                        .collect::<Vec<_>>()
                        .join(", ");
                    return err(
                        StatusCode::CONFLICT,
                        format!("3 quests are running ({names}); stop one first"),
                    )
                    .into_response();
                }
            }
            Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        }
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
    // A spawned agent works in its own git worktree (T5), never in
    // the user's checkout. Shared dependencies stay read-only by
    // construction: the worktree holds tracked files only, and no
    // install step runs in the user's tree.
    let mut run_root = root.clone();
    if body.spawn {
        let wt_root = root.join(".repo-city").join("worktrees");
        match crate::worktree::create_worktree(&root, &wt_root, &session.id) {
            Ok(path) => {
                let _ = state
                    .store
                    .set_worktree_path(&session.id, &path.to_string_lossy());
                run_root = path;
            }
            Err(e) => {
                let _ = state.store.set_state(&session.id, "failed");
                let _ = state.emit(
                    &session.id,
                    Source::System,
                    EventPayload::SessionFinished {
                        outcome: Outcome::Failed,
                        reason: Some(format!("could not create worktree: {e}")),
                    },
                );
                return err(StatusCode::BAD_REQUEST, e).into_response();
            }
        }
    }
    if let Err(e) = state.emit(
        &session.id,
        Source::System,
        EventPayload::SessionStarted {
            cli_session_id: None,
        },
    ) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
    }
    state.start_watcher(&session.id, &run_root);
    if body.spawn {
        if let Some(task) = body.task.clone() {
            spawn_claude(state.clone(), session.id.clone(), run_root, task, None);
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
fn spawn_claude(
    state: Arc<AppState>,
    session_id: String,
    cwd: PathBuf,
    task: String,
    resume_cli_id: Option<String>,
) {
    // Marked synchronously so a /stop racing the spawn can wait for
    // the child to register instead of missing it entirely.
    state.spawning.lock().unwrap().insert(session_id.clone());
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut args: Vec<String> = vec![
            "-p".into(),
            task.clone(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--permission-mode".into(),
            "acceptEdits".into(),
        ];
        // Resume by CLI session id (T5): pause killed the process;
        // the conversation continues under the same CLI id.
        if let Some(cli_id) = &resume_cli_id {
            args.push("--resume".into());
            args.push(cli_id.clone());
        }
        let mut child = match tokio::process::Command::new("claude")
            .args(&args)
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
        // Rechecked after the wait: a /stop that landed while the
        // child was exiting already emitted its stopped event and
        // owns the final state; a second finish must not follow it.
        let stopped_during_wait = state
            .store
            .get_session(&session_id)
            .ok()
            .flatten()
            .is_some_and(|s| s.state == "stopped");
        if stopped_externally || stopped_during_wait {
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
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !mutation_allowed(&headers) {
        return err(
            StatusCode::FORBIDDEN,
            "browser mutations need a dev origin and the x-repo-city header".to_string(),
        )
        .into_response();
    }
    // State first: the CLI reader checks it before logging anything
    // more, so nothing can land after the stopped event. A session
    // that already ended cannot stop again.
    match state
        .store
        .transition_state(&id, &["working", "paused"], "stopped")
    {
        Ok(_) => {}
        Err(e) => return transition_err(e).into_response(),
    }
    state.teardown_runtime(&id).await;
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

fn transition_err(e: TransitionError) -> (StatusCode, Json<serde_json::Value>) {
    let status = match e {
        TransitionError::NotFound => StatusCode::NOT_FOUND,
        TransitionError::BadMove { .. } => StatusCode::CONFLICT,
        TransitionError::Other(_) => StatusCode::INTERNAL_SERVER_ERROR,
    };
    err(status, e.to_string())
}

fn session_json(session: &crate::store::Session) -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(serde_json::to_value(session).unwrap()),
    )
        .into_response()
}

/// Pause (T5): working -> paused. The process dies; the CLI
/// session id and the worktree keep the work. No finish event:
/// the quest is not done.
async fn pause_session(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !mutation_allowed(&headers) {
        return err(StatusCode::FORBIDDEN, "browser mutations need a dev origin and the x-repo-city header".to_string()).into_response();
    }
    let session = match state.store.transition_state(&id, &["working"], "paused") {
        Ok(s) => s,
        Err(e) => return transition_err(e).into_response(),
    };
    state.teardown_runtime(&id).await;
    let _ = state.emit(&id, Source::System, EventPayload::AgentMessage { text: "Session paused.".to_string() });
    session_json(&session).into_response()
}

/// Resume (T5): paused -> working. The watcher restarts on the
/// worktree, and a known CLI session id respawns with `--resume`.
/// A stopped or finished session cannot resume: it is not paused.
async fn resume_session(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !mutation_allowed(&headers) {
        return err(StatusCode::FORBIDDEN, "browser mutations need a dev origin and the x-repo-city header".to_string()).into_response();
    }
    if let Ok(Some(session)) = state.store.get_session(&id) {
        if let Some(island_id) = session.island_id.as_deref() {
            if let Ok(Some(holder)) =
                state.store.island_lock_holder(&session.repo_path, island_id, Some(&id))
            {
                return err(StatusCode::CONFLICT, format!("island {island_id} is held by session {}", holder.id)).into_response();
            }
        }
    }
    let session = match state.store.transition_state(&id, &["paused"], "working") {
        Ok(s) => s,
        Err(e) => return transition_err(e).into_response(),
    };
    let root = PathBuf::from(session.worktree_path.as_deref().unwrap_or(&session.repo_path));
    let _ = state.emit(&id, Source::System, EventPayload::SessionStarted { cli_session_id: session.cli_session_id.clone() });
    state.start_watcher(&id, &root);
    if let (Some(cli_id), Some(task)) = (session.cli_session_id.clone(), session.task.clone()) {
        spawn_claude(state.clone(), id.clone(), root, format!("Continue this task: {task}"), Some(cli_id));
    }
    session_json(&session).into_response()
}

/// Archive (T5): a finished, failed, or stopped quest leaves the
/// active list. Its events and report stay in the store.
async fn archive_session(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !mutation_allowed(&headers) {
        return err(StatusCode::FORBIDDEN, "browser mutations need a dev origin and the x-repo-city header".to_string()).into_response();
    }
    let session = match state
        .store
        .transition_state(&id, &["finished", "failed", "stopped"], "archived")
    {
        Ok(s) => s,
        Err(e) => return transition_err(e).into_response(),
    };
    let _ = state.emit(&id, Source::System, EventPayload::AgentMessage { text: "Session archived.".to_string() });
    session_json(&session).into_response()
}

#[derive(Deserialize)]
struct FollowUp {
    task: String,
}

/// Follow-up (T5): a finished or failed quest gets a new task in
/// the same CLI conversation and the same worktree. Without a CLI
/// session id there is no conversation to continue: honest 409.
async fn follow_up_session(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<FollowUp>,
) -> impl IntoResponse {
    if !mutation_allowed(&headers) {
        return err(StatusCode::FORBIDDEN, "browser mutations need a dev origin and the x-repo-city header".to_string()).into_response();
    }
    if body.task.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "task is empty".to_string()).into_response();
    }
    let before = match state.store.get_session(&id) {
        Ok(Some(s)) => s,
        Ok(None) => return err(StatusCode::NOT_FOUND, "session not found".to_string()).into_response(),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    let Some(cli_id) = before.cli_session_id.clone() else {
        return err(StatusCode::CONFLICT, "session has no CLI session to continue".to_string()).into_response();
    };
    if let Some(island_id) = before.island_id.as_deref() {
        if let Ok(Some(holder)) = state.store.island_lock_holder(&before.repo_path, island_id, Some(&id)) {
            return err(StatusCode::CONFLICT, format!("island {island_id} is held by session {}", holder.id)).into_response();
        }
    }
    let session = match state
        .store
        .transition_state(&id, &["finished", "failed"], "working")
    {
        Ok(s) => s,
        Err(e) => return transition_err(e).into_response(),
    };
    let _ = state.store.set_task(&id, &body.task);
    let root = PathBuf::from(session.worktree_path.as_deref().unwrap_or(&session.repo_path));
    let _ = state.emit(&id, Source::System, EventPayload::SessionStarted { cli_session_id: Some(cli_id.clone()) });
    state.start_watcher(&id, &root);
    spawn_claude(state.clone(), id.clone(), root, body.task.clone(), Some(cli_id));
    let updated = state.store.get_session(&id).ok().flatten().unwrap_or(session);
    session_json(&updated).into_response()
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
    headers: axum::http::HeaderMap,
    Query(q): Query<WsQuery>,
    upgrade: WebSocketUpgrade,
) -> impl IntoResponse {
    // CORS does not apply to WebSockets: check the Origin here so a
    // random page cannot read the full event stream.
    if !origin_allowed(&headers) {
        return err(
            StatusCode::FORBIDDEN,
            "websocket origin not allowed".to_string(),
        )
        .into_response();
    }
    upgrade
        .on_upgrade(move |socket| ws_socket(state, q.since_id, socket))
        .into_response()
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
