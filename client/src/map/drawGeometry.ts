import type { Pt } from "./pixels";
import { projector } from "./world";

export interface Bridge { a: [number, number]; b: [number, number] }

/** Deck corner points (grid space) for a code-drawn bridge; ends are shore-edge midpoints by construction. */
export function bridgeDeck(bridge: Bridge, halfWidth = 0.22) {
  const alongX = bridge.a[1] === bridge.b[1];
  const u0 = alongX ? bridge.a[0] : bridge.a[1];
  const u1 = alongX ? bridge.b[0] : bridge.b[1];
  const fixed = alongX ? bridge.a[1] : bridge.a[0];
  const pt = (u: number, v: number): [number, number] => (alongX ? [u, fixed + v] : [fixed + v, u]);
  return {
    alongX, u0, u1,
    top: [pt(u0, -halfWidth), pt(u1, -halfWidth), pt(u1, halfWidth), pt(u0, halfWidth)] as Pt[],
    posts: Array.from({ length: Math.max(0, Math.floor(u1 - (u0 + 0.5)) + 1) }, (_, i) => u0 + 0.5 + i),
    rails: [-halfWidth, halfWidth],
  };
}

export function laneScreenPoints(lane: [number, number][], TW: number, thickPx: number): Pt[] {
  const { project } = projector(TW);
  return lane.map(([gx, gy]) => {
    const [x, y] = project(gx, gy);
    return [x, y + thickPx] as Pt;
  });
}

export function bridgeScreenDeck(bridge: Bridge, TW: number): Pt[] {
  const { project } = projector(TW);
  return bridgeDeck(bridge).top.map(([gx, gy]) => project(gx, gy));
}

/** A bridge endpoint lies at the midpoint (fractional .5) of a shore cell edge. */
export function isShoreEdgeMidpoint(p: [number, number]): boolean {
  return (Number.isInteger(p[0]) && p[1] % 1 === 0.5) || (Number.isInteger(p[1]) && p[0] % 1 === 0.5);
}
