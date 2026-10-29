//! T6 finish flow over real HTTP: guarded Accept (merge + checks),
//! Discard, Keep, and the preview. Each test owns a real git repo
//! with a real session worktree; no agent CLI is spawned (quests
//! are seeded in the store and stopped through the API).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use repo_city_server::app::build_app_with;
use repo_city_server::store::{Store, Session};
use repo_city_server::worktree;

async fn serve_with(store: Arc<Store>) -> String {
    let app = build_app_with(store, Duration::from_millis(50));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn git(repo: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap()
        .status
        .success();
    assert!(ok, "git {args:?} failed in {}", repo.display());
}

fn git_out(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?} failed in {}", repo.display());
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A real git repo at `<tmp>/repo` plus a worktree root at
/// `<tmp>/wts` (outside the repo, or the main checkout would
/// read dirty). `make_test` selects the Makefile test target.
fn temp_repo(make_test: Option<&str>) -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["config", "user.email", "t@example.com"]);
    git(&repo, &["config", "user.name", "T"]);
    std::fs::write(repo.join("a.txt"), "one\n").unwrap();
    if let Some(body) = make_test {
        std::fs::write(repo.join("Makefile"), format!("test:\n\t{body}\n")).unwrap();
    }
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    tmp
}

/// A spawned-shaped session: store row with base branch plus a
/// real worktree on the session branch. The worktree gets its
/// own git identity (linked worktrees do not inherit the main
/// checkout's local config).
fn seed_quest(store: &Store, repo: &Path, wt_root: &Path, island: Option<&str>) -> Session {
    let base = worktree::current_branch(repo).unwrap();
    let s = store
        .create_session_chosen(
            repo.to_str().unwrap(),
            None,
            island,
            Some("quest"),
            None,
            None,
            Some("claude"),
            Some(&base),
        )
        .unwrap();
    let wt = worktree::create_worktree(repo, wt_root, &s.id).unwrap();
    git(&wt, &["config", "user.email", "t@example.com"]);
    git(&wt, &["config", "user.name", "T"]);
    store.set_worktree_path(&s.id, wt.to_str().unwrap()).unwrap();
    store.get_session(&s.id).unwrap().unwrap()
}

async fn act(base: &str, id: &str, action: &str) -> (reqwest::StatusCode, serde_json::Value) {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{base}/api/sessions/{id}/{action}"))
        .send()
        .await
        .unwrap();
    let status = resp.status();
    (status, resp.json().await.unwrap_or(serde_json::Value::Null))
}

async fn get_session(base: &str, id: &str) -> (reqwest::StatusCode, serde_json::Value) {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{base}/api/sessions/{id}"))
        .send()
        .await
        .unwrap();
    let status = resp.status();
    (status, resp.json().await.unwrap_or(serde_json::Value::Null))
}

async fn get_preview(base: &str, id: &str) -> (reqwest::StatusCode, serde_json::Value) {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{base}/api/sessions/{id}/accept-preview"))
        .send()
        .await
        .unwrap();
    let status = resp.status();
    (status, resp.json().await.unwrap_or(serde_json::Value::Null))
}

fn err_text(v: &serde_json::Value) -> &str {
    v["error"].as_str().unwrap_or("<no error text>")
}

