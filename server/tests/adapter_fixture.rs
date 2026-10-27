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
