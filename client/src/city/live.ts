// Live-loop client for the Repo City server: extraction, session
// creation, the WebSocket event stream, and the diff report. All
// shapes are the frozen contracts in server/src (extraction schema
// v1, normalized events); nothing here invents data.

import type { Extraction } from "./types";
import type { StoredEvent } from "../events/types";

export interface SessionInfo {
  id: string;
  repo_path: string;
  worktree_path: string | null;
  island_id: string | null;
  /** Drag-connect source island (step 6); null for ordinary quests. */
  source_island_id: string | null;
  task: string | null;
  state: string;
  /** Merge target recorded at creation (T6); null for
   * watcher-only quests and pre-step-5 rows. */
  base_branch: string | null;
  /** Newest event time, for the stalled marker; null when the
   * log holds nothing. */
  last_event_ms: number | null;
  model: string | null;
  effort: string | null;
  agent: string | null;
  pending_task: string | null;
  cli_session_id: string | null;
  created_ms: number;
  updated_ms: number;
}

/** Read-only Accept preview (T6): everything the card shows
 * before the user confirms. The POST re-checks it all. */
export interface AcceptPreview {
  session: SessionInfo;
  state_ok: boolean;
  worktree_exists: boolean;
  base_branch: string | null;
  current_branch: string | null;
  on_target: boolean;
  dirty_files: string[];
  merge_in_progress: boolean;
  test: { command: string; source: string; dir: string } | null;
}

/** POST /accept answer: the session plus what happened. */
export interface AcceptResult {
  session: SessionInfo;
  merge_sha: string;
  test_command: string | null;
  test_source: string | null;
  test_passed: boolean | null;
  test_output: string;
  /** Set when the merge landed but the worktree cleanup failed. */
  cleanup_warning: string | null;
}

export interface DiffReportView {
  generated_by: string;
  available: boolean;
  reason: string | null;
  files: { path: string; insertions: number; deletions: number; binary: boolean; new_file: boolean }[];
  insertions: number;
  deletions: number;
  summary: string;
  events?: StoredEvent[];
}

/** How a live call failed; each kind needs a different fix. */
export type FailureKind = "unreachable" | "refused" | "server-error" | "not-json" | "bad-url";

export class LiveError extends Error {
  kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    // Only a 4xx is a refusal of this request; a 5xx is the
    // server's own failure even when it carries a message, and
    // "fix the repo path" is the wrong advice for it.
    if (res.status < 500 && typeof body.error === "string") throw new LiveError("refused", body.error);
    throw new LiveError("server-error", body.error ?? `server answered ${res.status} without an error message`);
  }
  return res.json().catch(() => {
    throw new LiveError("not-json", "the answer was not JSON");
  });
}

