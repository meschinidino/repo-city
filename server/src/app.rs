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
    /// One async mutex per session id, held by every mutating
    /// route for its whole duration and by the completion-path
    /// follow-up auto-start. Accept's merge+checks window can run
    /// minutes; without this a second Accept, a Discard, or a
    /// follow-up could interleave it and strand or lose the work.
    /// Entries are never removed (one small Arc per id); holders
    /// take exactly one and never nest, so it cannot deadlock.
    session_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
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

    /// The mutex serializing mutations of one session. Held
    /// across the whole route body (see `session_locks`).
    fn session_lock(&self, session_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.session_locks
            .lock()
            .unwrap()
            .entry(session_id.to_string())
            .or_default()
            .clone()
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
        session_locks: Mutex::new(HashMap::new()),
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
        .route("/api/sessions/{id}/message", post(message_session))
        .route("/api/sessions/{id}/accept-preview", get(accept_preview))
        .route("/api/sessions/{id}/accept", post(accept_session))
        .route("/api/sessions/{id}/discard", post(discard_session))
        .route("/api/sessions/{id}/keep", post(keep_session))
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
    /// Agent model for the spawned Claude process (T12 form):
    /// a CLI alias (`opus`, `sonnet`, `haiku`) or a full model
    /// name. None = the CLI default.
    model: Option<String>,
    /// Agent effort for the spawned agent process. The word list
    /// depends on the agent. None = the CLI default.
    effort: Option<String>,
    /// Which agent CLI runs the quest: `claude` (default) or
    /// `muse`. Always validated; stored only when `spawn` is set.
    agent: Option<String>,
    /// Drag-connect source island (step 6): the quest makes
    /// `island_id` use this island. Same-island and island-less
    /// sources refuse below; the client also refuses duplicates
    /// and import cycles, which need the extraction graph.
    source_island_id: Option<String>,
}

