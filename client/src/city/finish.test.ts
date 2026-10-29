import { describe, expect, it } from "vitest";
import { cleanupWarningLine, escHtml, isFinishable, lastFinishNote, lastTestResult, stallMins, stallText, testLine } from "./finish";
import type { StoredEvent } from "../events/types";

const NOW = 1_000_000_000_000;

function quest(state: string, last_event_ms: number | null = NOW - 60_000) {
  return { id: "q", state, last_event_ms };
}

function msg(seq: number, text: string, ts = NOW): StoredEvent {
  return { type: "agent_message", text, id: seq, session_id: "q", seq, ts_ms: ts, source: "system" };
}

function testRes(seq: number, passed: boolean, summary: string): StoredEvent {
  return { type: "test_result", passed, summary, id: seq, session_id: "q", seq, ts_ms: NOW, source: "cli" };
}

describe("isFinishable", () => {
  it("accepts stopped, finished, failed, kept only", () => {
    for (const s of ["stopped", "finished", "failed", "kept"]) expect(isFinishable(s)).toBe(true);
    for (const s of ["working", "paused", "accepted", "discarded", "archived", "nope"]) expect(isFinishable(s)).toBe(false);
  });
});

describe("stall", () => {
  it("stays quiet before three minutes of silence", () => {
    expect(stallMins(quest("working", NOW - 179_999), NOW)).toBeNull();
    expect(stallText(quest("working", NOW - 179_999), NOW)).toBeNull();
  });

  it("names minutes of silence past the threshold", () => {
    expect(stallMins(quest("working", NOW - 240_000), NOW)).toBe(4);
    expect(stallText(quest("working", NOW - 240_000), NOW)).toBe("no news for 4 min");
  });

  it("never stalls a quest that is not working, or one with no events", () => {
    expect(stallMins(quest("paused", NOW - 999_999_999), NOW)).toBeNull();
    expect(stallMins(quest("finished", NOW - 999_999_999), NOW)).toBeNull();
    expect(stallMins(quest("working", null), NOW)).toBeNull();
  });

  it("ignores clock skew from the future", () => {
    expect(stallMins(quest("working", NOW + 60_000), NOW)).toBeNull();
  });
});

describe("card lines", () => {
  it("reads the latest test result in log order", () => {
    const events = [testRes(1, true, "3 passed"), testRes(2, false, "1 failed")];
    expect(lastTestResult(events)).toEqual({ passed: false, summary: "1 failed" });
    expect(lastTestResult([])).toBeNull();
    expect(lastTestResult([msg(1, "hi")])).toBeNull();
  });

  it("words test results plainly", () => {
    expect(testLine({ passed: true, summary: "3 passed" })).toBe("Last checks: passed — 3 passed");
    expect(testLine({ passed: false, summary: "1 failed" })).toBe("Last checks: failed — 1 failed");
  });

  it("finds the server's finish note, newest first", () => {
    const events = [
      msg(1, "Quest kept for later: the worktree stays untouched."),
      msg(2, "Session archived."),
      msg(3, "Quest accepted: merged repo-city/abcd into main (1234abcd). checks passed (make test)."),
    ];
    expect(lastFinishNote(events)).toBe(
      "Quest accepted: merged repo-city/abcd into main (1234abcd). checks passed (make test).",
    );
    expect(lastFinishNote([msg(1, "Session paused.")])).toBeNull();
  });

  it("escapes HTML in server text", () => {
    expect(escHtml("<b>&\"")).toBe("&lt;b&gt;&amp;&quot;");
  });

  it("words the accept cleanup warning, or nothing when clean", () => {
    expect(cleanupWarningLine("the worktree cleanup failed (x)")).toBe("Warning: the worktree cleanup failed (x)");
    expect(cleanupWarningLine(null)).toBeNull();
    expect(cleanupWarningLine(undefined)).toBeNull();
    expect(cleanupWarningLine("")).toBeNull();
  });
});
