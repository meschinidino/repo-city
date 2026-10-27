import { describe, it, expect } from "vitest";
import { applyEvent, applyEvents, initialView } from "./reduce";
import type { StoredEvent } from "./types";

// SIMULATED events, hand-written in the frozen contract shape. They
// prove reduction logic only, never live-agent behavior (R17/L2).

const FILES = new Map([
  ["src/greet.ts", "api"],
  ["src/users.ts", "api"],
  ["web/app.tsx", "web"],
]);

function ev(partial: Partial<StoredEvent> & { type: StoredEvent["type"] }): StoredEvent {
  return {
    id: partial.seq ?? 1,
    session_id: "s1",
    seq: 1,
    ts_ms: 0,
    source: "watcher",
    ...partial,
  } as StoredEvent;
}

describe("event reduction (simulated events)", () => {
  it("ship sails on session start and docks on a mapped file touch", () => {
    let v = initialView("s1", "api");
    v = applyEvent(v, ev({ type: "session_started", seq: 1, source: "cli", cli_session_id: "cli-9" }), FILES);
    expect(v.state).toBe("working");
    expect(v.cliSessionId).toBe("cli-9");
    v = applyEvent(v, ev({ type: "file_touched", seq: 2, path: "web/app.tsx", change: "modified" }), FILES);
    expect(v.shipIsland).toBe("web");
    expect(v.shipFile).toBe("web/app.tsx");
    expect(v.locationUnknown).toBe(false);
    expect(v.litFiles).toEqual(["web/app.tsx"]);
  });

  it("CLI touches are intent only: no ship move, no lit building (D8)", () => {
    let v = initialView("s1", "api");
    v = applyEvent(v, ev({ type: "session_started", seq: 1, source: "cli", cli_session_id: "c1" }), FILES);
    v = applyEvent(v, ev({ type: "file_touched", seq: 2, source: "cli", path: "web/app.tsx", change: "modified" }), FILES);
    expect(v.shipIsland).toBe("api");
    expect(v.shipFile).toBeNull();
    expect(v.litFiles).toEqual([]);
    expect(v.intentFiles).toEqual(["web/app.tsx"]);
    // The watcher confirming the same file is what lights it.
    v = applyEvent(v, ev({ type: "file_touched", seq: 3, source: "watcher", path: "web/app.tsx", change: "modified" }), FILES);
    expect(v.shipFile).toBe("web/app.tsx");
    expect(v.litFiles).toEqual(["web/app.tsx"]);
    // A watcher delete unlights it.
    v = applyEvent(v, ev({ type: "file_touched", seq: 4, source: "watcher", path: "web/app.tsx", change: "deleted" }), FILES);
    expect(v.litFiles).toEqual([]);
  });

  it("unmappable touch keeps the ship at the gate, location unknown", () => {
    let v = initialView("s1", "api");
    v = applyEvent(v, ev({ type: "session_started", seq: 1, source: "system" }), FILES);
    v = applyEvent(v, ev({ type: "file_touched", seq: 2, path: "outside/repo.txt", change: "modified" }), FILES);
    expect(v.shipIsland).toBe("api");
    expect(v.shipFile).toBeNull();
    expect(v.locationUnknown).toBe(true);
  });

  it("replay duplicates at or below lastSeq change nothing", () => {
    let v = initialView("s1", "api");
    const start = ev({ type: "session_started", seq: 3, source: "system" });
    v = applyEvent(v, start, FILES);
    const again = applyEvent(v, start, FILES);
    expect(again).toBe(v);
    const other = applyEvent(v, ev({ type: "session_started", seq: 4, session_id: "s2", source: "system" }), FILES);
    expect(other).toBe(v);
  });

  it("test pennants and finish outcomes land on the view", () => {
    let v = initialView("s1", "api");
    v = applyEvents(v, [
      ev({ type: "session_started", seq: 1, source: "system" }),
      ev({ type: "test_result", seq: 2, source: "cli", passed: false, summary: "1 failed" }),
      ev({ type: "agent_message", seq: 3, source: "cli", text: "fixing" }),
      ev({ type: "session_finished", seq: 4, source: "cli", outcome: "failed", reason: "boom" }),
    ], FILES);
    expect(v.testPassed).toBe(false);
    expect(v.messages).toEqual(["fixing"]);
    expect(v.state).toBe("failed");
    expect(v.lastSeq).toBe(4);
  });
});