#[tokio::test]
async fn accept_merges_uncommitted_work_runs_checks_and_cleans_up() {
    let tmp = temp_repo(Some("true"));
    let repo = tmp.path().join("repo");
    let store = Arc::new(Store::in_memory().unwrap());
    let base = serve_with(store.clone()).await;
    let s = seed_quest(&store, &repo, &tmp.path().join("wts"), Some("api"));

    // The agent's work is uncommitted, as a real run leaves it.
    let wt = PathBuf::from(s.worktree_path.clone().unwrap());
    std::fs::write(wt.join("quest.txt"), "did the thing\n").unwrap();

    let (status, _) = act(&base, &s.id, "stop").await;
    assert_eq!(status, reqwest::StatusCode::OK);

    let (status, v) = act(&base, &s.id, "accept").await;
    assert_eq!(status, reqwest::StatusCode::OK, "{}", err_text(&v));
    assert_eq!(v["session"]["state"], "accepted");
    assert_eq!(v["merge_sha"].as_str().unwrap().len(), 40);
    assert_eq!(v["test_command"], "make test");
    assert_eq!(v["test_source"], "Makefile");
    assert_eq!(v["test_passed"], true);

    // The work landed in the main checkout with a merge commit.
    assert_eq!(
        std::fs::read_to_string(repo.join("quest.txt")).unwrap(),
        "did the thing\n"
    );
    // Full log, not -2: same-second commits tie in git's order,
    // so the quest commit is not always second.
    let log = git_out(&repo, &["log", "--oneline"]);
    assert!(log.contains(&format!("repo-city/{}", &s.id[..8])), "{log}");
    assert!(log.contains("Repo City: accept quest"), "{log}");

    // The worktree and branch are gone; a second accept refuses.
    assert!(!wt.exists());
    assert!(!git_out(&repo, &["branch", "--list", "repo-city/*"]).contains("repo-city"));
    assert_eq!(act(&base, &s.id, "accept").await.0, reqwest::StatusCode::CONFLICT);

    // Accepted quests still archive (leave the quest log).
    let (status, v) = act(&base, &s.id, "archive").await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(v["state"], "archived");
}

#[tokio::test]
async fn concurrent_accepts_serialize_into_one_merge() {
    // Slow checks hold the merge window open: both accepts land
    // while the first still runs. The session lock must let
    // exactly one through; the loser sees the accepted quest.
    let tmp = temp_repo(Some("sleep 2"));
    let repo = tmp.path().join("repo");
    let store = Arc::new(Store::in_memory().unwrap());
    let base = serve_with(store.clone()).await;
    let s = seed_quest(&store, &repo, &tmp.path().join("wts"), Some("api"));

    let wt = PathBuf::from(s.worktree_path.clone().unwrap());
    std::fs::write(wt.join("quest.txt"), "did the thing\n").unwrap();
    assert_eq!(act(&base, &s.id, "stop").await.0, reqwest::StatusCode::OK);

    let (a, b) = tokio::join!(act(&base, &s.id, "accept"), act(&base, &s.id, "accept"));
    let mut codes = [a.0, b.0];
    codes.sort();
    assert_eq!(codes, [reqwest::StatusCode::OK, reqwest::StatusCode::CONFLICT]);

    let log = git_out(&repo, &["log", "--oneline"]);
    assert_eq!(log.matches("Repo City: accept quest").count(), 1, "{log}");
    let (_, g) = get_session(&base, &s.id).await;
    assert_eq!(g["state"], "accepted");
}

#[tokio::test]
async fn accept_refuses_running_watcher_only_dirty_and_wrong_branch() {
    let tmp = temp_repo(Some("true"));
    let repo = tmp.path().join("repo");
    let repo_str = repo.to_str().unwrap().to_string();
    let store = Arc::new(Store::in_memory().unwrap());
    let base = serve_with(store.clone()).await;

    // A running quest: stop first.
    let s = seed_quest(&store, &repo, &tmp.path().join("wts"), Some("api"));
    let (status, v) = act(&base, &s.id, "accept").await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    assert!(err_text(&v).contains("stop it first"), "{}", err_text(&v));

    // A watcher-only quest has no worktree to merge.
    let w = store
        .create_session_chosen(&repo_str, None, Some("web"), Some("watch"), None, None, None, None)
        .unwrap();
    let (status, _) = act(&base, &w.id, "stop").await;
    assert_eq!(status, reqwest::StatusCode::OK);
    let (status, v) = act(&base, &w.id, "accept").await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    assert!(err_text(&v).contains("no worktree"), "{}", err_text(&v));

    // A dirty main checkout names its files.
    let (status, _) = act(&base, &s.id, "stop").await;
    assert_eq!(status, reqwest::StatusCode::OK);
    std::fs::write(repo.join("scratch.txt"), "mine\n").unwrap();
    let (status, v) = act(&base, &s.id, "accept").await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    assert!(err_text(&v).contains("scratch.txt"), "{}", err_text(&v));
    std::fs::remove_file(repo.join("scratch.txt")).unwrap();

    // A main checkout on another branch names the target.
    let target = worktree::current_branch(&repo).unwrap();
    git(&repo, &["checkout", "-qb", "elsewhere"]);
    let (status, v) = act(&base, &s.id, "accept").await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    assert!(err_text(&v).contains(&format!("switch it to {target}")), "{}", err_text(&v));
    git(&repo, &["checkout", "-q", &target]);

    // Guards green again: the quest accepts.
    let (status, v) = act(&base, &s.id, "accept").await;
    assert_eq!(status, reqwest::StatusCode::OK, "{}", err_text(&v));
}