/// True when the agent CLI binary is on this server's PATH.
/// Checked at create so a quest for a missing CLI refuses in
/// words instead of failing after its worktree exists.
fn cli_available(name: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|dir| {
                let candidate = dir.join(name);
                candidate.is_file()
                    && candidate
                        .metadata()
                        .map(|m| m.permissions().mode() & 0o111 != 0)
                        .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Agent, model, and effort as the chosen CLI takes them, or a
/// refusal. Model and effort word lists differ per agent; the
/// Muse effort list is the one `muse exec --help` prints.
fn valid_agent_choices(
    agent: &Option<String>,
    model: &Option<String>,
    effort: &Option<String>,
) -> Result<(String, Option<String>, Option<String>), String> {
    let agent = agent.as_deref().map(str::trim).filter(|a| !a.is_empty()).unwrap_or("claude");
    if !["claude", "muse"].contains(&agent) {
        return Err(format!("unknown agent `{agent}`: use claude or muse"));
    }
    let model = model.as_deref().map(str::trim).filter(|m| !m.is_empty());
    if let Some(m) = model {
        // Full names: <agent>-<letters, digits, dot, dash> with an
        // optional [1m] context suffix (Claude only). The value
        // goes to the CLI as one argv element (no shell), but it
        // is also stored and shown, so reject spaces and control
        // characters.
        let bare = m.strip_suffix("[1m]").unwrap_or(m);
        let clean = |name: &str, prefix: &str| {
            name.starts_with(prefix)
                && name.len() > prefix.len()
                && name.len() <= 60
                && name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
        };
        let ok = match agent {
            "muse" => clean(bare, "muse-") && bare == m,
            _ => ["opus", "sonnet", "haiku"].contains(&m) || clean(bare, "claude-"),
        };
        if !ok {
            return Err(match agent {
                "muse" => format!("unknown model `{m}`: use a full muse- name"),
                _ => format!("unknown model `{m}`: use opus, sonnet, haiku, or a full claude- name"),
            });
        }
    }
    let effort = effort.as_deref().map(str::trim).filter(|e| !e.is_empty());
    if let Some(e) = effort {
        let words: &[&str] = match agent {
            "muse" => &["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
            _ => &["low", "medium", "high", "xhigh", "max"],
        };
        if !words.contains(&e) {
            return Err(format!("unknown effort `{e}` for {agent}: use {}", words.join(", ")));
        }
    }
    Ok((agent.to_string(), model.map(str::to_string), effort.map(str::to_string)))
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
    // Island lock and the 3-quest cap are checked in the same
    // store lock as the insert (create_session_guarded).
    // Worktrees live under the user home, outside every checkout:
    // not in the repo (it would pollute the user git status) and
    // not in temp (the system can clean temp under a paused quest).
    let wt_root = std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".repo-city").join("worktrees"))
        .unwrap_or_else(|_| std::env::temp_dir().join("repo-city-worktrees"));
    let (agent, model, effort) = match valid_agent_choices(&body.agent, &body.model, &body.effort) {
        Ok(v) => v,
        Err(e) => return err(StatusCode::BAD_REQUEST, e).into_response(),
    };
    if body.spawn && !cli_available(&agent) {
        return err(
            StatusCode::BAD_REQUEST,
            format!("the {agent} CLI is not installed on this server"),
        )
        .into_response();
    }
    // The server validates the drag shape (both ends, not the
    // same island); the "a drag quest needs an agent" rule lives
    // in the client on purpose. API callers may stage a drag
    // quest before its agent run exists, and the lane it draws
    // stays honest: the wanted import does not exist yet.
    if let Some(source) = body.source_island_id.as_deref() {
        match body.island_id.as_deref() {
            None => {
                return err(
                    StatusCode::BAD_REQUEST,
                    "a drag-connect quest needs a target island next to its source island".to_string(),
                )
                .into_response()
            }
            Some(target) if target == source => {
                return err(StatusCode::BAD_REQUEST, "a quest cannot connect an island to itself".to_string())
                    .into_response()
            }
            Some(_) => {}
        }
    }
    // Watch-only sessions have no agent: store no agent, model,
    // or effort, whatever the caller sent (the client already
    // drops them).
    let (agent, model, effort) = if body.spawn {
        (Some(agent), model, effort)
    } else {
        (None, None, None)
    };
    // The T6 merge target: whatever is checked out when the
    // quest starts. Watcher-only quests merge nothing, so they
    // record none.
    let base_branch = if body.spawn {
        crate::worktree::current_branch(&root).ok()
    } else {
        None
    };
    let session = match state.store.create_session_guarded(
        &body.repo_path,
        body.island_id.as_deref(),
        body.task.as_deref(),
        body.spawn.then(|| wt_root.to_string_lossy().into_owned()).as_deref(),
        model.as_deref(),
        effort.as_deref(),
        agent.as_deref(),
        base_branch.as_deref(),
        body.source_island_id.as_deref(),
    ) {
        Ok(s) => s,
        Err(e @ crate::store::CreateError::IslandLocked { .. })
        | Err(e @ crate::store::CreateError::CapReached(_)) => {
            return err(StatusCode::CONFLICT, e.to_string()).into_response()
        }
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };
    // A spawned agent works in its own git worktree (T5), never in
    // the user's checkout. Shared dependencies stay read-only by
    // construction: the worktree holds tracked files only, and no
    // install step runs in the user's tree.
    let mut run_root = root.clone();
    if body.spawn {
        match crate::worktree::create_worktree(&root, &wt_root, &session.id) {
            Ok(path) => {
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
            spawn_agent(&session, state.clone(), run_root, task, None);
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
#[allow(clippy::too_many_arguments)]
fn spawn_claude(
    state: Arc<AppState>,
    session_id: String,
    cwd: PathBuf,
    task: String,
    resume_cli_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
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
        // The agent choices from the quest form (T12), kept on
        // resume and follow-up so a quest keeps its model/effort.
        if let Some(m) = &model {
            args.push("--model".into());
            args.push(m.clone());
        }
        if let Some(e) = &effort {
            args.push("--effort".into());
            args.push(e.clone());
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
        let my_pid = child.id();
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
                .is_some_and(|s| s.state != "working")
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
                        .is_some_and(|s| s.state != "working")
                {
                    continue;
                }
                let _ = state.emit(&session_id, Source::Cli, payload);
            }
            if finish_state.is_some() {
                break;
            }
        }
        // If /stop killed the child, it already removed the handle
        // and set the state; do not overwrite either. Take back
        // only our own child: a fast pause->resume may already
        // have registered the next run under this id.
        let mut child = {
            let mut map = state.children.lock().unwrap();
            if map.get(&session_id).and_then(|c| c.id()) == my_pid {
                map.remove(&session_id)
            } else {
                None
            }
        };
        let stopped_externally = child.is_none()
            || state
                .store
                .get_session(&session_id)
                .ok()
                .flatten()
                .is_some_and(|s| s.state != "working");
        if finish_state.is_some() || stopped_externally {
            if let Some(c) = child.as_mut() {
                let _ = c.start_kill();
            }
        }
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
            .is_some_and(|s| s.state != "working");
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
        // Talk-to-agent: a queued message starts the next run.
        if state
            .store
            .get_session(&session_id)
            .ok()
            .flatten()
            .is_some_and(|s| s.state == "finished")
        {
            run_pending_message(state.clone(), &session_id).await;
        }
    });
}

/// Spawn the agent CLI the quest chose at creation. Claude is
/// the default; `muse` runs `muse exec` in the same worktree
/// machinery (children map, watcher, stop races).
#[allow(clippy::too_many_arguments)]
fn spawn_agent(
    session: &crate::store::Session,
    state: Arc<AppState>,
    cwd: PathBuf,
    task: String,
    resume_cli_id: Option<String>,
) {
    match session.agent.as_deref() {
        Some("muse") => spawn_muse(
            state,
            session.id.clone(),
            cwd,
            task,
            resume_cli_id,
            session.model.clone(),
            session.effort.clone(),
        ),
        _ => spawn_claude(
            state,
            session.id.clone(),
            cwd,
            task,
            resume_cli_id,
            session.model.clone(),
            session.effort.clone(),
        ),
    }
}

/// Run the Muse adapter for one session. A Muse run is one
/// `muse exec` process; the session id is ours from the start
/// (the CLI takes `--session-id`), so pause, resume, and
/// follow-up continue the same conversation with a later exec.
/// Approval mode `never` is broader than Claude's acceptEdits:
/// it also runs shell commands unasked. The OS sandbox stays on
/// (no `--yolo`) and the run is inside a throwaway worktree;
/// T8 owns the permission bridge and must tighten this.
#[allow(clippy::too_many_arguments)]
fn spawn_muse(
    state: Arc<AppState>,
    session_id: String,
    cwd: PathBuf,
    task: String,
    resume_cli_id: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) {
    state.spawning.lock().unwrap().insert(session_id.clone());
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let muse_session_id = resume_cli_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let _ = state.store.set_cli_session_id(&session_id, &muse_session_id);
        let mut known_cli_id = Some(muse_session_id.clone());
        let mut args: Vec<String> = vec![
            "exec".into(),
            "--json".into(),
            "--session-id".into(),
            muse_session_id,
            "--workspace".into(),
            cwd.to_string_lossy().into_owned(),
            "--worktree=off".into(),
            "--approval-mode".into(),
            "never".into(),
            "--disable-reminders".into(),
        ];
        if let Some(m) = &model {
            args.push("--model".into());
            args.push(m.clone());
        }
        if let Some(e) = &effort {
            args.push("--effort".into());
            args.push(e.clone());
        }
        // `--` keeps a task that starts with `-` out of flag
        // parsing (proven against the installed CLI).
        args.push("--".into());
        args.push(task.clone());
        let mut child = match tokio::process::Command::new("muse")
            .args(&args)
            .current_dir(&cwd)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = state.emit(
                    &session_id,
                    Source::System,
                    EventPayload::SessionFinished {
                        outcome: Outcome::Failed,
                        reason: Some(format!("could not start muse: {e}")),
                    },
                );
                let _ = state.store.set_state(&session_id, "failed");
                state.spawning.lock().unwrap().remove(&session_id);
                return;
            }
        };
        let Some(stdout) = child.stdout.take() else {
            // No pipe to read: fail honestly instead of leaving
            // the session in `working` with no reader. The child
            // drops here and kill_on_drop stops it.
            let _ = state.emit(
                &session_id,
                Source::System,
                EventPayload::SessionFinished {
                    outcome: Outcome::Failed,
                    reason: Some("muse gave no output stream".to_string()),
                },
            );
            let _ = state.store.set_state(&session_id, "failed");
            state.spawning.lock().unwrap().remove(&session_id);
            return;
        };
        let my_pid = child.id();
        // Keep the last stderr lines: startup failures (bad
        // model, auth) land there, and the failure reason should
        // carry them instead of a bare "exited".
        let stderr_tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = stderr_tail.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut tail = tail.lock().unwrap();
                    tail.push(line);
                    if tail.len() > 5 {
                        tail.remove(0);
                    }
                }
            });
        }
        state
            .children
            .lock()
            .unwrap()
            .insert(session_id.clone(), child);
        state.spawning.lock().unwrap().remove(&session_id);
        let raw_cwd = cwd.clone();
        let cwd = std::fs::canonicalize(&cwd).unwrap_or(cwd);
        let mut lines = BufReader::new(stdout).lines();
        let mut finish_state: Option<&'static str> = None;
        while let Ok(Some(line)) = lines.next_line().await {
            if state
                .store
                .get_session(&session_id)
                .ok()
                .flatten()
                .is_some_and(|s| s.state != "working")
            {
                break;
            }
            let t = crate::adapters::muse::translate_line(&line);
            if let Some(cli_id) = &t.cli_session_id {
                if known_cli_id.as_deref() != Some(cli_id.as_str()) {
                    let _ = state.store.set_cli_session_id(&session_id, cli_id);
                    known_cli_id = Some(cli_id.clone());
                }
            }
            for payload in t.events {
                if let EventPayload::SessionFinished { outcome, .. } = &payload {
                    finish_state = Some(match outcome {
                        Outcome::Completed => "finished",
                        Outcome::Failed => "failed",
                        Outcome::Stopped => "stopped",
                    });
                }
                let payload = match payload {
                    EventPayload::FileTouched { path, change } => {
                        let rel = std::path::Path::new(&path)
                            .strip_prefix(&cwd)
                            .or_else(|_| std::path::Path::new(&path).strip_prefix(&raw_cwd))
                            .map(|p| p.to_string_lossy().replace('\\', "/"))
                            .unwrap_or(path);
                        EventPayload::FileTouched { path: rel, change }
                    }
                    other => other,
                };
                if matches!(payload, EventPayload::SessionFinished { .. })
                    && state
                        .store
                        .get_session(&session_id)
                        .ok()
                        .flatten()
                        .is_some_and(|s| s.state != "working")
                {
                    continue;
                }
                let _ = state.emit(&session_id, Source::Cli, payload);
            }
            if finish_state.is_some() {
                break;
            }
        }
        // Take only our own child back: a fast pause->resume may
        // already have registered the next run under this id.
        let mut child = {
            let mut map = state.children.lock().unwrap();
            if map.get(&session_id).and_then(|c| c.id()) == my_pid {
                map.remove(&session_id)
            } else {
                None
            }
        };
        let stopped_externally = child.is_none()
            || state
                .store
                .get_session(&session_id)
                .ok()
                .flatten()
                .is_some_and(|s| s.state != "working");
        if finish_state.is_some() || stopped_externally {
            if let Some(c) = child.as_mut() {
                let _ = c.start_kill();
            }
        }
        let status = match child.as_mut() {
            Some(c) => c.wait().await.map_err(|e| e.to_string()),
            None => Err("child already reaped".to_string()),
        };
        let stopped_during_wait = state
            .store
            .get_session(&session_id)
            .ok()
            .flatten()
            .is_some_and(|s| s.state != "working");
        if stopped_externally || stopped_during_wait {
            return;
        }
        if finish_state.is_none() {
            let ok = status.map(|s| s.success()).unwrap_or(false);
            let tail = stderr_tail.lock().unwrap().join(" | ");
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
                    } else if tail.is_empty() {
                        Some("muse exited without a terminal event".to_string())
                    } else {
                        Some(format!("muse exited without a terminal event: {tail}"))
                    },
                },
            );
            let _ = state
                .store
                .set_state(&session_id, if ok { "finished" } else { "failed" });
        } else if let Some(state_name) = finish_state {
            let _ = state.store.set_state(&session_id, state_name);
        }
        // Talk-to-agent: a queued message starts the next run.
        if state
            .store
            .get_session(&session_id)
            .ok()
            .flatten()
            .is_some_and(|s| s.state == "finished")
        {
            run_pending_message(state.clone(), &session_id).await;
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
    let _session_guard = state.session_lock(&id).lock_owned().await;
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
        TransitionError::BadMove { .. } | TransitionError::CapReached(_) => {
            StatusCode::CONFLICT
        }
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
    let _session_guard = state.session_lock(&id).lock_owned().await;
    let session = match state.store.transition_state(&id, &["working"], "paused") {
        Ok(s) => s,
        Err(e) => return transition_err(e).into_response(),
    };
    state.teardown_runtime(&id).await;
    let _ = state.emit(&id, Source::System, EventPayload::SessionPaused);
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
    let _session_guard = state.session_lock(&id).lock_owned().await;
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
    // With a CLI id, resume the conversation. Without one (paused
    // before the CLI init line), a spawned session starts fresh on
    // its task instead of sitting in `working` with no agent.
    if session.worktree_path.is_some() {
        // A queued message (talk-to-agent while paused) is the
        // resume instruction when one waits; otherwise the quest
        // continues its task in the same conversation.
        let queued = session.pending_task.clone();
        if let Some(q) = &queued {
            let _ = state.store.clear_pending_task_if(&id, q);
        }
        let prompt = match (queued, session.task.clone()) {
            (Some(q), _) => Some(q),
            (None, Some(task)) => Some(match &session.cli_session_id {
                Some(_) => format!("Continue this task: {task}"),
                None => task,
            }),
            (None, None) => None,
        };
        if let Some(prompt) = prompt {
            spawn_agent(&session, state.clone(), root, prompt, session.cli_session_id.clone());
        }
    }
    session_json(&session).into_response()
}

