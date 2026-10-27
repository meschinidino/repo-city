import { BRIDGES, ISLANDS, islandCells, land } from "./world";
import type { Footprint } from "./plate";

export interface SpriteInfo { key: string; foot: Footprint }
export interface Placed { bi: number; x: number; y: number; w: number; d: number; isl: string; tree?: boolean }
export interface LayoutResult {
  placed: Placed[]; trees: Placed[]; relaxed: number; failed: number;
  overlaps: number; offLand: number; crowd: number; onRoad: number; roads: number;
  treeOnFoot: number; treeFront: number; roadCells: Set<string>;
}

/** Reserved bridge-landing cells: landing cell and cell behind it, per bridge end. */
export function roadCells(): Set<string> {
  const ROAD = new Set<string>();
  for (const br of BRIDGES) {
    const alongX = br.a[1] === br.b[1];
    ([[br.a, -1], [br.b, 1]] as const).forEach(([e, dir]) => {
      for (let k = 0; k < 2; k++) {
        const cx = alongX ? Math.floor(e[0]) + (dir > 0 ? k : -1 - k) : Math.floor(e[0]);
        const cy = alongX ? Math.floor(e[1]) : Math.floor(e[1]) + (dir > 0 ? k : -1 - k);
        ROAD.add(cx + "," + cy);
      }
    });
  }
  return ROAD;
}

/** Occupancy layout with spacing, landmark/gate scoring and trees. Port of prototype `layout`. */
export function layout(sprites: SpriteInfo[]): LayoutResult {
  const occ = new Map<string, number>();
  const placed: Placed[] = [];
  let relaxed = 0, failed = 0;
  const ROAD = roadCells();
  ROAD.forEach((k) => occ.set(k, -1));
  const byKey = (k: string) => sprites.findIndex((s) => s.key === k);
  const free = (x: number, y: number, w: number, d: number, gap: number) => {
    for (let i = -gap; i < w + gap; i++) for (let j = -gap; j < d + gap; j++) {
      const inFoot = i >= 0 && i < w && j >= 0 && j < d;
      if (inFoot && !land(x + i, y + j)) return false;
      if (occ.has(x + i + "," + (y + j))) return false;
    }
    return true;
  };
  for (const isl of ISLANDS) {
    const cells = islandCells(isl.seed);
    const cx = cells.reduce((a, c) => a + c[0], 0) / cells.length;
    const cy = cells.reduce((a, c) => a + c[1], 0) / cells.length;
    for (const [key, role] of isl.list) {
      const bi = byKey(key);
      if (bi < 0) { failed++; continue; }
      const [w, d] = sprites[bi].foot;
      let best: [number, number] | null = null, bs = -1e9, usedGap = 1;
      for (const gap of [1, 0]) {
        for (const [x, y] of cells) {
          if (!free(x, y, w, d, gap)) continue;
          const mx = x + w / 2, my = y + d / 2;
          let sc: number;
          if (role === "landmark") sc = -Math.hypot(mx - cx, my - cy);
          else if (role === "gate") {
            const front = !land(x + 1, y) || !land(x, y + 1);
            sc = front ? x + y - 0.2 * Math.hypot(mx - cx, my - cy) : -1e6;
          } else {
            let md = 1e9;
            placed.filter((p) => p.isl === isl.name).forEach((p) => { md = Math.min(md, Math.hypot(mx - (p.x + p.w / 2), my - (p.y + p.d / 2))); });
            sc = Math.min(md, 4) - 0.15 * Math.hypot(mx - cx, my - cy) + ((x * 7 + y * 3) % 5) * 0.01;
          }
          if (sc > bs) { bs = sc; best = [x, y]; }
        }
        if (best) { usedGap = gap; break; }
      }
      if (!best) { failed++; continue; }
      if (usedGap === 0) relaxed++;
      for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) occ.set(best[0] + i + "," + (best[1] + j), bi);
      placed.push({ bi, x: best[0], y: best[1], w, d, isl: isl.name });
    }
  }
  const seen = new Map<string, number>();
  let overlaps = 0, offLand = 0, onRoad = 0;
  placed.forEach((p, k) => {
    for (let i = 0; i < p.w; i++) for (let j = 0; j < p.d; j++) {
      const key = p.x + i + "," + (p.y + j);
      if (seen.has(key)) overlaps++;
      seen.set(key, k);
      if (!land(p.x + i, p.y + j)) offLand++;
      if (ROAD.has(key)) onRoad++;
    }
  });
  let crowd = 0;
  placed.forEach((p, k) => {
    outer: for (let i = -1; i <= p.w; i++) for (let j = -1; j <= p.d; j++) {
      const o = seen.get(p.x + i + "," + (p.y + j));
      if (o !== undefined && o !== k) { crowd++; break outer; }
    }
  });
  const front = new Set<string>();
  placed.forEach((p) => {
    for (let i = 0; i <= p.w; i++) front.add(p.x + i + "," + (p.y + p.d));
    for (let j = 0; j <= p.d; j++) front.add(p.x + p.w + "," + (p.y + j));
  });
  const treeIdx = sprites.map((s, i) => (s.key === "tree" ? i : -1)).filter((i) => i >= 0);
  const trees: Placed[] = [];
  if (treeIdx.length) for (const isl of ISLANDS) for (const [x, y] of islandCells(isl.seed)) {
    const k = x + "," + y;
    if (occ.has(k) || front.has(k)) continue;
    const hval = ((x * 73856093) ^ (y * 19349663)) >>> 0;
    if (hval % 3 !== 0) continue;
    const bi = treeIdx[(hval >>> 3) % treeIdx.length];
    occ.set(k, bi);
    trees.push({ bi, x, y, w: 1, d: 1, isl: isl.name, tree: true });
  }
  let treeOnFoot = 0, treeFront = 0;
  trees.forEach((t) => {
    const k = t.x + "," + t.y;
    if (seen.has(k)) treeOnFoot++;
    if (front.has(k)) treeFront++;
    if (ROAD.has(k)) treeOnFoot++;
  });
  return { placed, trees, relaxed, failed, overlaps, offLand, crowd, onRoad, roads: ROAD.size, treeOnFoot, treeFront, roadCells: ROAD };
}