#[tokio::test]
async fn accept_conflict_aborts_clean_names_files_and_offers_fix_or_discard() {
    let tmp = temp_repo(Some("true"));
    let repo = tmp.path().join("repo");
    let store = Arc::new(Store::in_memory().unwrap());
    let base = serve_with(store.clone()).await;
    let s = seed_quest(&store, &repo, &tmp.path().join("wts"), Some("api"));
    let wt = PathBuf::from(s.worktree_path.clone().unwrap());

    std::fs::write(wt.join("a.txt"), "branch line\n").unwrap();
    std::fs::write(repo.join("a.txt"), "main line\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "main moves on"]);
    let (status, _) = act(&base, &s.id, "stop").await;
    assert_eq!(status, reqwest::StatusCode::OK);

    let (status, v) = act(&base, &s.id, "accept").await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    assert!(err_text(&v).contains("a.txt"), "{}", err_text(&v));
    assert!(err_text(&v).contains("send the quest back"), "{}", err_text(&v));

    // The main checkout is clean again; the quest waits, still stopped.
    assert!(worktree::dirty_files(&repo).unwrap().is_empty());
    assert!(!worktree::merge_in_progress(&repo));
    assert_eq!(store.get_session(&s.id).unwrap().unwrap().state, "stopped");
    assert!(wt.exists());

    // The discard half of the choice works from here.
    let (status, v) = act(&base, &s.id, "discard").await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(v["state"], "discarded");
    assert!(!wt.exists());
}

#[tokio::test]
async fn accept_rolls_the_merge_back_when_checks_fail() {
    let tmp = temp_repo(Some("false"));
    let repo = tmp.path().join("repo");
    let store = Arc::new(Store::in_memory().unwrap());
    let base = serve_with(store.clone()).await;
    let s = seed_quest(&store, &repo, &tmp.path().join("wts"), Some("api"));
    let wt = PathBuf::from(s.worktree_path.clone().unwrap());
    std::fs::write(wt.join("quest.txt"), "did the thing\n").unwrap();
    let (status, _) = act(&base, &s.id, "stop").await;
    assert_eq!(status, reqwest::StatusCode::OK);
    let pre_sha = git_out(&repo, &["rev-parse", "HEAD"]);

    let (status, v) = act(&base, &s.id, "accept").await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT);
    assert!(err_text(&v).contains("rolled back"), "{}", err_text(&v));
    assert!(err_text(&v).contains("make test"), "{}", err_text(&v));

    // Nothing landed; the quest and its work survive for a fix.
    assert_eq!(git_out(&repo, &["rev-parse", "HEAD"]), pre_sha);
    assert!(!repo.join("quest.txt").exists());
    assert_eq!(store.get_session(&s.id).unwrap().unwrap().state, "stopped");
    assert!(wt.join("quest.txt").exists());
}

#[tokio::test]
async fn accept_without_a_test_command_reports_not_run() {
    let tmp = temp_repo(None);
    let repo = tmp.path().join("repo");
    let store = Arc::new(Store::in_memory().unwrap());
    let base = serve_with(store.clone()).await;
    let s = seed_quest(&store, &repo, &tmp.path().join("wts"), Some("api"));
    let (status, _) = act(&base, &s.id, "stop").await;
    assert_eq!(status, reqwest::StatusCode::OK);

    let (status, v) = act(&base, &s.id, "accept").await;
    assert_eq!(status, reqwest::StatusCode::OK, "{}", err_text(&v));
    assert_eq!(v["session"]["state"], "accepted");
    assert!(v["test_passed"].is_null());
    assert!(v["test_output"].as_str().unwrap().contains("not run"));
}