/// Send the queued message, if any, as the next run. Called by
/// both runners right after they land a `finished` state, and by
/// the message route itself (a message can land just after the
/// finish check: storing it must still start the run). The move
/// back to `working` goes through transition_state, so a stop
/// that landed after the finish wins. The island lock is
/// re-checked: finishing released the island, and another quest
/// may hold it now — the message then stays queued, in words.
/// Queued-message auto-start for the CLI-reader completion
/// paths: takes the session lock first, so a follow-up run can
/// never start inside an Accept/Discard window. Callers that
/// already hold the lock use `run_pending_message_locked`.
async fn run_pending_message(state: Arc<AppState>, session_id: &str) {
    let _session_guard = state.session_lock(session_id).lock_owned().await;
    run_pending_message_locked(state, session_id).await;
}

async fn run_pending_message_locked(state: Arc<AppState>, session_id: &str) {
    let Ok(Some(session)) = state.store.get_session(session_id) else {
        return;
    };
    let Some(task) = session.pending_task.clone() else {
        return;
    };
    if session.worktree_path.is_none() {
        return;
    }
    if session.state != "finished" {
        // A route moved the quest while this waited on the lock
        // (accepted, discarded, stopped): nothing to start, and
        // no message belongs on a closed quest. The pending text
        // stays put rather than vanishing silently.
        return;
    }
    if let Some(island_id) = session.island_id.as_deref() {
        if let Ok(Some(holder)) =
            state.store.island_lock_holder(&session.repo_path, island_id, Some(session_id))
        {
            let _ = state.emit(
                session_id,
                Source::System,
                EventPayload::AgentMessage {
                    text: format!(
                        "Queued message waits: island {island_id} is held by session {}.",
                        holder.id
                    ),
                },
            );
            return;
        }
    }
    // Register the spawn before the state move: a /stop in the
    // gap then finds the marker, waits for the child, and kills
    // it, instead of reporting success while a run starts.
    state.spawning.lock().unwrap().insert(session_id.to_string());
    // Take the message only if it is still the one we read; a
    // newer queued message survives for the next finish.
    match state.store.clear_pending_task_if(session_id, &task) {
        Ok(true) => {}
        _ => {
            state.spawning.lock().unwrap().remove(session_id);
            return;
        }
    }
    let Ok(session) = state.store.transition_state(session_id, &["finished"], "working") else {
        // The move failed (a stop landed): give the message
        // back if no newer one replaced it meanwhile.
        let still_none = state
            .store
            .get_session(session_id)
            .ok()
            .flatten()
            .is_some_and(|s| s.pending_task.is_none());
        if still_none {
            let _ = state.store.set_pending_task(session_id, Some(&task));
        }
        state.spawning.lock().unwrap().remove(session_id);
        return;
    };
    let _ = state.store.set_task(session_id, &task);
    let _ = state.emit(
        session_id,
        Source::System,
        EventPayload::SessionStarted {
            cli_session_id: session.cli_session_id.clone(),
        },
    );
    let root = PathBuf::from(session.worktree_path.clone().unwrap_or_default());
    spawn_agent(&session, state, root, task, session.cli_session_id.clone());
}

