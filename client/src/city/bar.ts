// Harbor bar (T12, variant A): the bottom command bar, its agent
// tokens, and the quest log above it. State comes from the server
// (T5 routes) through live.ts; nothing here invents a session or a
// state. The map follows the quest the user picks here (main.ts
// owns the follow switch); this module owns the bar's own list
// and forms.

import {
  createSession,
  fetchSessionEvents,
  fetchSessions,
  sendMessage,
  sessionAction,
  type SessionInfo,
} from "./live";
import type { StoredEvent } from "../events/types";
import { stallText } from "./finish";

export const MAX_ACTIVE_QUESTS = 3;

const ACTIVE = new Set(["working", "paused"]);

export function isActive(s: SessionInfo): boolean {
  return ACTIVE.has(s.state);
}

/** Counts toward the server's 3-quest cap: state `working` with a
 * worktree, across all repos (store rule). Watcher-only sessions
 * and paused quests do not count. */
export function countsTowardCap(s: SessionInfo): boolean {
  return s.state === "working" && s.worktree_path !== null;
}

/** Plain words for a server state; unknown states pass through. */
export function stateText(state: string): string {
  switch (state) {
    case "working": return "working";
    case "paused": return "paused";
    case "stopped": return "stopped";
    case "finished": return "finished";
    case "failed": return "crashed";
    case "kept": return "kept";
    case "accepted": return "accepted";
    case "discarded": return "discarded";
    case "archived": return "archived";
    default: return state;
  }
}

export interface CapState {
  capped: boolean;
  /** Active quests, named for the cap message (D-cap). */
  active: SessionInfo[];
}

/** The 3-quest cap, with the server's own rule (spawned working
 * quests, all repos). `active` names the quests filling the cap. */
export function capState(sessions: SessionInfo[]): CapState {
  const active = sessions.filter(countsTowardCap);
  return { capped: active.length >= MAX_ACTIVE_QUESTS, active };
}

/** Actions the quest log may offer (server enforces). Follow-up
 * needs a CLI session to continue; without one the server 409s,
 * so it is not offered. Accept, Discard, and Keep live on the
 * report card, not here (design: finish flow). */
export function actionsFor(s: SessionInfo): string[] {
  const follow = s.cli_session_id ? ["follow-up"] : [];
  switch (s.state) {
    case "working": return ["pause", "stop"];
    case "paused": return ["resume", "stop"];
    case "finished": return [...follow, "archive", "report"];
    case "failed": return [...follow, "archive", "report"];
    case "stopped": return [...follow, "archive", "report"];
    case "kept": return [...follow, "archive", "report"];
    case "accepted": return ["archive", "report"];
    case "discarded": return ["archive", "report"];
    default: return [];
  }
}

export interface HarborDeps {
  server: string;
  repo: string;
  islands: { id: string; name: string }[];
  /** Show the report card for a session (main owns the card). */
  onShowReport: (s: SessionInfo) => void;
  /** The create form's target changed; main rings the island. */
  onTargetPicked: (islandId: string | null) => void;
  /** Sessions changed; main may refresh its status line. */
  onSessionsChanged: (sessions: SessionInfo[]) => void;
  /** The map should follow this quest (null: back to the
   * primary session). Called on token pick and on create. */
  onFollow?: (s: SessionInfo | null) => void;
}

/** Feed lines for the quest detail: the agent's replies and,
 * when the stream carries it, its reasoning. File touches and
 * lifecycle records are not feed lines; the map shows those. */
export function feedLines(events: readonly StoredEvent[]): { kind: "msg" | "reason"; text: string }[] {
  const lines: { kind: "msg" | "reason"; text: string }[] = [];
  for (const e of events) {
    if (e.type === "agent_message") lines.push({ kind: "msg", text: e.text });
    else if (e.type === "agent_reasoning") lines.push({ kind: "reason", text: e.text });
  }
  return lines.slice(-30);
}

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** Model and effort choices per agent CLI. The word lists are
 * what each CLI accepts; the server checks them again. */