// Regression: ISSUE-QA1 — Accept ran checks but never logged the
// outcome, so a failed check left no test_result and the island
// never flew the failed-test pennant.
// Found by /gstack-qa on 2026-10-29
// Report: /tmp/qa-step5/qa-report-step5.md
#[tokio::test]
async fn accept_records_its_check_outcome_as_a_test_result_event() {
    async fn test_results(base: &str, id: &str) -> Vec<serde_json::Value> {
        let client = reqwest::Client::new();
        let events: Vec<serde_json::Value> = client
            .get(format!("{base}/api/sessions/{id}/events"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        events.into_iter().filter(|e| e["type"] == "test_result").collect()
    }

    // Failing checks log one failed result, on the rolled-back quest.
    let tmp = temp_repo(Some("false"));
    let repo = tmp.path().join("repo");
    let store = Arc::new(Store::in_memory().unwrap());
    let base = serve_with(store.clone()).await;
    let s = seed_quest(&store, &repo, &tmp.path().join("wts"), Some("api"));
    assert_eq!(act(&base, &s.id, "stop").await.0, reqwest::StatusCode::OK);
    assert_eq!(act(&base, &s.id, "accept").await.0, reqwest::StatusCode::CONFLICT);
    let results = test_results(&base, &s.id).await;
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["passed"], false);
    assert!(results[0]["summary"].as_str().unwrap().contains("make test"));

    // Passing checks log one passed result, on the accepted quest.
    let tmp = temp_repo(Some("true"));
    let repo = tmp.path().join("repo");
    let store = Arc::new(Store::in_memory().unwrap());
    let base = serve_with(store.clone()).await;
    let s = seed_quest(&store, &repo, &tmp.path().join("wts"), Some("api"));
    assert_eq!(act(&base, &s.id, "stop").await.0, reqwest::StatusCode::OK);
    assert_eq!(act(&base, &s.id, "accept").await.0, reqwest::StatusCode::OK);
    let results = test_results(&base, &s.id).await;
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["passed"], true);

    // No test command means no result: "not run" is not a failure.
    let tmp = temp_repo(None);
    let repo = tmp.path().join("repo");
    let store = Arc::new(Store::in_memory().unwrap());
    let base = serve_with(store.clone()).await;
    let s = seed_quest(&store, &repo, &tmp.path().join("wts"), Some("api"));
    assert_eq!(act(&base, &s.id, "stop").await.0, reqwest::StatusCode::OK);
    assert_eq!(act(&base, &s.id, "accept").await.0, reqwest::StatusCode::OK);
    assert!(test_results(&base, &s.id).await.is_empty());
}

