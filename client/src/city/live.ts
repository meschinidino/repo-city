// Live-loop client for the Repo City server: extraction, session
// creation, the WebSocket event stream, and the diff report. All
// shapes are the frozen contracts in server/src (extraction schema
// v1, normalized events); nothing here invents data.

import type { Extraction } from "./types";
import type { StoredEvent } from "../events/types";

export interface SessionInfo {
  id: string;
  repo_path: string;
  island_id: string | null;
  task: string | null;
  state: string;
  cli_session_id: string | null;
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
    if (typeof body.error === "string") throw new LiveError("refused", body.error);
    throw new LiveError("server-error", `server answered ${res.status} without an error message`);
  }
  return res.json().catch(() => {
    throw new LiveError("not-json", "the answer was not JSON");
  });
}

async function fetched(url: string): Promise<Response> {
  try {
    return await fetch(url);
  } catch (e) {
    throw new LiveError("unreachable", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Failure text for the extraction load. A network failure (the
 * server is down) and a server refusal (bad repo path) need
 * different recovery instructions; mixing them up sends the user
 * to restart a healthy server.
 */
export function loadFailureText(server: string, e: Error): string {
  const kind = e instanceof LiveError ? e.kind : e instanceof TypeError ? "unreachable" : "refused";
  switch (kind) {
    case "unreachable":
      return `Could not reach the Repo City server at ${server} (${e.message}). Start it with: cargo run --bin repo-city-server-bin (in server/). Nothing was rendered from invented data.`;
    case "bad-url":
      return `That server address is not a valid URL: ${server}. Fix the server parameter and reload. Nothing was rendered from invented data.`;
    case "not-json":
      return `Something answered at ${server}, but not with Repo City JSON. The server parameter should point at the Rust server (default http://127.0.0.1:8787), not the Vite page. Nothing was rendered from invented data.`;
    case "server-error":
      return `The Repo City server errored: ${e.message}. Check its terminal output. Nothing was rendered from invented data.`;
    case "refused":
      return `The Repo City server refused to open that repo: ${e.message}. Fix the repo path and reload. Nothing was rendered from invented data.`;
  }
}

export async function fetchExtraction(server: string, repo: string): Promise<Extraction> {
  try {
    new URL(server);
  } catch {
    throw new LiveError("bad-url", `invalid server URL: ${server}`);
  }
  const res = await fetched(`${server}/api/extraction?path=${encodeURIComponent(repo)}`);
  return (await jsonOrThrow(res)) as Extraction;
}

export async function createSession(
  server: string,
  repo: string,
  opts: { task?: string; spawn?: boolean; islandId?: string } = {},
): Promise<SessionInfo> {
  const res = await fetch(`${server}/api/sessions`, {
    method: "POST",
    // The custom header forces a CORS preflight, so a random web
    // page cannot create sessions with a simple cross-origin POST.
    headers: { "content-type": "application/json", "x-repo-city": "1" },
    body: JSON.stringify({
      repo_path: repo,
      task: opts.task,
      spawn: opts.spawn ?? false,
      island_id: opts.islandId,
    }),
  });
  return (await jsonOrThrow(res)) as SessionInfo;
}

export async function stopSession(server: string, sessionId: string): Promise<void> {
  const res = await fetch(`${server}/api/sessions/${sessionId}/stop`, {
    method: "POST",
    headers: { "x-repo-city": "1" },
  });
  await jsonOrThrow(res);
}

export async function fetchReport(server: string, sessionId: string): Promise<DiffReportView> {
  const res = await fetch(`${server}/api/sessions/${sessionId}/report`);
  return (await jsonOrThrow(res)) as DiffReportView;
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
