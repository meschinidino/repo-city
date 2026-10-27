// Event-to-view reduction (Lane B): turns the normalized event
// stream into what the map draws. Motion follows events only — the
// ship moves on session start and on file touches mapped through the
// extraction; an unmappable touch keeps the ship at the island gate
// marked location unknown. It never invents a building.

import type { StoredEvent } from "./types";

export interface SessionView {
  sessionId: string;
  state: "idle" | "working" | "finished" | "failed" | "stopped";
  cliSessionId: string | null;
  /** Island the ship is at, or the session's home island at the gate. */
  shipIsland: string | null;
  /** File the ship is docked at, when the last touch mapped to one. */
  shipFile: string | null;
  /** True when the last touch could not be mapped to a building. */
  locationUnknown: boolean;
  /** Files lit by real touches, in first-touch order. */
  litFiles: string[];
  /** Latest test pennant: true = passing, false = failing. */
  testPassed: boolean | null;
  messages: string[];
  lastSeq: number;
}

export function initialView(sessionId: string, homeIsland: string | null): SessionView {
  return {
    sessionId,
    state: "idle",
    cliSessionId: null,
    shipIsland: homeIsland,
    shipFile: null,
    locationUnknown: false,
    litFiles: [],
    testPassed: null,
    messages: [],
    lastSeq: 0,
  };
}

/**
 * Apply one event. `fileToIsland` comes from the extraction (file
 * path -> island id); a touch for a path outside it is location
 * unknown, rendered at the gate — never at an invented building.
 * Events at or below `lastSeq` are replay duplicates and are ignored.
 */
export function applyEvent(
  view: SessionView,
  event: StoredEvent,
  fileToIsland: ReadonlyMap<string, string>,
): SessionView {
  if (event.session_id !== view.sessionId || event.seq <= view.lastSeq) return view;
  const next: SessionView = { ...view, lastSeq: event.seq, messages: [...view.messages], litFiles: [...view.litFiles] };
  switch (event.type) {
    case "session_started":
      next.state = "working";
      if (event.cli_session_id) next.cliSessionId = event.cli_session_id;
      break;
    case "file_touched": {
      const island = fileToIsland.get(event.path);
      if (island) {
        next.shipIsland = island;
        next.shipFile = event.path;
        next.locationUnknown = false;
      } else {
        // Stay at the gate of the island we are on; invent nothing.
        next.shipFile = null;
        next.locationUnknown = true;
      }
      if (!next.litFiles.includes(event.path)) next.litFiles.push(event.path);
      break;
    }
    case "command_run":
      break;
    case "test_result":
      next.testPassed = event.passed;
      break;
    case "agent_message":
      next.messages.push(event.text);
      break;
    case "session_finished":
      next.state = event.outcome === "completed" ? "finished" : event.outcome === "failed" ? "failed" : "stopped";
      break;
  }
  return next;
}

export function applyEvents(
  view: SessionView,
  events: readonly StoredEvent[],
  fileToIsland: ReadonlyMap<string, string>,
): SessionView {
  return events.reduce((v, e) => applyEvent(v, e, fileToIsland), view);
}