/// Message the agent (talk-to-agent). While a run is live the
/// message queues and runs when the run ends; while paused it
/// runs on resume. A finished quest takes the follow-up route
/// instead (the client sends it there); a watch-only quest has
/// no agent to talk to.
async fn message_session(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<FollowUp>,
) -> impl IntoResponse {
    if !mutation_allowed(&headers) {
        return err(StatusCode::FORBIDDEN, "browser mutations need a dev origin and the x-repo-city header".to_string()).into_response();
    }
    if body.task.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "message is empty".to_string()).into_response();
    }
    let _session_guard = state.session_lock(&id).lock_owned().await;
    let session = match state.store.get_session(&id) {
        Ok(Some(s)) => s,
        Ok(None) => return err(StatusCode::NOT_FOUND, "session not found".to_string()).into_response(),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    if session.worktree_path.is_none() {
        return err(StatusCode::CONFLICT, "this is a watch-only quest: no agent runs, so there is no one to message".to_string()).into_response();
    }
    match session.state.as_str() {
        "working" | "paused" => {
            if let Err(e) = state.store.set_pending_task(&id, Some(body.task.trim())) {
                return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response();
            }
            // The run may have finished between the read above
            // and this store: try the auto-start now, so an
            // accepted message is never stranded in the queue.
            // A second message replaces the queued one.
            if session.state == "working" {
                run_pending_message_locked(state.clone(), &id).await;
            }
            let updated = state.store.get_session(&id).ok().flatten().unwrap_or(session);
            session_json(&updated).into_response()
        }
        other => err(
            StatusCode::CONFLICT,
            format!("quest is {other}: message a working or paused quest, or send a follow-up to a finished one"),
        )
        .into_response(),
    }
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
    let _session_guard = state.session_lock(&id).lock_owned().await;
    let session = match state
        .store
        .transition_state(&id, &["finished", "failed", "stopped", "accepted", "discarded", "kept"], "archived")
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

/// Follow-up (T5): a finished, failed, or kept quest gets a new
/// task in the same CLI conversation and the same worktree. This
/// is also the conflict path's "send back to fix it". Without a
/// CLI session id there is no conversation to continue: honest 409.
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
    let _session_guard = state.session_lock(&id).lock_owned().await;
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
        .transition_state(&id, &["finished", "failed", "kept", "stopped"], "working")
    {
        Ok(s) => s,
        Err(e) => return transition_err(e).into_response(),
    };
    let _ = state.store.set_task(&id, &body.task);
    let root = PathBuf::from(session.worktree_path.as_deref().unwrap_or(&session.repo_path));
    let _ = state.emit(&id, Source::System, EventPayload::SessionStarted { cli_session_id: Some(cli_id.clone()) });
    state.start_watcher(&id, &root);
    spawn_agent(&before, state.clone(), root, body.task.clone(), Some(cli_id));
    let updated = state.store.get_session(&id).ok().flatten().unwrap_or(session);
    session_json(&updated).into_response()
}

/// How long the post-merge checks may run before Accept calls
/// them failed and rolls the merge back.
const TEST_TIMEOUT_SECS: u64 = 300;

/// Last characters of the check output kept for the card.
const TEST_TAIL_CHARS: usize = 2000;

/// Grace past the kill during which the output reader may
/// finish; then Accept proceeds without the tail rather than
/// hanging on a pipe a straggler holds.
const READER_GRACE_SECS: u64 = 10;

/// Probe before the orphan reap: pipes held past this after a
/// NORMAL exit can only be orphaned grandchildren (nothing else
/// inherits these pipes), so the group kill below is targeted.
/// The happy path drains at once and never pays this second.
const ORPHAN_PROBE_SECS: u64 = 1;