#[tokio::test]
async fn preview_shows_target_branch_checkout_and_test_command() {
    let tmp = temp_repo(Some("true"));
    let repo = tmp.path().join("repo");
    let store = Arc::new(Store::in_memory().unwrap());
    let base = serve_with(store.clone()).await;
    let s = seed_quest(&store, &repo, &tmp.path().join("wts"), Some("api"));
    let target = worktree::current_branch(&repo).unwrap();
    let (status, _) = act(&base, &s.id, "stop").await;
    assert_eq!(status, reqwest::StatusCode::OK);

    let (status, v) = get_preview(&base, &s.id).await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(v["state_ok"], true);
    assert_eq!(v["worktree_exists"], true);
    assert_eq!(v["base_branch"], target);
    assert_eq!(v["current_branch"], target);
    assert_eq!(v["on_target"], true);
    assert_eq!(v["dirty_files"], serde_json::json!([]));
    assert_eq!(v["merge_in_progress"], false);
    assert_eq!(v["test"]["command"], "make test");
    assert_eq!(v["test"]["source"], "Makefile");

    assert_eq!(get_preview(&base, "no-such-id").await.0, reqwest::StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn keep_leaves_the_worktree_and_releases_the_island() {
    let tmp = temp_repo(Some("true"));
    let repo = tmp.path().join("repo");
    let store = Arc::new(Store::in_memory().unwrap());
    let base = serve_with(store.clone()).await;
    let s = seed_quest(&store, &repo, &tmp.path().join("wts"), Some("api"));
    let wt = PathBuf::from(s.worktree_path.clone().unwrap());
    std::fs::write(wt.join("quest.txt"), "half done\n").unwrap();
    let (status, _) = act(&base, &s.id, "stop").await;
    assert_eq!(status, reqwest::StatusCode::OK);

    // Working quests cannot keep; stopped ones can.
    let w = seed_quest(&store, &repo, &tmp.path().join("wts2"), Some("web"));
    assert_eq!(act(&base, &w.id, "keep").await.0, reqwest::StatusCode::CONFLICT);
    let (status, v) = act(&base, &s.id, "keep").await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(v["state"], "kept");

    // The worktree is untouched, and the island takes a new quest.
    assert_eq!(std::fs::read_to_string(wt.join("quest.txt")).unwrap(), "half done\n");
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{base}/api/sessions"))
        .json(&serde_json::json!({"repo_path": repo.to_str().unwrap(), "island_id": "api", "task": "next"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::CREATED);
}

#[tokio::test]
async fn discard_removes_worktree_and_branch_from_any_live_state() {
    let tmp = temp_repo(Some("true"));
    let repo = tmp.path().join("repo");
    let store = Arc::new(Store::in_memory().unwrap());
    let base = serve_with(store.clone()).await;

    // From a running quest (stopped first by the route).
    let s = seed_quest(&store, &repo, &tmp.path().join("wts"), Some("api"));
    let wt = PathBuf::from(s.worktree_path.clone().unwrap());
    let (status, v) = act(&base, &s.id, "discard").await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(v["state"], "discarded");
    assert!(!wt.exists());
    assert!(!git_out(&repo, &["branch", "--list", "repo-city/*"]).contains("repo-city"));
    assert_eq!(act(&base, &s.id, "discard").await.0, reqwest::StatusCode::CONFLICT);

    // From an archived quest (leftover worktree goes away too).
    let t = seed_quest(&store, &repo, &tmp.path().join("wts2"), Some("web"));
    let wt2 = PathBuf::from(t.worktree_path.clone().unwrap());
    assert_eq!(act(&base, &t.id, "stop").await.0, reqwest::StatusCode::OK);
    assert_eq!(act(&base, &t.id, "archive").await.0, reqwest::StatusCode::OK);
    assert!(wt2.exists());
    let (status, v) = act(&base, &t.id, "discard").await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(v["state"], "discarded");
    assert!(!wt2.exists());
}

#[tokio::test]
async fn discard_prunes_branch_when_dir_is_already_gone() {
    let tmp = temp_repo(Some("true"));
    let repo = tmp.path().join("repo");
    let store = Arc::new(Store::in_memory().unwrap());
    let base = serve_with(store.clone()).await;

    let s = seed_quest(&store, &repo, &tmp.path().join("wts"), Some("api"));
    let wt = PathBuf::from(s.worktree_path.clone().unwrap());
    // The dir vanishes outside the API (user rm, crash): the
    // stale worktree entry and the session branch remain.
    std::fs::remove_dir_all(&wt).unwrap();
    assert!(git_out(&repo, &["branch", "--list", "repo-city/*"]).contains("repo-city"));

    let (status, v) = act(&base, &s.id, "discard").await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(v["state"], "discarded");
    assert!(!git_out(&repo, &["branch", "--list", "repo-city/*"]).contains("repo-city"));
    assert!(!git_out(&repo, &["worktree", "list"]).contains(&s.id));
}

#[tokio::test]
async fn discard_failure_still_discards_and_says_so() {
    let tmp = temp_repo(Some("true"));
    let repo = tmp.path().join("repo");
    let store = Arc::new(Store::in_memory().unwrap());
    let base = serve_with(store.clone()).await;

    let s = seed_quest(&store, &repo, &tmp.path().join("wts"), Some("api"));
    // Point the worktree path at a plain file: removal fails,
    // but the state move already committed the discard.
    let blocker = tmp.path().join("blocker");
    std::fs::write(&blocker, "not a worktree\n").unwrap();
    store.set_worktree_path(&s.id, blocker.to_str().unwrap()).unwrap();

    let (status, v) = act(&base, &s.id, "discard").await;
    assert_eq!(status, reqwest::StatusCode::INTERNAL_SERVER_ERROR);
    assert!(err_text(&v).contains("is discarded"), "{}", err_text(&v));
    let (gstatus, g) = get_session(&base, &s.id).await;
    assert_eq!(gstatus, reqwest::StatusCode::OK);
    assert_eq!(g["state"], "discarded");
}
