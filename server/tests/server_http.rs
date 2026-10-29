//! Live-loop integration test: real HTTP server, real filesystem
//! edits, real WebSocket. Nothing here is simulated except that no
//! agent CLI is spawned (spawn=false); file edits are made by the
//! test itself, exactly like a shell-only edit the watcher must catch
//! (T4 verify: edits via shell commands only, buildings still light).

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
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

#[tokio::test]
async fn watcher_events_flow_over_http_and_websocket() {
    let base = serve().await;
    let dir = tempfile::tempdir().unwrap();
    let client = reqwest::Client::new();

    let health: serde_json::Value = client
        .get(format!("{base}/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health["ok"], true);

    // Extraction endpoint against the committed stand-in fixture.
    let fixture = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/sample-monorepo"
    );
    let extraction: serde_json::Value = client
        .get(format!("{base}/api/extraction"))
        .query(&[("path", fixture)])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(extraction["counts"]["files_parsed"], 12);

    // Browser boundary: a cross-site Origin cannot mutate, and the
    // dev origin without the client header (a form POST) cannot
    // either. Headerless local clients still can.
    let csrf = client
        .post(format!("{base}/api/sessions"))
        .header("origin", "https://evil.example")
        .json(&serde_json::json!({"repo_path": dir.path().to_string_lossy()}))
        .send()
        .await
        .unwrap();
    assert_eq!(csrf.status(), reqwest::StatusCode::FORBIDDEN);
    let form_post = client
        .post(format!("{base}/api/sessions"))
        .header("origin", "http://localhost:5173")
        .json(&serde_json::json!({"repo_path": dir.path().to_string_lossy()}))
        .send()
        .await
        .unwrap();
    assert_eq!(form_post.status(), reqwest::StatusCode::FORBIDDEN);

    let session: serde_json::Value = client
        .post(format!("{base}/api/sessions"))
        .json(
            &serde_json::json!({"repo_path": dir.path().to_string_lossy(), "task": "touch a file"}),
        )
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let session_id = session["id"].as_str().unwrap().to_string();
    assert_eq!(session["state"], "working");

    // Shell-style edit: no CLI event names this file.
    std::fs::write(dir.path().join("edited.ts"), "export const x = 1;\n").unwrap();

    // The watcher must surface it in the session event log.
    let mut saw_touch = false;
    for _ in 0..40 {
        let events: serde_json::Value = client
            .get(format!("{base}/api/sessions/{session_id}/events"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if events
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["type"] == "file_touched" && e["path"] == "edited.ts")
        {
            saw_touch = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(saw_touch, "watcher never reported the shell-only edit");

    // A browser page from another origin cannot read the stream.
    let bad_ws = format!("{}/ws?since_id=0", base.replace("http://", "ws://"));
    let bad_req = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
        bad_ws.as_str(),
    )
    .map(|mut r| {
        r.headers_mut().insert(
            "origin",
            tokio_tungstenite::tungstenite::http::HeaderValue::from_static("https://evil.example"),
        );
        r
    })
    .unwrap();
    assert!(tokio_tungstenite::connect_async(bad_req).await.is_err());

    // WebSocket replay from the start of the log includes both events.
    let ws_url = format!("{}/ws?since_id=0", base.replace("http://", "ws://"));
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await.unwrap();
    let mut types: Vec<String> = Vec::new();
    while types.len() < 2 {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("ws replay timed out")
            .expect("ws closed")
            .unwrap();
        let event: serde_json::Value = serde_json::from_str(msg.to_text().unwrap()).unwrap();
        types.push(event["type"].as_str().unwrap().to_string());
        if event["type"] == "file_touched" {
            break;
        }
    }
    assert_eq!(types[0], "session_started");
    assert!(types.contains(&"file_touched".to_string()));

    // Report on a non-git directory: unavailable, with raw events.
    let report: serde_json::Value = client
        .get(format!("{base}/api/sessions/{session_id}/report"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(report["available"], false);
    assert_eq!(report["generated_by"], "template_from_diff");
    assert!(report["events"].as_array().is_some_and(|e| !e.is_empty()));

    // Stop on an unknown session is a 404, not an orphan event.
    let missing = client
        .post(format!("{base}/api/sessions/no-such-session/stop"))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), reqwest::StatusCode::NOT_FOUND);

    // Stop ends the session with a stopped outcome.
    let stopped: serde_json::Value = client
        .post(format!("{base}/api/sessions/{session_id}/stop"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(stopped["type"], "session_finished");
    assert_eq!(stopped["outcome"], "stopped");
}

#[tokio::test]
async fn drag_create_stores_source_and_refuses_self_and_islandless() {
    let base = serve().await;
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().to_string_lossy().to_string();
    let client = reqwest::Client::new();
    async fn create(
        client: &reqwest::Client,
        base: &str,
        body: serde_json::Value,
    ) -> (reqwest::StatusCode, serde_json::Value) {
        let resp = client.post(format!("{base}/api/sessions")).json(&body).send().await.unwrap();
        let status = resp.status();
        let json: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
        (status, json)
    }

    // A drag-connect quest records its source island.
    let (status, v) = create(
        &client,
        &base,
        serde_json::json!({
            "repo_path": repo, "island_id": "web", "task": "connect web to api",
            "spawn": false, "source_island_id": "api",
        }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::CREATED);
    assert_eq!(v["source_island_id"], "api");
    let id = v["id"].as_str().unwrap().to_string();
    let got: serde_json::Value = client
        .get(format!("{base}/api/sessions/{id}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(got["source_island_id"], "api");

    // Same-island and island-less sources refuse in words.
    let (status, v) = create(
        &client,
        &base,
        serde_json::json!({"repo_path": repo, "island_id": "web", "source_island_id": "web"}),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::BAD_REQUEST);
    assert!(v["error"].as_str().unwrap_or("").contains("itself"), "{v}");
    let (status, v) = create(&client, &base, serde_json::json!({"repo_path": repo, "source_island_id": "api"})).await;
    assert_eq!(status, reqwest::StatusCode::BAD_REQUEST);
    assert!(v["error"].as_str().unwrap_or("").contains("target island"), "{v}");
}
