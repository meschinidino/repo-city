// Harbor bar helpers: the cap and the plain-word states are the
// owner's decisions (D-cap), so they carry unit tests.

import { describe, expect, it } from "vitest";
import { actionsFor, capState, stateText } from "./bar";
import type { SessionInfo } from "./live";

const s = (state: string, task = "t", worktree: string | null = "/wt"): SessionInfo =>
  ({ id: Math.random().toString(36).slice(2), repo_path: "/r", worktree_path: worktree, island_id: null, task, state, cli_session_id: null, model: null, effort: null, created_ms: 0, updated_ms: 0 });

describe("capState (server rule: 3 spawned working quests)", () => {
  it("caps at three working quests with worktrees and names them", () => {
    const cap = capState([s("working", "a"), s("working", "b"), s("working", "c"), s("finished", "d")]);
    expect(cap.capped).toBe(true);
    expect(cap.active.map((x) => x.task)).toEqual(["a", "b", "c"]);
  });
  it("paused and watcher-only quests do not count", () => {
    expect(capState([s("working"), s("paused"), s("working", "w", null)]).capped).toBe(false);
  });
});

describe("stateText and actionsFor", () => {
  it("states read in plain words", () => {
    expect(stateText("finished")).toBe("finished");
    expect(stateText("failed")).toBe("crashed");
    expect(stateText("working")).toBe("working");
  });
  it("actions follow the state", () => {
    expect(actionsFor(s("working"))).toContain("pause");
    expect(actionsFor(s("paused"))).toContain("resume");
    expect(actionsFor(s("finished"))).toContain("archive");
    expect(actionsFor(s("working"))).not.toContain("archive");
  });
  it("follow-up needs a CLI session to continue", () => {
    expect(actionsFor(s("finished"))).not.toContain("follow-up");
    const withCli = { ...s("finished"), cli_session_id: "cli-1" };
    expect(actionsFor(withCli)).toContain("follow-up");
  });
});
