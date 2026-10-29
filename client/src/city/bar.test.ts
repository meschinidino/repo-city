// Harbor bar helpers: the cap and the plain-word states are the
// owner's decisions (D-cap), so they carry unit tests.

import { describe, expect, it } from "vitest";
import { AGENT_CHOICES, actionsFor, agentLabel, capState, feedLines, hoverCard, stateText, tokenLabel } from "./bar";
import type { SessionInfo } from "./live";

const s = (state: string, task = "t", worktree: string | null = "/wt"): SessionInfo =>
  ({ id: Math.random().toString(36).slice(2), repo_path: "/r", worktree_path: worktree, island_id: null, task, state, base_branch: "main", last_event_ms: null, cli_session_id: null, model: null, effort: null, agent: "claude", pending_task: null, created_ms: 0, updated_ms: 0 });

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
    expect(stateText("kept")).toBe("kept");
    expect(stateText("accepted")).toBe("accepted");
    expect(stateText("discarded")).toBe("discarded");
  });
  it("tokens lead with the task, then island and state", () => {
    expect(tokenLabel("Draft the release note", "tests", "stopped", null)).toBe("Draft the release note · tests · stopped");
    expect(tokenLabel("x", "sales", "failed", null)).toBe("x · sales · crashed");
    expect(tokenLabel("x", "tests", "working", "no news for 5 min")).toBe("x · tests · working · no news for 5 min");
    expect(tokenLabel(null, "tests", "working", null)).toBe("untitled · tests · working");
    expect(tokenLabel("   ", "tests", "working", null)).toBe("untitled · tests · working");
  });
  it("hover cards carry the full task plus island, state, stall", () => {
    expect(hoverCard("Draft the release note", "tests", "stopped", null)).toEqual({
      title: "Draft the release note",
      meta: "tests · stopped",
    });
    expect(hoverCard("x", "tests", "working", "no news for 5 min")).toEqual({
      title: "x",
      meta: "tests · working · no news for 5 min",
    });
    expect(hoverCard(null, "no island", "working", null)).toEqual({ title: "Untitled quest", meta: "no island · working" });
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
  it("stopped and kept quests can send back, finished quests can report", () => {
    const stopped = { ...s("stopped"), cli_session_id: "cli-1" };
    const kept = { ...s("kept"), cli_session_id: "cli-1" };
    expect(actionsFor(stopped)).toContain("follow-up");
    expect(actionsFor(kept)).toContain("follow-up");
    expect(actionsFor(s("accepted"))).toEqual(["archive", "report"]);
    expect(actionsFor(s("discarded"))).toEqual(["archive", "report"]);
  });
});

describe("agent choices (muse is a first-class agent)", () => {
  it("muse has its own model and effort words", () => {
    const muse = AGENT_CHOICES.muse;
    expect(muse.models.map(([v]) => v)).toContain("muse-spark-1.3");
    expect(muse.models.map(([v]) => v)).toContain("muse-wonder-1.0-full");
    expect(muse.efforts.map(([v]) => v)).toContain("ultra");
    expect(AGENT_CHOICES.claude.efforts.map(([v]) => v)).not.toContain("ultra");
  });
  it("the detail line names the agent, never for watch-only", () => {
    expect(agentLabel(s("working"))).toBe("Claude");
    expect(agentLabel({ ...s("working"), agent: "muse" })).toBe("Muse");
    expect(agentLabel(s("working", "t", null))).toBeNull();
  });
});

describe("feedLines (replies and reasoning only)", () => {
  const ev = (type: string, text: string, seq: number) =>
    ({ type, text, seq, id: seq, session_id: "s", ts_ms: 0, source: "cli" }) as never;
  it("keeps messages and reasoning, drops lifecycle and touches", () => {
    const lines = feedLines([
      ev("session_started", "", 1),
      ev("agent_reasoning", "check the parser", 2),
      ev("file_touched", "a.ts", 3),
      ev("agent_message", "on it", 4),
    ]);
    expect(lines).toEqual([
      { kind: "reason", text: "check the parser" },
      { kind: "msg", text: "on it" },
    ]);
  });
});