export const AGENT_CHOICES: Record<string, { models: [string, string][]; efforts: [string, string][] }> = {
  claude: {
    models: [
      ["", "Default model"],
      ["opus", "Opus — strongest"],
      ["sonnet", "Sonnet — balanced"],
      ["haiku", "Haiku — fastest"],
    ],
    efforts: [
      ["", "Default effort"],
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra high"],
      ["max", "Max"],
    ],
  },
  muse: {
    models: [
      ["", "Default model"],
      ["muse-spark-1.3", "Muse Spark 1.3"],
      ["muse-wonder-1.0", "Muse Wonder 1.0"],
      ["muse-wonder-1.0-full", "Muse Wonder 1.0 Full"],
    ],
    efforts: [
      ["", "Default effort"],
      ["none", "None"],
      ["minimal", "Minimal"],
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra high"],
      ["max", "Max"],
      ["ultra", "Ultra"],
    ],
  },
};

function fillSelect(select: HTMLSelectElement, options: [string, string][]): void {
  const keep = select.value;
  select.innerHTML = "";
  for (const [value, label] of options) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    select.appendChild(o);
  }
  select.value = options.some(([v]) => v === keep) ? keep : "";
}

/** Agent name for the detail line, or null for watch-only. */
export function agentLabel(s: SessionInfo): string | null {
  if (!s.worktree_path) return null;
  return s.agent === "muse" ? "Muse" : "Claude";
}

export class HarborBar {
  private deps: HarborDeps;
  private sessions: SessionInfo[] = [];
  private selectedId: string | null = null;
  private scrolledToId: string | null = null;
  private logOpen = false;

  constructor(deps: HarborDeps) {
    this.deps = deps;
    el("new-quest").addEventListener("click", () => this.toggleLog());
    el("questlog-close").addEventListener("click", () => this.closeQuest());
    el("create-btn").addEventListener("click", () => void this.create());
    const syncAgentSelects = () => {
      const kind = el<HTMLSelectElement>("agent-select").value;
      const watch = kind === "watch";
      const modelSel = el<HTMLSelectElement>("model-select");
      const effortSel = el<HTMLSelectElement>("effort-select");
      modelSel.disabled = watch;
      effortSel.disabled = watch;
      const choices = AGENT_CHOICES[kind === "muse" ? "muse" : "claude"];
      fillSelect(modelSel, choices.models);
      fillSelect(effortSel, choices.efforts);
    };
    el<HTMLSelectElement>("agent-select").addEventListener("change", () => {
      syncAgentSelects();
      this.renderLog();
    });
    // A restored form can open on "watch" with no change event.
    syncAgentSelects();
    el<HTMLSelectElement>("island-select").addEventListener("change", () => {
      const v = el<HTMLSelectElement>("island-select").value;
      this.deps.onTargetPicked(v || null);
    });
    for (const [id, action] of [
      ["act-pause", "pause"],
      ["act-resume", "resume"],
      ["act-stop", "stop"],
      ["act-archive", "archive"],
    ] as const) {
      el(id).addEventListener("click", () => void this.act(action));
    }
    el("act-follow").addEventListener("click", () => void this.followUp());
    el("act-msg").addEventListener("click", () => void this.sendQueued());
    el("act-report").addEventListener("click", () => {
      const s = this.selected();
      if (s) this.deps.onShowReport(s);
    });
    const select = el<HTMLSelectElement>("island-select");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "No island (whole repo)";
    select.appendChild(none);
    for (const isl of deps.islands) {
      const o = document.createElement("option");
      o.value = isl.id;
      o.textContent = isl.name;
      select.appendChild(o);
    }
  }

  islandName(id: string | null): string {
    if (!id) return "no island";
    return this.deps.islands.find((i) => i.id === id)?.name ?? id;
  }

  /** Map click: set the create form's target island. */
  setTargetIsland(id: string | null): void {
    el<HTMLSelectElement>("island-select").value = id ?? "";
    if (id && !this.logOpen) this.toggleLog(true);
  }

  /** Close the quest log and clear the picked target (the
   * Close button, or a click on open water). The picked quest
   * token, if any, stays picked for when the log reopens. */
  closeQuest(): void {
    el<HTMLSelectElement>("island-select").value = "";
    this.toggleLog(false);
  }

  private allSessions: SessionInfo[] = [];

  async refresh(): Promise<void> {
    try {
      this.allSessions = await fetchSessions(this.deps.server);
      this.sessions = this.allSessions.filter((s) => s.repo_path === this.deps.repo && s.state !== "archived");
      if (el("detail-error").textContent?.startsWith("Could not refresh")) this.showError("");
    } catch (e) {
      // Keep the last known list; say the refresh failed instead
      // of inventing an empty harbour.
      this.showError(`Could not refresh the quest list: ${(e as Error).message}`);
    }
    this.render();
    this.deps.onSessionsChanged(this.sessions);
  }