/// SIGKILL a whole process group (Unix). Best effort by design:
/// a reaped group (ESRCH) is the common case. Known limit: the id
/// is the reaped leader's, so a fully exited group whose id the
/// kernel recycled could misdirect the signal. That needs tens of
/// thousands of forks inside the grace window plus the recycled id
/// becoming a new group leader; the timeout path has always
/// carried the same risk, and no race-free liveness check exists
/// (killpg with signal 0 shares the TOCTOU).
#[cfg(unix)]
fn kill_process_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        unsafe {
            libc::killpg(pid as i32, libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
fn kill_process_group(_pid: Option<u32>) {}

/// Run the discovered test command in `dir`: no shell, output
/// piped, killed on timeout. Returns (passed, output tail).
async fn run_checks(dir: &std::path::Path, command: &str) -> (bool, String) {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    let mut parts = command.split_whitespace();
    let Some(program) = parts.next() else {
        return (false, "empty test command".to_string());
    };
    let args: Vec<&str> = parts.collect();
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(&args)
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Own process group, Unix only (inherent tokio method):
    // the kills below then reach grandchildren (node, vitest)
    // too, so no orphan can hold the pipes (or the machine).
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return (false, format!("could not run {command}: {e}")),
    };
    // Read now: the handle may stop reporting it after exit.
    let pid = child.id();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    // Both pipes drain at once: a suite loud on stderr must not
    // wedge while stdout is being read.
    let mut reader = tokio::spawn(async move {
        let drain_out = async {
            let mut v = Vec::new();
            if let Some(o) = stdout.as_mut() {
                let _ = o.read_to_end(&mut v).await;
            }
            v
        };
        let drain_err = async {
            let mut v = Vec::new();
            if let Some(e) = stderr.as_mut() {
                let _ = e.read_to_end(&mut v).await;
            }
            v
        };
        tokio::join!(drain_out, drain_err)
    });
    // One waiter at a time: on timeout the wait future drops
    // and the handle stays usable for the kill below.
    let (timed_out, status) = match tokio::time::timeout(Duration::from_secs(TEST_TIMEOUT_SECS), child.wait()).await
    {
        Ok(Ok(status)) => (false, Some(status)),
        Ok(Err(_)) => (false, None),
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            // The direct child is dead; reap the group so no
            // grandchild holds the pipes (or the machine).
            kill_process_group(pid);
            (true, None)
        }
    };
    // The common case drains at once. Pipes still open past
    // the probe after a NORMAL exit mean orphaned grandchildren
    // (only they inherit these pipes): reap the group to unblock
    // the drain. After a timeout the group is already reaped.
    let first = tokio::time::timeout(Duration::from_secs(ORPHAN_PROBE_SECS), &mut reader).await;
    if first.is_err() && !timed_out {
        kill_process_group(pid);
    }
    let (out, err) = match first {
        Ok(Ok((o, e))) => (o, e),
        Ok(Err(_)) => (Vec::new(), b"(check output lost: the reader task failed)\n".to_vec()),
        Err(_) => match tokio::time::timeout(Duration::from_secs(READER_GRACE_SECS), &mut reader).await {
            Ok(Ok((o, e))) => (o, e),
            // A straggler outside the group still holds a pipe
            // (it escaped the group, or this is not Unix): stop
            // the reader and proceed with a note instead of
            // hanging. The straggler exits alone.
            _ => {
                reader.abort();
                (Vec::new(), b"(output lost: a test subprocess outlived the run and held the pipes)\n".to_vec())
            }
        },
    };
    if !timed_out {
        // Final reap: grandchildren that never held the pipes
        // (redirected output, daemonized servers) survive the
        // drain above. Nothing a check spawns may outlive it; a
        // fully exited group answers ESRCH.
        kill_process_group(pid);
    }
    let mut text = String::from_utf8_lossy(&out).into_owned();
    text.push_str(&String::from_utf8_lossy(&err));
    let tail: String = text.chars().skip(text.chars().count().saturating_sub(TEST_TAIL_CHARS)).collect();
    if timed_out {
        return (false, format!("timed out after {TEST_TIMEOUT_SECS}s; last output:\n{tail}"));
    }
    (status.is_some_and(|s| s.success()), tail)
}

/// Read-only Accept preview for the report card (T6): the merge
/// target, what is checked out now, dirty files, and the test
/// command that would run. The POST re-checks everything.
async fn accept_preview(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let session = match state.store.get_session(&id) {
        Ok(Some(s)) => s,
        Ok(None) => return err(StatusCode::NOT_FOUND, "session not found".to_string()).into_response(),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    let state_ok = ["stopped", "finished", "failed", "kept"].contains(&session.state.as_str());
    let worktree_exists = session.worktree_path.as_deref().is_some_and(|p| {
        let path = PathBuf::from(p);
        path.is_dir() && path.join(".git").exists()
    });
    let root = PathBuf::from(&session.repo_path);
    let current_branch = crate::worktree::current_branch(&root).ok();
    let on_target = match (&session.base_branch, &current_branch) {
        (Some(base), Some(current)) => base == current,
        _ => false,
    };
    let dirty_files = crate::worktree::dirty_files(&root).unwrap_or_default();
    let merge_in_progress = crate::worktree::merge_in_progress(&root);
    let test = crate::worktree::discover_test_command(&root).map(|t| {
        serde_json::json!({
            "command": t.command,
            "source": t.source,
            "dir": t.dir.to_string_lossy(),
        })
    });
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "session": serde_json::to_value(&session).unwrap(),
            "state_ok": state_ok,
            "worktree_exists": worktree_exists,
            "base_branch": session.base_branch,
            "current_branch": current_branch,
            "on_target": on_target,
            "dirty_files": dirty_files,
            "merge_in_progress": merge_in_progress,
            "test": test,
        })),
    )
        .into_response()
}