async function fetched(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new LiveError("unreachable", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Failure text for a live call. A network failure (the server is
 * down or refusing this origin) and a server refusal (bad repo
 * path) need different recovery instructions; mixing them up
 * sends the user to restart a healthy server.
 */
export function loadFailureText(server: string, e: Error, what = "open that repo"): string {
  const kind = e instanceof LiveError ? e.kind : e instanceof TypeError ? "unreachable" : "refused";
  switch (kind) {
    case "unreachable":
      return `Nothing answered from the Repo City server at ${server} (${e.message}). Start it with: cargo run --bin repo-city-server-bin (in server/). If it is already running, it may be refusing this page's origin. Nothing was rendered from invented data.`;
    case "bad-url":
      return `That server address is not a valid URL: ${server}. It must start with http:// or https://. Fix the server parameter and reload. Nothing was rendered from invented data.`;
    case "not-json":
      return `Something answered at ${server}, but not with Repo City JSON. The server parameter should point at the Rust server (default http://127.0.0.1:8787), not the Vite page. Nothing was rendered from invented data.`;
    case "server-error":
      return `The Repo City server errored: ${e.message}. Check its terminal output. Nothing was rendered from invented data.`;
    case "refused":
      return `The Repo City server refused to ${what}: ${e.message}. Fix the repo path and reload. Nothing was rendered from invented data.`;
  }
}

function assertHttpServer(server: string): void {
  let protocol: string;
  try {
    protocol = new URL(server).protocol;
  } catch {
    throw new LiveError("bad-url", `invalid server URL: ${server}`);
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new LiveError("bad-url", `server URL must start with http:// or https://: ${server}`);
  }
}

export async function fetchExtraction(server: string, repo: string): Promise<Extraction> {
  assertHttpServer(server);
  const res = await fetched(`${server}/api/extraction?path=${encodeURIComponent(repo)}`);
  return (await jsonOrThrow(res)) as Extraction;
}

export async function createSession(
  server: string,
  repo: string,
  opts: { task?: string; spawn?: boolean; islandId?: string; model?: string; effort?: string; agent?: string; sourceIslandId?: string } = {},
): Promise<SessionInfo> {
  const res = await fetched(`${server}/api/sessions`, {
    method: "POST",
    // The custom header forces a CORS preflight, so a random web
    // page cannot create sessions with a simple cross-origin POST.
    headers: { "content-type": "application/json", "x-repo-city": "1" },
    body: JSON.stringify({
      repo_path: repo,
      task: opts.task,
      spawn: opts.spawn ?? false,
      island_id: opts.islandId,
      model: opts.model,
      effort: opts.effort,
      agent: opts.agent,
      source_island_id: opts.sourceIslandId,
    }),
  });
  return (await jsonOrThrow(res)) as SessionInfo;
}

/** All sessions on the server; the caller filters by repo. */
export async function fetchSessions(server: string): Promise<SessionInfo[]> {
  assertHttpServer(server);
  const res = await fetched(`${server}/api/sessions`);
  return (await jsonOrThrow(res)) as SessionInfo[];
}

export type SessionAction = "pause" | "resume" | "stop" | "archive" | "follow-up" | "discard" | "keep";

/** All stored events for one session, in order. */
export async function fetchSessionEvents(server: string, sessionId: string): Promise<StoredEvent[]> {
  assertHttpServer(server);
  const res = await fetched(`${server}/api/sessions/${sessionId}/events`);
  return (await jsonOrThrow(res)) as StoredEvent[];
}

/** Queue a message for a working or paused quest's agent. It
 * runs when the current run ends, or on resume. */
export async function sendMessage(server: string, sessionId: string, task: string): Promise<SessionInfo> {
  const res = await fetched(`${server}/api/sessions/${sessionId}/message`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-repo-city": "1" },
    body: JSON.stringify({ task }),
  });
  return (await jsonOrThrow(res)) as SessionInfo;
}

/** One lifecycle move on the T5 routes. Returns the session as the
 * server now holds it. A refusal (409/404) throws LiveError. */
export async function sessionAction(
  server: string,
  sessionId: string,
  action: SessionAction,
  task?: string,
): Promise<SessionInfo> {
  const res = await fetched(`${server}/api/sessions/${sessionId}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-repo-city": "1" },
    body: action === "follow-up" ? JSON.stringify({ task: task ?? "" }) : undefined,
  });
  return (await jsonOrThrow(res)) as SessionInfo;
}

export async function stopSession(server: string, sessionId: string): Promise<void> {
  const res = await fetched(`${server}/api/sessions/${sessionId}/stop`, {
    method: "POST",
    headers: { "x-repo-city": "1" },
  });
  await jsonOrThrow(res);
}

export async function fetchReport(server: string, sessionId: string): Promise<DiffReportView> {
  const res = await fetched(`${server}/api/sessions/${sessionId}/report`);
  return (await jsonOrThrow(res)) as DiffReportView;
}

export async function fetchAcceptPreview(server: string, sessionId: string): Promise<AcceptPreview> {
  assertHttpServer(server);
  const res = await fetched(`${server}/api/sessions/${sessionId}/accept-preview`);
  return (await jsonOrThrow(res)) as AcceptPreview;
}

/** Accept a quest: merge, checks, cleanup. Returns what
 * happened; a guard refusal throws LiveError with the reason. */
export async function acceptSession(server: string, sessionId: string): Promise<AcceptResult> {
  const res = await fetched(`${server}/api/sessions/${sessionId}/accept`, {
    method: "POST",
    headers: { "x-repo-city": "1" },
  });
  return (await jsonOrThrow(res)) as AcceptResult;
}

/** Connect to the event stream; replay starts at `sinceId` (0 = all). */
export function connectEvents(
  server: string,
  sinceId: number,
  onEvent: (event: StoredEvent) => void,
  onState: (state: "open" | "closed" | "error") => void,
): WebSocket {
  const wsUrl = `${server.replace(/^http/, "ws")}/ws?since_id=${sinceId}`;
  const ws = new WebSocket(wsUrl);
  ws.onopen = () => onState("open");
  ws.onclose = () => onState("closed");
  ws.onerror = () => onState("error");
  ws.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(String(msg.data)) as StoredEvent);
    } catch {
      // A malformed frame is dropped, never rendered as an event.
    }
  };
  return ws;
}
