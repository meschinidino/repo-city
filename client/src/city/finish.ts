// Finish-flow helpers (T6): pure functions behind the report
// card's Accept/Discard/Keep section and the stalled marker. All
// decisions stay server-side; these only shape what the server
// said into plain words.

import type { StoredEvent } from "../events/types";

export interface StallInfo {
  id: string;
  state: string;
  last_event_ms: number | null;
}

/** States the report card may finish from (server enforces). */
const FINISHABLE = new Set(["stopped", "finished", "failed", "kept"]);

export function isFinishable(state: string): boolean {
  return FINISHABLE.has(state);
}

/** Silence after which a working quest reads stalled (3 minutes). */
export const STALL_AFTER_MS = 3 * 60 * 1000;

/** Whole minutes of silence, or null when not stalled. Only a
 * working quest with a known last event can stall; anything
 * else returns null instead of inventing a stall. */
export function stallMins(s: StallInfo, nowMs: number): number | null {
  if (s.state !== "working" || s.last_event_ms === null) return null;
  const age = nowMs - s.last_event_ms;
  if (age < STALL_AFTER_MS) return null;
  return Math.floor(age / 60000);
}

/** "no news for 4 min", or null when not stalled. */
export function stallText(s: StallInfo, nowMs: number): string | null {
  const mins = stallMins(s, nowMs);
  if (mins === null) return null;
  return `no news for ${mins} min`;
}

/** The latest test result in the log, in log order. */
export function lastTestResult(events: readonly StoredEvent[]): { passed: boolean; summary: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "test_result") return { passed: e.passed, summary: e.summary };
  }
  return null;
}

/** Plain line for the latest test result. */
export function testLine(tr: { passed: boolean; summary: string }): string {
  return `Last checks: ${tr.passed ? "passed" : "failed"} — ${tr.summary}`;
}

/** The server's own finish note ("Quest accepted: ..."), if the
 * log holds one. The card shows it on terminal quests. */
export function lastFinishNote(events: readonly StoredEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      e.type === "agent_message" &&
      (e.text.startsWith("Quest accepted") || e.text.startsWith("Quest discarded") || e.text.startsWith("Quest kept"))
    ) {
      return e.text;
    }
  }
  return null;
}

/** Escape server text for innerHTML templates. */
export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