/// Accept (T6): merge the session branch into the branch that was
/// checked out at creation, then re-run the checks. Every guard
/// refuses with the reason: wrong state, no worktree, unknown
/// target, wrong checkout, unfinished or dirty main, conflict,
/// failing checks (the merge is rolled back). A merged quest
/// loses its worktree and branch; retrying after a half-failure
/// is safe (an already-merged branch merges to a no-op).
async fn accept_session(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !mutation_allowed(&headers) {
        return err(StatusCode::FORBIDDEN, "browser mutations need a dev origin and the x-repo-city header".to_string()).into_response();
    }
    let _session_guard = state.session_lock(&id).lock_owned().await;
    let session = match state.store.get_session(&id) {
        Ok(Some(s)) => s,
        Ok(None) => return err(StatusCode::NOT_FOUND, "session not found".to_string()).into_response(),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    if ["working", "paused"].contains(&session.state.as_str()) {
        return err(
            StatusCode::CONFLICT,
            format!("the quest is still {}; stop it first, then accept", session.state),
        )
        .into_response();
    }
    if !["stopped", "finished", "failed", "kept"].contains(&session.state.as_str()) {
        return err(
            StatusCode::CONFLICT,
            format!("a {} quest cannot be accepted", session.state),
        )
        .into_response();
    }
    let Some(wt) = session.worktree_path.clone() else {
        return err(StatusCode::CONFLICT, "this quest has no worktree: there is nothing to merge".to_string())
            .into_response();
    };
    let wt_path = PathBuf::from(&wt);
    if !(wt_path.is_dir() && wt_path.join(".git").exists()) {
        return err(StatusCode::CONFLICT, "the quest worktree is gone; there is nothing to merge".to_string())
            .into_response();
    }
    let Some(base) = session.base_branch.clone() else {
        return err(
            StatusCode::CONFLICT,
            "this quest started before the finish flow learned merge targets; its target branch was never recorded".to_string(),
        )
        .into_response();
    };
    if base == "HEAD" {
        return err(
            StatusCode::CONFLICT,
            "the main checkout was detached when this quest started, so it has no merge target".to_string(),
        )
        .into_response();
    }
    let root = PathBuf::from(&session.repo_path);
    let current = match crate::worktree::current_branch(&root) {
        Ok(b) => b,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("could not read the main checkout: {e}")).into_response(),
    };
    if current != base {
        return err(
            StatusCode::CONFLICT,
            format!("the main checkout is on {current}; switch it to {base} to accept this quest"),
        )
        .into_response();
    }
    if crate::worktree::merge_in_progress(&root) {
        return err(
            StatusCode::CONFLICT,
            "the main checkout has an unfinished merge; finish or abort it first".to_string(),
        )
        .into_response();
    }
    let dirty = match crate::worktree::dirty_files(&root) {
        Ok(d) => d,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("could not read the main checkout: {e}")).into_response(),
    };
    if !dirty.is_empty() {
        return err(
            StatusCode::CONFLICT,
            format!("the main checkout has uncommitted changes ({}); commit or stash them first", dirty.join(", ")),
        )
        .into_response();
    }
    // The agent never commits; Accept lands its uncommitted work
    // on the session branch first, labeled as such.
    match crate::worktree::dirty_files(&wt_path) {
        Ok(d) if !d.is_empty() => {
            let short = &session.id[..session.id.len().min(8)];
            if let Err(e) = crate::worktree::commit_all(&wt_path, &format!("Repo City: accept quest {short} work")) {
                return err(StatusCode::INTERNAL_SERVER_ERROR, format!("could not commit the quest work: {e}")).into_response();
            }
        }
        Ok(_) => {}
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("could not read the quest worktree: {e}")).into_response(),
    }
    let branch = crate::worktree::branch_for(&session.id);
    let pre_sha = match crate::worktree::head_sha(&root) {
        Ok(sha) => sha,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("could not read the main checkout: {e}")).into_response(),
    };
    let merge_sha = match crate::worktree::merge_branch(&root, &branch) {
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, format!("the merge failed: {e}")).into_response(),
        Ok(crate::worktree::MergeOutcome::Conflict { files }) => {
            return err(
                StatusCode::CONFLICT,
                format!("the merge conflicts on {}; send the quest back to fix it, or discard", files.join(", ")),
            )
            .into_response();
        }
        Ok(crate::worktree::MergeOutcome::Merged { sha }) => sha,
    };
    // Checks re-run after every merge, in the merged tree.
    let test = crate::worktree::discover_test_command(&root);
    let (test_command, test_source, test_passed, test_output) = match &test {
        None => (None, None, None, "no test command found (package.json, justfile, Makefile); not run".to_string()),
        Some(t) => {
            let (passed, tail) = run_checks(&t.dir, &t.command).await;
            (Some(t.command.clone()), Some(t.source.clone()), Some(passed), tail)
        }
    };
    // The check outcome is a real test result: the island flies
    // the pennant and the card quotes it. "Not run" logs nothing.
    if let (Some(cmd), Some(passed)) = (&test_command, test_passed) {
        let _ = state.emit(
            &id,
            Source::System,
            EventPayload::TestResult {
                passed,
                summary: format!("{cmd} after merge: {}", if passed { "passed" } else { "failed" }),
            },
        );
    }
    if test_passed == Some(false) {
        let _ = crate::worktree::reset_hard(&root, &pre_sha);
        return err(
            StatusCode::CONFLICT,
            format!(
                "checks failed ({} from {}); the merge was rolled back. Last output:\n{}",
                test_command.unwrap_or_default(),
                test_source.unwrap_or_default(),
                test_output
            ),
        )
        .into_response();
    }
    // Cleanup is janitorial: the work is merged and the checks
    // passed, so a failure here must not strand the quest in a
    // state no retry can leave (the dir may already be gone). The
    // quest accepts; the warning names the leftover branch and
    // the manual command that finishes the job.
    let cleanup_warning = match crate::worktree::remove_worktree(&root, &wt_path, &session.id) {
        Ok(()) => None,
        Err(e) => Some(format!(
            "the worktree cleanup failed ({e}); the work is merged, but finish by hand: {}",
            crate::worktree::manual_cleanup_hint(&root, &wt_path, &branch),
        )),
    };
    let session = match state.store.transition_state(&id, &["stopped", "finished", "failed", "kept"], "accepted") {
        Ok(s) => s,
        Err(e) => return transition_err(e).into_response(),
    };
    let checks = match (&test_command, test_passed) {
        (Some(cmd), Some(true)) => format!("checks passed ({cmd})"),
        _ => "checks not run (no test command found)".to_string(),
    };
    let _ = state.emit(
        &id,
        Source::System,
        EventPayload::AgentMessage {
            text: format!(
                "Quest accepted: merged {branch} into {base} ({}). {checks}.{}",
                &merge_sha[..merge_sha.len().min(8)],
                cleanup_warning.as_deref().map(|w| format!(" Warning: {w}")).unwrap_or_default()
            ),
        },
    );
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "session": serde_json::to_value(&session).unwrap(),
            "merge_sha": merge_sha,
            "test_command": test_command,
            "test_source": test_source,
            "test_passed": test_passed,
            "test_output": test_output,
            "cleanup_warning": cleanup_warning,
        })),
    )
        .into_response()
}

