// Drag-connect pure logic (step 6): task text, drop validation,
// cycle detection, and marching-ant dash geometry. Rendering and
// input live in renderCity.ts; this file decides, in words.
//
// Edge direction: { from, to } means FROM imports TO (from is the
// importer, to is the imported), matching the extraction bridges.
// A drag from island A (press) to island B (release) wants B to
// use A: the desired edge is B -> A, and the dashes flow A -> B,
// the direction of the gesture and of the value.

import type { SessionInfo } from "./live";

export interface LaneEdge {
  from: string;
  to: string;
}

/** "Connect B to A so B can use A", from display names. The
 * confirmation card shows this text editable before anything runs. */
export function dragTaskText(sourceName: string, targetName: string): string {
  return `Connect ${targetName} to ${sourceName} so ${targetName} can use ${sourceName}`;
}

/** True when the importer already imports the imported. */
export function hasEdge(edges: readonly LaneEdge[], from: string, to: string): boolean {
  return edges.some((e) => e.from === from && e.to === to);
}

/** Path of island ids from `start` to `goal` through existing
 * edges, or null when unreachable. Breadth-first, so the reported
 * cycle path is the shortest one. */
export function findPath(edges: readonly LaneEdge[], start: string, goal: string): string[] | null {
  if (start === goal) return [start];
  const prev = new Map<string, string>();
  const seen = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.from !== cur || seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, cur);
      if (e.to === goal) {
        const path = [goal];
        let at = goal;
        while (at !== start) {
          at = prev.get(at)!;
          path.unshift(at);
        }
        return path;
      }
      queue.push(e.to);
    }
  }
  return null;
}

export type DropCheck =
  | { ok: true }
  | { ok: false; reason: string };

const TERMINAL = new Set(["accepted", "discarded", "archived"]);

/** Open drag quests whose import does not exist yet, as lanes
 * { source (used), target (using) }. Terminal quests drop out;
 * a satisfied quest (import landed) drops out too. */
export function pendingLanes(
  sessions: readonly SessionInfo[],
  edges: readonly LaneEdge[],
): { source: string; target: string }[] {
  return sessions
    .filter(
      (s) =>
        s.source_island_id &&
        s.island_id &&
        !TERMINAL.has(s.state) &&
        !hasEdge(edges, s.island_id, s.source_island_id),
    )
    .map((s) => ({ source: s.source_island_id!, target: s.island_id! }));
}

/** Lane-born bridges: accepted drag quests whose import really
 * exists, as unordered "a|b" pair keys (sorted, like the render
 * pair map). These draw decks despite weak counts; an accepted
 * quest without the import draws nothing — a lane becomes a
 * bridge only once the real import exists. */
export function bornBridges(
  sessions: readonly SessionInfo[],
  edges: readonly LaneEdge[],
): Set<string> {
  const out = new Set<string>();
  for (const s of sessions) {
    if (
      s.state === "accepted" &&
      s.source_island_id &&
      s.island_id &&
      hasEdge(edges, s.island_id, s.source_island_id)
    ) {
      out.add([s.source_island_id, s.island_id].sort().join("|"));
    }
  }
  return out;
}

/** One validator for a lane drop, in contract order: same island,
 * duplicate connection, running session on the target, import
 * cycle. Reasons name islands by display name for the UI. */
export function validateDrop(
  sourceId: string,
  targetId: string,
  edges: readonly LaneEdge[],
  sessions: readonly SessionInfo[],
  nameOf: (id: string) => string,
): DropCheck {
  if (sourceId === targetId) {
    return { ok: false, reason: `That drag starts and ends on ${nameOf(sourceId)}.` };
  }
  if (hasEdge(edges, targetId, sourceId)) {
    return { ok: false, reason: `${nameOf(targetId)} already uses ${nameOf(sourceId)}.` };
  }
  const holder = sessions.find(
    (s) => s.island_id === targetId && (s.state === "working" || s.state === "paused"),
  );
  if (holder) {
    return { ok: false, reason: `${nameOf(targetId)} already has a ${holder.state} quest.` };
  }
  // The new edge runs target -> source (target imports source);
  // it closes a cycle exactly when source already reaches target.
  const path = findPath(edges, sourceId, targetId);
  if (path) {
    const loop = [...path.map(nameOf), nameOf(sourceId)].join(" → ");
    return { ok: false, reason: `That would close an import cycle: ${loop}.` };
  }
  return { ok: true };
}

export interface DashPoint {
  x: number;
  y: number;
}

/** Marching-ant dashes along a polyline: [start, end] pairs in the
 * same units as the input. `phase` (0..dash+gap) slides the pattern
 * forward along the path for the flow animation; the caller wraps
 * it with time. Degenerate input yields no segments, never NaNs. */
export function dashSegments(
  points: readonly DashPoint[],
  dash: number,
  gap: number,
  phase: number,
): [DashPoint, DashPoint][] {
  const out: [DashPoint, DashPoint][] = [];
  if (points.length < 2 || dash <= 0 || gap < 0) return out;
  const total = dash + gap;
  if (total <= 0) return out;
  // Path lengths per leg and overall.
  const legs: { ax: number; ay: number; bx: number; by: number; len: number }[] = [];
  let length = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const ax = points[i].x;
    const ay = points[i].y;
    const bx = points[i + 1].x;
    const by = points[i + 1].y;
    const len = Math.hypot(bx - ax, by - ay);
    if (len > 0) {
      legs.push({ ax, ay, bx, by, len });
      length += len;
    }
  }
  if (length <= 0) return out;
  const at = (d: number): DashPoint => {
    let rest = Math.min(Math.max(d, 0), length);
    for (const leg of legs) {
      if (rest <= leg.len) {
        const t = leg.len === 0 ? 0 : rest / leg.len;
        return { x: leg.ax + (leg.bx - leg.ax) * t, y: leg.ay + (leg.by - leg.ay) * t };
      }
      rest -= leg.len;
    }
    const last = legs[legs.length - 1];
    return { x: last.bx, y: last.by };
  };
  let d = -(((phase % total) + total) % total);
  while (d < length) {
    const s = Math.max(d, 0);
    const e = Math.min(d + dash, length);
    if (e > s) out.push([at(s), at(e)]);
    d += total;
  }
  return out;
}
