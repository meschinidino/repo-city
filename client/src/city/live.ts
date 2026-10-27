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

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `server answered ${res.status}`);
  }
  return res.json();
}

export async function fetchExtraction(server: string, repo: string): Promise<Extraction> {
  const res = await fetch(`${server}/api/extraction?path=${encodeURIComponent(repo)}`);
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
