//! Adapter tests run on SIMULATED recorded CLI fixtures (see
//! tests/fixtures/cli/README.md). They prove translation only, never
//! live-agent behavior.

use repo_city_server::adapters::claude::translate_stream;
use repo_city_server::events::{ChangeKind, EventPayload, Outcome};

const SIMULATED_CLAUDE_STREAM: &str = include_str!("fixtures/cli/claude-session.jsonl");

#[test]
fn simulated_claude_stream_translates_to_normalized_events() {
    let (events, cli_session_id, stats) = translate_stream(SIMULATED_CLAUDE_STREAM);
    assert_eq!(cli_session_id.as_deref(), Some("sim-session-0001"));
    assert!(matches!(events[0], EventPayload::SessionStarted { .. }));
    assert!(matches!(&events[1], EventPayload::AgentMessage { text } if text.contains("greeting")));
    assert!(matches!(
        &events[2],
        EventPayload::FileTouched { path, change: ChangeKind::Modified } if path.ends_with("greet.ts")
    ));
    assert!(
        matches!(&events[3], EventPayload::CommandRun { command, .. } if command == "npm test")
    );
    assert!(matches!(
        events.last().unwrap(),
        EventPayload::SessionFinished {
            outcome: Outcome::Completed,
            ..
        }
    ));
    // Read tool_use and the user tool_result are counted, not passed raw.
    assert_eq!(stats.unmapped, 2);
    assert_eq!(stats.mapped, 5);
}

#[test]
fn simulated_failed_result_maps_to_failed_outcome() {
    let stream = "{\"type\":\"result\",\"subtype\":\"error\",\"is_error\":true,\"result\":\"boom\",\"session_id\":\"s1\"}\n";
    let (events, _, stats) = translate_stream(stream);
    assert_eq!(stats.mapped, 1);
    assert!(matches!(
        &events[0],
        EventPayload::SessionFinished { outcome: Outcome::Failed, reason: Some(r) } if r == "boom"
    ));
}

#[test]
fn simulated_garbage_lines_are_counted_never_forwarded() {
    let (events, _, stats) = translate_stream("not json\n{\"no_type\":true}\n");
    assert!(events.is_empty());
    assert_eq!(stats.unmapped, 2);
}

use repo_city_server::adapters::muse::translate_stream as translate_muse_stream;

const RECORDED_MUSE_STREAM: &str = include_str!("fixtures/cli/muse-exec-real.jsonl");

#[test]
fn recorded_muse_stream_translates_to_normalized_events() {
    let (events, cli_session_id, stats) = translate_muse_stream(RECORDED_MUSE_STREAM);
    assert_eq!(cli_session_id.as_deref(), Some("11111111-2222-4333-8444-555555555555"));
    assert!(matches!(events[0], EventPayload::SessionStarted { .. }));
    assert!(matches!(
        &events[1],
        EventPayload::FileTouched { path, change: ChangeKind::Created } if path == "hello.txt"
    ));
    assert!(matches!(
        &events[2],
        EventPayload::AgentMessage { text } if text.contains("banana")
    ));
    assert!(matches!(
        events.last().unwrap(),
        EventPayload::SessionFinished { outcome: Outcome::Completed, .. }
    ));
    // The four output deltas are fragments: counted, never forwarded.
    assert_eq!(stats.unmapped, 4);
    assert_eq!(stats.mapped, 4);
    assert_eq!(events.len(), 4);
}

#[test]
fn recorded_muse_failed_terminal_maps_to_failed_outcome() {
    let stream = "{\"payload_type\":\"run.terminal.failed\",\"stream\":{\"kind\":\"session\",\"id\":\"s9\"},\"payload\":{\"kind\":\"run_terminal\",\"terminal\":\"failed\",\"text\":\"model refused\",\"reason\":null}}\n";
    let (events, id, _) = translate_muse_stream(stream);
    assert_eq!(id.as_deref(), Some("s9"));
    assert!(matches!(
        events.last().unwrap(),
        EventPayload::SessionFinished { outcome: Outcome::Failed, reason: Some(r) } if r == "model refused"
    ));
}

#[test]
fn muse_session_id_comes_only_from_the_session_stream() {
    // A run-stream line must never overwrite the session id.
    let stream = concat!(
        "{\"payload_type\":\"session.run.linked\",\"stream\":{\"kind\":\"run\",\"id\":\"run-1\"},\"payload\":{}}\n",
        "{\"payload_type\":\"run.lifecycle.started\",\"stream\":{\"kind\":\"session\",\"id\":\"sess-1\"},\"payload\":{}}\n",
    );
    let (_, id, _) = translate_muse_stream(stream);
    assert_eq!(id.as_deref(), Some("sess-1"));
}

#[test]
fn muse_any_terminal_kind_maps_by_its_terminal_word() {
    let stream = "{\"payload_type\":\"run.terminal.interrupted\",\"stream\":{\"kind\":\"session\",\"id\":\"s1\"},\"payload\":{\"kind\":\"run_terminal\",\"terminal\":\"cancelled\",\"text\":\"\",\"reason\":\"user stop\"}}\n";
    let (events, _, _) = translate_muse_stream(stream);
    assert!(matches!(
        events.last().unwrap(),
        EventPayload::SessionFinished { outcome: Outcome::Stopped, reason: Some(r) } if r == "user stop"
    ));
}
