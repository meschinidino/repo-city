// Normalized event contract, client side. Mirrors the Rust enum in
// server/src/events (design D4, frozen): the server translates both
// CLIs and the watcher into these shapes; the client never sees raw
// CLI output.

export type Source = "cli" | "watcher" | "system";
export type ChangeKind = "created" | "modified" | "deleted";
export type Outcome = "completed" | "failed" | "stopped";

export type EventPayload =
  | { type: "session_started"; cli_session_id?: string }
  | { type: "file_touched"; path: string; change: ChangeKind }
  | { type: "command_run"; command: string; exit_code?: number }
  | { type: "test_result"; passed: boolean; summary: string }
  | { type: "agent_message"; text: string }
  | { type: "agent_reasoning"; text: string }
  | { type: "session_paused" }
  | { type: "session_finished"; outcome: Outcome; reason?: string };

export type StoredEvent = EventPayload & {
  id: number;
  session_id: string;
  seq: number;
  ts_ms: number;
  source: Source;
};
