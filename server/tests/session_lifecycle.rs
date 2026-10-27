//! T5 lifecycle over real HTTP: pause, resume, stop, archive,
//! follow-up guards, and the island lock. No agent CLI is spawned
//! (spawn=false); state moves and locks are the server contract
//! the command bar will show, so they are tested here, not mocked.

use std::sync::Arc;
use std::time::Duration;

use repo_city_server::app::build_app_with;
use repo_city_server::store::Store;

async fn serve() -> String {
    let store = Arc::new(Store::in_memory().unwrap());
    let app = build_app_with(store, Duration::from_millis(50));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

async fn create(base: &str, repo: &str, island: Option<&str>) -> (reqwest::StatusCode, serde_json::Value) {
    let client = reqwest::Client::new();
    let mut body = serde_json::json!({"repo_path": repo, "task": "do work"});
    if let Some(island) = island {
        body["island_id"] = serde_json::json!(island);
    }
    let resp = client
        .post(format!("{base}/api/sessions"))
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = resp.status();
    (status, resp.json().await.unwrap_or(serde_json::Value::Null))
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

#[tokio::test]
async fn lifecycle_moves_and_bad_moves_over_http() {
    let base = serve().await;
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().to_string_lossy().to_string();

    let (status, s) = create(&base, &repo, None).await;
    assert_eq!(status, reqwest::StatusCode::CREATED);
    let id = s["id"].as_str().unwrap().to_string();
    assert_eq!(s["state"], "working");

    // working -> paused, then paused cannot pause or archive.
    let (status, s) = act(&base, &id, "pause").await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(s["state"], "paused");
    assert_eq!(act(&base, &id, "pause").await.0, reqwest::StatusCode::CONFLICT);
    assert_eq!(act(&base, &id, "archive").await.0, reqwest::StatusCode::CONFLICT);

    // paused -> working (resume), then working cannot resume.
    let (status, s) = act(&base, &id, "resume").await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(s["state"], "working");
    assert_eq!(act(&base, &id, "resume").await.0, reqwest::StatusCode::CONFLICT);

    // working -> stopped, then stop and resume both fail.
    let (status, _) = act(&base, &id, "stop").await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(act(&base, &id, "stop").await.0, reqwest::StatusCode::CONFLICT);
    assert_eq!(act(&base, &id, "resume").await.0, reqwest::StatusCode::CONFLICT);

    // stopped -> archived, then nothing moves an archived session.
    let (status, s) = act(&base, &id, "archive").await;
    assert_eq!(status, reqwest::StatusCode::OK);
    assert_eq!(s["state"], "archived");
    assert_eq!(act(&base, &id, "pause").await.0, reqwest::StatusCode::CONFLICT);
    assert_eq!(act(&base, "no-such-id", "pause").await.0, reqwest::StatusCode::NOT_FOUND);

    // Follow-up needs a CLI session id: this watcher-only session
    // has none, so the server says so instead of faking a resume.
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{base}/api/sessions/{id}/follow-up"))
        .json(&serde_json::json!({"task": "more"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), reqwest::StatusCode::CONFLICT);
}

#[tokio::test]
async fn island_lock_blocks_a_second_working_quest_until_release() {
    let base = serve().await;
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().to_string_lossy().to_string();

    let (status, a) = create(&base, &repo, Some("api")).await;
    assert_eq!(status, reqwest::StatusCode::CREATED);
    let a_id = a["id"].as_str().unwrap().to_string();

    // Same island, same repo: blocked. Other island: allowed.
    assert_eq!(create(&base, &repo, Some("api")).await.0, reqwest::StatusCode::CONFLICT);
    assert_eq!(create(&base, &repo, Some("web")).await.0, reqwest::StatusCode::CREATED);

    // Paused still holds the lock; stopped releases it.
    assert_eq!(act(&base, &a_id, "pause").await.0, reqwest::StatusCode::OK);
    assert_eq!(create(&base, &repo, Some("api")).await.0, reqwest::StatusCode::CONFLICT);
    assert_eq!(act(&base, &a_id, "stop").await.0, reqwest::StatusCode::OK);
    assert_eq!(create(&base, &repo, Some("api")).await.0, reqwest::StatusCode::CREATED);
}