  private selected(): SessionInfo | null {
    return this.sessions.find((s) => s.id === this.selectedId) ?? null;
  }

  private toggleLog(force?: boolean): void {
    this.logOpen = force ?? !this.logOpen;
    el("questlog").style.display = this.logOpen ? "block" : "none";
    if (this.logOpen) this.renderLog();
  }

  private render(): void {
    const wrap = el("tokens");
    wrap.innerHTML = "";
    // Stable order (newest first): a quest never jumps along the
    // bar when its state changes (owner call).
    const ordered = [...this.sessions].sort((a, b) => b.created_ms - a.created_ms);
    for (const s of ordered) {
      const b = document.createElement("button");
      b.className = "token" + (s.id === this.selectedId ? " selected" : "");
      b.dataset.id = s.id;
      const sail = document.createElement("img");
      sail.className = "ship";
      sail.src = "/ship-icon.png";
      sail.alt = "";
      const label = document.createElement("span");
      label.className = "token-text";
      // A stalled quest names its silence on the token, with
      // a pulsing amber dot instead of the working one.
      const stall = stallText(s, Date.now());
      label.textContent = `${this.islandName(s.island_id)} · ${stateText(s.state)}${stall ? ` · ${stall}` : ""}`;
      const dot = document.createElement("span");
      dot.className = stall ? "dot dot-stalled" : `dot dot-${s.state}`;
      b.append(sail, label, dot);
      b.title = s.task ?? "";
      b.addEventListener("click", () => {
        this.selectedId = s.id === this.selectedId ? null : s.id;
        this.deps.onFollow?.(this.selectedId ? s : null);
        this.render();
        this.toggleLog(this.selectedId !== null || this.logOpen);
      });
      wrap.appendChild(b);
    }
    // Keep the selected token in view, but only when the
    // selection changes: render() also runs on the 5s poll, and
    // scrolling then would fight the user's own scrolling.
    if (this.selectedId && this.selectedId !== this.scrolledToId) {
      this.scrolledToId = this.selectedId;
      wrap.querySelector(".token.selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    if (!this.selectedId) this.scrolledToId = null;
    this.renderLog();
  }

  private renderLog(): void {
    if (!this.logOpen) return;
    const cap = capState(this.allSessions);
    const createBtn = el<HTMLButtonElement>("create-btn");
    const note = el("cap-note");
    const wantsAgent = el<HTMLSelectElement>("agent-select").value !== "watch";
    createBtn.disabled = cap.capped && wantsAgent;
    const named = cap.active.slice(0, 3).map((s) => `“${s.task ?? "untitled"}” on ${s.repo_path === this.deps.repo ? this.islandName(s.island_id) : "another repo"}`).join(", ");
    const more = cap.active.length > 3 ? `, and ${cap.active.length - 3} more` : "";
    note.textContent = cap.capped
      ? `Three agent quests are already running: ${named}${more}. Stop one to start another, or start a watch-only quest.`
      : "";
    note.style.display = cap.capped ? "block" : "none";

    const s = this.selected();
    const detail = el("session-detail");
    if (!s) {
      detail.style.display = "none";
      return;
    }
    detail.style.display = "block";
    el("detail-title").textContent = s.task ?? "Untitled quest";
    const chosen = [agentLabel(s), s.model, s.effort].filter(Boolean).join(" · ");
    const stall = stallText(s, Date.now());
    el("detail-state").textContent =
      `${this.islandName(s.island_id)} — ${stateText(s.state)}${stall ? ` · ${stall}` : ""}${chosen ? ` · ${chosen}` : ""}`;
    // A stalled quest already offers Nudge (the message box: the
    // message runs when this run ends) and Stop below.
    const canMessage = s.worktree_path !== null && (s.state === "working" || s.state === "paused");
    el("msg-row").style.display = canMessage ? "" : "none";
    const msgNote = el("msg-note");
    if (s.pending_task) {
      msgNote.textContent = `Queued: "${s.pending_task}" — runs ${s.state === "paused" ? "on resume" : "when this run ends"}.`;
      msgNote.style.display = "block";
    } else {
      msgNote.style.display = "none";
    }
    void this.loadFeed(s);
    const allowed = actionsFor(s);
    // The whole follow-up row (label, input, button) hides when
    // the quest cannot take one; the button alone used to hide
    // and left its input dangling (QA2).
    el("follow-row").style.display = allowed.includes("follow-up") ? "" : "none";
    for (const [id, action] of [
      ["act-pause", "pause"],
      ["act-resume", "resume"],
      ["act-stop", "stop"],
      ["act-archive", "archive"],
      ["act-follow", "follow-up"],
      ["act-report", "report"],
    ] as const) {
      el(id).style.display = allowed.includes(action) ? "" : "none";
    }
  }

  private feedSeq = 0;

  /** Replies and reasoning for the picked quest, from its real
   * event log. Muse streams carry no reasoning text (only a
   * token count), so a Muse feed shows replies only — nothing
   * is invented to fill it. */
  private async loadFeed(s: SessionInfo): Promise<void> {
    const seq = ++this.feedSeq;
    const box = el("agent-feed");
    box.innerHTML = "";
    box.style.display = "none";
    try {
      const events = await fetchSessionEvents(this.deps.server, s.id);
      if (seq !== this.feedSeq || this.selectedId !== s.id) return;
      const lines = feedLines(events);
      box.innerHTML = "";
      for (const line of lines) {
        const div = document.createElement("div");
        div.className = line.kind === "reason" ? "feed-reason" : "feed-msg";
        div.textContent = line.text;
        box.appendChild(div);
      }
      box.style.display = lines.length ? "block" : "none";
      box.scrollTop = box.scrollHeight;
    } catch {
      if (seq === this.feedSeq) box.style.display = "none";
    }
  }

  private async sendQueued(): Promise<void> {
    const s = this.selected();
    if (!s) return;
    const input = el<HTMLInputElement>("msg-task");
    const task = input.value.trim();
    if (!task) {
      this.showError("Write the message first.");
      return;
    }
    try {
      await sendMessage(this.deps.server, s.id, task);
      input.value = "";
      this.showError("");
      await this.refresh();
    } catch (e) {
      this.showError(`The message did not queue: ${(e as Error).message}`);
    }
  }

  private showError(message: string): void {
    const e = el("detail-error");
    e.textContent = message;
    e.style.display = message ? "block" : "none";
  }

  private async create(): Promise<void> {
    const task = el<HTMLInputElement>("quest-task").value.trim();
    const islandId = el<HTMLSelectElement>("island-select").value || undefined;
    const agentKind = el<HTMLSelectElement>("agent-select").value;
    const spawn = agentKind !== "watch";
    if (!task) {
      this.showError("Write the quest in plain English first.");
      this.toggleLog(true);
      return;
    }
    const model = el<HTMLSelectElement>("model-select").value || undefined;
    const effort = el<HTMLSelectElement>("effort-select").value || undefined;
    try {
      const s = await createSession(this.deps.server, this.deps.repo, {
        task,
        spawn,
        islandId,
        model: spawn ? model : undefined,
        effort: spawn ? effort : undefined,
        agent: spawn ? (agentKind === "muse" ? "muse" : "claude") : undefined,
      });
      this.selectedId = s.id;
      this.deps.onFollow?.(s);
      el<HTMLInputElement>("quest-task").value = "";
      this.showError("");
      await this.refresh();
    } catch (e) {
      this.showError(`The server refused that quest: ${(e as Error).message}`);
      this.toggleLog(true);
    }
  }

  private async act(action: "pause" | "resume" | "stop" | "archive"): Promise<void> {
    const s = this.selected();
    if (!s) return;
    try {
      await sessionAction(this.deps.server, s.id, action);
      this.showError("");
      if (action === "archive") this.selectedId = null;
      await this.refresh();
    } catch (e) {
      this.showError(`That did not happen: ${(e as Error).message}`);
    }
  }

  private async followUp(): Promise<void> {
    const s = this.selected();
    if (!s) return;
    const task = el<HTMLInputElement>("follow-task").value.trim();
    if (!task) {
      this.showError("Write the follow-up first.");
      return;
    }
    try {
      await sessionAction(this.deps.server, s.id, "follow-up", task);
      el<HTMLInputElement>("follow-task").value = "";
      this.showError("");
      await this.refresh();
    } catch (e) {
      this.showError(`That did not happen: ${(e as Error).message}`);
    }
  }
}
