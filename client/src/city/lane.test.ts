// Drag-connect logic: task text, drop validation, cycle paths,
// dash geometry. Pure functions behind the lane interaction.

import { describe, expect, it } from "vitest";
import { bornBridges, dashSegments, dragTaskText, findPath, hasEdge, pendingLanes, validateDrop } from "./lane";
import type { SessionInfo } from "./live";

const s = (island: string | null, state: string): SessionInfo =>
  ({ id: "s", repo_path: "/r", worktree_path: null, island_id: island, source_island_id: null, task: "t", state, base_branch: null, last_event_ms: null, cli_session_id: null, model: null, effort: null, agent: null, pending_task: null, created_ms: 0, updated_ms: 0 });

const sd = (island: string, source: string, state: string): SessionInfo =>
  ({ ...s(island, state), source_island_id: source });

describe("pendingLanes", () => {
  const edges = [{ from: "a", to: "b" }];
  it("keeps an open drag quest without the import", () => {
    expect(pendingLanes([sd("a", "c", "working")], edges)).toEqual([
      { source: "c", target: "a" },
    ]);
  });
  it("drops a satisfied quest (import island->source exists)", () => {
    expect(pendingLanes([sd("a", "b", "working")], edges)).toEqual([]);
  });
  it("drops terminal quests", () => {
    const sessions = ["accepted", "discarded", "archived"].map((state) =>
      sd("a", "c", state),
    );
    expect(pendingLanes(sessions, edges)).toEqual([]);
  });
  it("skips quests without a drag source", () => {
    expect(pendingLanes([s("a", "working")], edges)).toEqual([]);
  });
});

describe("bornBridges", () => {
  const edges = [{ from: "a", to: "b" }];
  it("borns an accepted drag quest whose import exists", () => {
    expect(bornBridges([sd("a", "b", "accepted")], edges)).toEqual(
      new Set(["a|b"]),
    );
  });
  it("draws nothing when the import is missing", () => {
    expect(bornBridges([sd("a", "c", "accepted")], edges)).toEqual(new Set());
  });
  it("ignores non-accepted quests even with the import", () => {
    expect(bornBridges([sd("a", "b", "working")], edges)).toEqual(new Set());
  });
});

const names = new Map([["a", "auth"], ["b", "sales"], ["c", "checkout"]]);
const nameOf = (id: string) => names.get(id) ?? id;

describe("dragTaskText", () => {
  it("words the drag as B using A", () => {
    expect(dragTaskText("auth", "sales")).toBe("Connect sales to auth so sales can use auth");
  });
});

describe("validateDrop", () => {
  const edges = [{ from: "b", to: "c" }];
  it("refuses a drag onto its own island", () => {
    expect(validateDrop("a", "a", [], [], nameOf)).toEqual({
      ok: false,
      reason: "That drag starts and ends on auth.",
    });
  });
  it("refuses a connection that already exists", () => {
    // b already imports c: dragging c -> b wants b -> c again.
    expect(validateDrop("c", "b", edges, [], nameOf)).toEqual({
      ok: false,
      reason: "sales already uses checkout.",
    });
  });
  it("refuses a target with a running quest", () => {
    expect(validateDrop("a", "b", [], [s("b", "working")], nameOf)).toEqual({
      ok: false,
      reason: "sales already has a working quest.",
    });
    expect(validateDrop("a", "b", [], [s("b", "paused")], nameOf).ok).toBe(false);
    expect(validateDrop("a", "b", [], [s("b", "stopped")], nameOf)).toEqual({ ok: true });
  });
  it("refuses an import cycle and names the loop", () => {
    // b imports c already: dragging b -> c wants c -> b, a cycle.
    expect(validateDrop("b", "c", edges, [], nameOf)).toEqual({
      ok: false,
      reason: "That would close an import cycle: sales → checkout → sales.",
    });
  });
  it("accepts a fresh connection", () => {
    expect(validateDrop("a", "b", edges, [], nameOf)).toEqual({ ok: true });
  });
});

describe("findPath", () => {
  it("finds the shortest path or null", () => {
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "a", to: "c" },
    ];
    expect(findPath(edges, "a", "c")).toEqual(["a", "c"]);
    expect(findPath(edges, "c", "a")).toBeNull();
    expect(findPath(edges, "a", "a")).toEqual(["a"]);
  });
  it("hasEdge matches exact direction only", () => {
    expect(hasEdge([{ from: "a", to: "b" }], "a", "b")).toBe(true);
    expect(hasEdge([{ from: "a", to: "b" }], "b", "a")).toBe(false);
  });
});

describe("dashSegments", () => {
  it("dashes a straight line", () => {
    const segs = dashSegments([{ x: 0, y: 0 }, { x: 100, y: 0 }], 10, 10, 0);
    expect(segs.length).toBe(5);
    expect(segs[0]).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
    expect(segs[1]).toEqual([{ x: 20, y: 0 }, { x: 30, y: 0 }]);
  });
  it("phase slides the pattern forward", () => {
    const segs = dashSegments([{ x: 0, y: 0 }, { x: 100, y: 0 }], 10, 10, 5);
    expect(segs[0]).toEqual([{ x: 0, y: 0 }, { x: 5, y: 0 }]);
    expect(segs[1]).toEqual([{ x: 15, y: 0 }, { x: 25, y: 0 }]);
  });
  it("follows bent polylines and survives degenerate input", () => {
    const bent = dashSegments([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 6, 4, 0);
    expect(bent.length).toBe(2);
    expect(bent[0][1]).toEqual({ x: 6, y: 0 });
    expect(bent[1][0]).toEqual({ x: 10, y: 0 });
    expect(bent[1][1]).toEqual({ x: 10, y: 6 });
    expect(dashSegments([{ x: 0, y: 0 }], 6, 4, 0)).toEqual([]);
    expect(dashSegments([{ x: 1, y: 1 }, { x: 1, y: 1 }], 6, 4, 0)).toEqual([]);
    expect(dashSegments([{ x: 0, y: 0 }, { x: 10, y: 0 }], 0, 4, 0)).toEqual([]);
  });
});