/// Discard (T6): the worktree and session branch go away after the
/// card's explicit confirmation. Allowed from any live state: a
/// running quest is stopped first. Already-accepted or already-
/// discarded quests refuse.
async fn discard_session(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !mutation_allowed(&headers) {
        return err(StatusCode::FORBIDDEN, "browser mutations need a dev origin and the x-repo-city header".to_string()).into_response();
    }
    let _session_guard = state.session_lock(&id).lock_owned().await;
    let session = match state.store.get_session(&id) {
        Ok(Some(s)) => s,
        Ok(None) => return err(StatusCode::NOT_FOUND, "session not found".to_string()).into_response(),
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
    };
    if ["accepted", "discarded"].contains(&session.state.as_str()) {
        return err(StatusCode::CONFLICT, format!("the quest is already {}", session.state)).into_response();
    }
    // The state move is the commit point: teardown_runtime
    // requires it first, and a cleanup failure below must never
    // resurrect the quest. The lock rules out races between the
    // read above and this move.
    let live = ["working", "paused"].contains(&session.state.as_str());
    let session = match state.store.transition_state(
        &id,
        &["working", "paused", "stopped", "finished", "failed", "kept", "archived"],
        "discarded",
    ) {
        Ok(s) => s,
        Err(e) => return transition_err(e).into_response(),
    };
    if live {
        state.teardown_runtime(&id).await;
    }
    let root = PathBuf::from(&session.repo_path);
    let mut gone_already = true;
    if let Some(wt) = session.worktree_path.as_deref() {
        let wt_path = PathBuf::from(wt);
        gone_already = !wt_path.exists();
        if let Err(e) = crate::worktree::remove_worktree(&root, &wt_path, &session.id) {
            // No API retry: a second Discard refuses an already
            // discarded quest, and a held branch would fail again
            // anyway. The message carries the manual command.
            let branch = crate::worktree::branch_for(&session.id);
            return err(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!(
                    "the quest is discarded, but the worktree removal failed: {e}; finish by hand: {}",
                    crate::worktree::manual_cleanup_hint(&root, &wt_path, &branch),
                ),
            )
            .into_response();
        }
    }
    let _ = state.emit(
        &id,
        Source::System,
        EventPayload::AgentMessage {
            text: if gone_already {
                "Quest discarded: the worktree was already gone.".to_string()
            } else {
                "Quest discarded: the worktree and session branch were removed.".to_string()
            },
        },
    );
    session_json(&session).into_response()
}

/// Keep for later (T6): the worktree stays untouched and the
/// quest reads finished-unmerged. The island lock is already
/// released (it covers working/paused only).
async fn keep_session(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if !mutation_allowed(&headers) {
        return err(StatusCode::FORBIDDEN, "browser mutations need a dev origin and the x-repo-city header".to_string()).into_response();
    }
    let _session_guard = state.session_lock(&id).lock_owned().await;
    let session = match state.store.transition_state(&id, &["stopped", "finished", "failed"], "kept") {
        Ok(s) => s,
        Err(e) => return transition_err(e).into_response(),
    };
    let _ = state.emit(
        &id,
        Source::System,
        EventPayload::AgentMessage {
            text: "Quest kept for later: the worktree stays untouched.".to_string(),
        },
    );
    session_json(&session).into_response()
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

#[cfg(test)]
mod agent_choice_tests {
    use super::valid_agent_choices;

    fn v(agent: &str, model: &str, effort: &str) -> Result<(String, Option<String>, Option<String>), String> {
        valid_agent_choices(
            &Some(agent.to_string()),
            &Some(model.to_string()),
            &Some(effort.to_string()),
        )
    }

    #[test]
    fn claude_aliases_and_full_names_pass() {
        assert!(v("claude", "opus", "low").is_ok());
        assert!(v("claude", "sonnet", "xhigh").is_ok());
        assert!(v("claude", "haiku", "max").is_ok());
        assert!(v("claude", "claude-opus-4-1", "high").is_ok());
        assert!(v("claude", "claude-sonnet-5[1m]", "medium").is_ok());
    }

    #[test]
    fn muse_names_and_efforts_pass() {
        assert!(v("muse", "muse-spark-1.3", "ultra").is_ok());
        assert!(v("muse", "muse-wonder-1.0", "none").is_ok());
        assert!(v("muse", "muse-wonder-1.0", "minimal").is_ok());
    }

    #[test]
    fn blanks_mean_cli_default() {
        let none: Option<String> = None;
        assert_eq!(
            valid_agent_choices(&none, &none, &none).unwrap(),
            ("claude".to_string(), None, None)
        );
        assert_eq!(v("claude", "  ", " ").unwrap().1, None);
        assert_eq!(v("claude", " opus ", " high ").unwrap().1.as_deref(), Some("opus"));
    }

    #[test]
    fn bad_values_are_refused() {
        assert!(v("codex", "opus", "low").is_err());
        assert!(v("claude", "gpt-5", "low").is_err());
        assert!(v("claude", "opus", "High").is_err());
        assert!(v("claude", "opus", "ultra").is_err());
        assert!(v("muse", "opus", "low").is_err());
        assert!(v("muse", "claude-opus-4-1", "low").is_err());
        assert!(v("claude", "claude-x y", "low").is_err());
        assert!(v("claude", "claude-X", "low").is_err());
        let too_long = format!("claude-{}", "a".repeat(60));
        assert!(v("claude", &too_long, "low").is_err());
    }
}

#[cfg(test)]
mod run_checks_tests {
    use super::{run_checks, TEST_TAIL_CHARS};
    use std::time::Duration;

    // Opus review P1-4: 200KB on stderr must not wedge the drain.
    // (Script files: run_checks splits the command on whitespace,
    // so no quoting survives.)
    #[tokio::test]
    async fn checks_drain_a_loud_stderr_without_wedging() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("loud.py"), "import sys\nsys.stderr.write('x'*200000)\n").unwrap();
        let (passed, tail) = run_checks(dir.path(), "python3 loud.py").await;
        assert!(passed);
        assert_eq!(tail.chars().count(), TEST_TAIL_CHARS);
    }

    // Opus review P1-5: an orphaned grandchild must not hold the
    // pipes past the grace period (old code: a 60 s hang here).
    // Codex review P2: the group reap must actually kill the
    // orphan — Accept returns with nothing left behind.
    // Opus re-review P2: that includes a grandchild with
    // redirected output, which never holds the pipes.
    #[tokio::test]
    async fn checks_do_not_wait_out_orphaned_grandchildren() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("orphan.sh"),
            "#!/bin/sh\nsleep 60 & echo $! > sleep.pid\nsleep 61 >/dev/null 2>&1 & echo $! > sleep2.pid\nexit 1\n",
        )
        .unwrap();
        let start = std::time::Instant::now();
        let (passed, _) = run_checks(dir.path(), "sh orphan.sh").await;
        assert!(!passed);
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "took {:?}",
            start.elapsed()
        );
        // Both orphans are reaped (Unix: the reap is a no-op stub
        // elsewhere, so the pid check only runs where killpg
        // exists). kill(pid, 0) also answers 0 for a zombie, so
        // this assumes PID 1 reaps promptly (launchd does; a Linux
        // container without init would fail here — the repo has no
        // Linux CI, and the gates run on macOS).
        #[cfg(unix)]
        {
            for pid_file in ["sleep.pid", "sleep2.pid"] {
                assert_pid_dead(&dir.path().join(pid_file)).await;
            }
        }
    }

    // The pipe-holding orphan above trips the probe reap, which
    // would kill a detached sibling too — so this case, with ONLY
    // redirected descendants, is what pins the final reap. Remove
    // the final kill and detached.pid stays alive.
    #[tokio::test]
    async fn checks_reap_detached_grandchildren() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("detached.sh"),
            "#!/bin/sh\nsleep 62 >/dev/null 2>&1 & echo $! > detached.pid\nexit 0\n",
        )
        .unwrap();
        let start = std::time::Instant::now();
        let (passed, _) = run_checks(dir.path(), "sh detached.sh").await;
        assert!(passed);
        // The drain completes at once (nothing holds the pipes),
        // so the probe never fires: only the final reap can kill
        // the detached sleep.
        assert!(start.elapsed() < Duration::from_secs(30), "took {:?}", start.elapsed());
        #[cfg(unix)]
        {
            assert_pid_dead(&dir.path().join("detached.pid")).await;
        }
    }

    #[cfg(unix)]
    async fn assert_pid_dead(pid_file: &std::path::Path) {
        let pid: i32 = std::fs::read_to_string(pid_file).unwrap().trim().parse().unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while unsafe { libc::kill(pid, 0) } == 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "orphaned sleep {pid} still alive");
    }
}

#[cfg(test)]
mod pending_message_tests {
    use super::{run_pending_message, AppState};
    use crate::events::EventPayload;
    use crate::store::Store;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn test_state(store: Arc<Store>) -> Arc<AppState> {
        let (tx, _) = tokio::sync::broadcast::channel(16);
        Arc::new(AppState {
            store,
            tx,
            watchers: Mutex::new(std::collections::HashMap::new()),
            children: Mutex::new(std::collections::HashMap::new()),
            spawning: Mutex::new(std::collections::HashSet::new()),
            emit_lock: Arc::new(Mutex::new(())),
            session_locks: Mutex::new(std::collections::HashMap::new()),
            debounce: Duration::from_millis(50),
        })
    }

    // Codex review P1: the completion-path auto-start takes the
    // session lock, so no follow-up run can start inside an
    // Accept/Discard window. The waiter sits behind an island
    // lock (no CLI can spawn); the waits-event proves when the
    // auto-start ran.
    #[tokio::test]
    async fn pending_followup_waits_for_the_session_lock() {
        let store = Arc::new(Store::in_memory().unwrap());
        let state = test_state(store.clone());
        let holder = store
            .create_session_chosen("/repo", None, Some("api"), Some("hold"), None, None, None, None, None)
            .unwrap();
        assert_eq!(holder.state, "working");
        let waiter = store
            .create_session_chosen("/repo", None, Some("api"), Some("wait"), None, None, None, None, None)
            .unwrap();
        store.set_state(&waiter.id, "finished").unwrap();
        store.set_pending_task(&waiter.id, Some("go on")).unwrap();
        store.set_worktree_path(&waiter.id, "/nowhere/wt").unwrap();

        let guard = state.session_lock(&waiter.id).lock_owned().await;
        let waiter_id = waiter.id.clone();
        let task = tokio::spawn(async move { run_pending_message(state, &waiter_id).await });
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(store.events_for(&waiter.id, 0).unwrap().is_empty());
        drop(guard);
        task.await.unwrap();

        let events = store.events_for(&waiter.id, 0).unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0].payload,
            EventPayload::AgentMessage { text } if text.contains("Queued message waits")
        ));
        let back = store.get_session(&waiter.id).unwrap().unwrap();
        assert_eq!(back.state, "finished");
        assert_eq!(back.pending_task.as_deref(), Some("go on"));
    }

    // Opus re-review: an auto-start that waited out an Accept or
    // Discard finds a closed quest and stays silent — no
    // "Queued message waits" on a quest that can never run. The
    // pending text stays put rather than vanishing.
    #[tokio::test]
    async fn pending_followup_stays_silent_on_a_closed_quest() {
        let store = Arc::new(Store::in_memory().unwrap());
        let state = test_state(store.clone());
        store
            .create_session_chosen("/repo", None, Some("api"), Some("hold"), None, None, None, None, None)
            .unwrap();
        let waiter = store
            .create_session_chosen("/repo", None, Some("api"), Some("wait"), None, None, None, None, None)
            .unwrap();
        store.set_state(&waiter.id, "finished").unwrap();
        store.set_pending_task(&waiter.id, Some("go on")).unwrap();
        store.set_worktree_path(&waiter.id, "/nowhere/wt").unwrap();
        // Accept (or Discard) moved the quest while the auto-start
        // waited on the session lock.
        store.set_state(&waiter.id, "discarded").unwrap();

        run_pending_message(state.clone(), &waiter.id).await;

        assert!(store.events_for(&waiter.id, 0).unwrap().is_empty());
        let back = store.get_session(&waiter.id).unwrap().unwrap();
        assert_eq!(back.state, "discarded");
        assert_eq!(back.pending_task.as_deref(), Some("go on"));
    }
}
