// Data-driven city layout (T7 first slice): islands from a real
// extraction, shelf-packed on the iso grid with water between them.
// Every building sits on a 2x2 plot (the largest sprite footprint),
// row-major inside its island. Layout is frozen once computed —
// districts never move while a session works (design: map stability).

import type { Extraction } from "./types";

export const PLOT = 2; // cells per building plot edge
export const GAP_PLOTS = 4; // water between islands, in plots (8 cells; owner: more space between islands)

export interface CityIsland {
  id: string;
  name: string;
  path: string;
  x: number;
  y: number;
  cols: number; // in plots
  rows: number; // in plots
  gate: { gx: number; gy: number }; // first plot, grid cells
  center: { gx: number; gy: number }; // grid cells
  /** Land cells (grid cells, "gx,gy") inside the island rect: the
   * organic outline. Every occupied plot cell is always land. */
  cells: Set<string>;
  /** Every file on this island is a test: the island is a compact
   * islet and does not size by file count. */
  testOnly: boolean;
  testCount: number;
}

/** Stable string hash (FNV-1a) for shape seeds. */
export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Seeded value noise, 3 octaves. Same shape on every load. */
function makeNoise(seed: number): (x: number, y: number) => number {
  const hash = (x: number, y: number): number => {
    const n = Math.sin(x * 127.1 + y * 311.7 + seed * 0.371) * 43758.5453;
    return n - Math.floor(n);
  };
  const smooth = (x: number, y: number): number => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return hash(xi, yi) * (1 - u) * (1 - v) + hash(xi + 1, yi) * u * (1 - v)
      + hash(xi, yi + 1) * (1 - u) * v + hash(xi + 1, yi + 1) * u * v;
  };
  return (x, y) => 0.55 * smooth(x, y) + 0.3 * smooth(x * 2.1, y * 2.1) + 0.15 * smooth(x * 4.3, y * 4.3);
}

/**
 * Organic island outline over a w x h cell rect (island-shape
 * recipe from the games research: noise minus radial falloff,
 * two majority-smoothing passes, largest landmass, holes filled).
 * `mustKeep` cells (occupied plots) are forced to land after the
 * smoothing, so a cut never takes a building. Deterministic per id.
 */
export function islandShape(id: string, w: number, h: number, mustKeep: Set<string>): Set<string> {
  if (w < 5 || h < 5) return new Set([...mustKeep, ...rectCells(w, h)]);
  const noise = makeNoise(hashSeed(id) % 10000);
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  let cells = new Set<string>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.sqrt(((x - cx) / (w * 0.62)) ** 2 + ((y - cy) / (h * 0.62)) ** 2);
    if (noise(x * 0.16, y * 0.16) - d * 0.52 > 0.02) cells.add(x + "," + y);
  }
  const has = (s: Set<string>, x: number, y: number) => s.has(x + "," + y);
  for (let pass = 0; pass < 2; pass++) {
    const next = new Set<string>();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (has(cells, x + dx, y + dy)) n++;
      if (has(cells, x, y) ? n >= 4 : n >= 5) next.add(x + "," + y);
    }
    cells = next;
  }
  // Largest connected landmass only.
  const seen = new Set<string>();
  let best = new Set<string>();
  for (const k of cells) {
    if (seen.has(k)) continue;
    const group = new Set<string>([k]);
    const stack = [k];
    seen.add(k);
    while (stack.length) {
      const [x, y] = stack.pop()!.split(",").map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nk = (x + dx) + "," + (y + dy);
        if (cells.has(nk) && !seen.has(nk)) { seen.add(nk); group.add(nk); stack.push(nk); }
      }
    }
    if (group.size > best.size) best = group;
  }
  // Fill interior holes: flood water from the border; unreached
  // water is inside the island and becomes land.
  const water = new Set<string>();
  const stack: string[] = [];
  for (let x = 0; x < w; x++) { stack.push(x + ",0", x + "," + (h - 1)); }
  for (let y = 0; y < h; y++) { stack.push("0," + y, (w - 1) + "," + y); }
  while (stack.length) {
    const k = stack.pop()!;
    if (water.has(k) || best.has(k)) continue;
    water.add(k);
    const [x, y] = k.split(",").map(Number);
    if (x > 0) stack.push((x - 1) + "," + y);
    if (x < w - 1) stack.push((x + 1) + "," + y);
    if (y > 0) stack.push(x + "," + (y - 1));
    if (y < h - 1) stack.push(x + "," + (y + 1));
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = x + "," + y;
    if (!water.has(k)) best.add(k);
  }
  for (const k of mustKeep) best.add(k);
  return best;
}

function rectCells(w: number, h: number): Set<string> {
  const cells = new Set<string>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) cells.add(x + "," + y);
  return cells;
}

export interface CityBuilding {
  file: string;
  islandId: string;
  building: string;
  gx: number; // plot origin, grid cells
  gy: number;
}


/** Landmark priority: the big building of the island. */
export const LANDMARK_PRIORITY = ["keep", "silos", "sea_gate", "lighthouse", "market", "containers", "ruin", "cottage", "pennant"];

/**
 * Arrange one island's buildings on its plot grid (owner,
 * 2026-10-27): the landmark (keep first, then the other big
 * kinds) takes the centre plot. Every other building, most
 * common kind first, takes the free plot with the fewest
 * same-kind neighbours; ties break to the plot farthest from
 * its nearest same-kind neighbour, then closest to the centre.
 * Perfect spread is impossible when one kind outnumbers the
 * plots around it; the rule minimises same-kind adjacency, and
 * the layout test reports the count it achieves.
 */
export function arrangePlots(
  kinds: string[],
  cols: number,
  rows: number,
): { x: number; y: number }[] {
  const plots: { x: number; y: number }[] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) plots.push({ x, y });
  const out: ({ x: number; y: number } | null)[] = kinds.map(() => null);
  if (kinds.length === 0) return [];
  const centre = { x: Math.round((cols - 1) / 2), y: Math.round((rows - 1) / 2) };
  const prio = (k: string) => {
    const i = LANDMARK_PRIORITY.indexOf(k);
    return i === -1 ? LANDMARK_PRIORITY.length : i;
  };
  let landmark = 0;
  for (let i = 1; i < kinds.length; i++) if (prio(kinds[i]) < prio(kinds[landmark])) landmark = i;
  const placed = new Map<string, number>(); // "x,y" -> file index
  const take = (i: number, plot: { x: number; y: number }) => {
    out[i] = plot;
    placed.set(plot.x + "," + plot.y, i);
  };
  take(landmark, centre);
  const freq = new Map<string, number>();
  for (const k of kinds) freq.set(k, (freq.get(k) ?? 0) + 1);
  const rest = kinds.map((_, i) => i)
    .filter((i) => i !== landmark)
    .sort((a, b) => (freq.get(kinds[b])! - freq.get(kinds[a])!) || prio(kinds[a]) - prio(kinds[b]) || a - b);
  const free = () => plots.filter((pl) => !placed.has(pl.x + "," + pl.y));
  for (const i of rest) {
    let best: { x: number; y: number } | null = null;
    let bestKey: [number, number, number] | null = null;
    for (const pl of free()) {
      let sameAdj = 0;
      let nearestSame = Infinity;
      for (const [key, j] of placed) {
        const [px, py] = key.split(",").map(Number);
        const d = Math.abs(px - pl.x) + Math.abs(py - pl.y);
        if (kinds[j] === kinds[i]) {
          if (d === 1) sameAdj++;
          nearestSame = Math.min(nearestSame, d);
        }
      }
      const centreDist = Math.abs(pl.x - centre.x) + Math.abs(pl.y - centre.y);
      const cand: [number, number, number] = [sameAdj, -(nearestSame === Infinity ? 99 : nearestSame), centreDist];
      if (!bestKey || cand[0] < bestKey[0] || (cand[0] === bestKey[0] && (cand[1] < bestKey[1] || (cand[1] === bestKey[1] && cand[2] < bestKey[2])))) {
        best = pl;
        bestKey = cand;
      }
    }
    if (best) take(i, best);
  }
  return out as { x: number; y: number }[];
}

export interface CityLayout {
  islands: CityIsland[];
  buildings: CityBuilding[];
  bridges: { from: string; to: string; count: number }[];
  cols: number; // grid cells
  rows: number;
  fileToIsland: Map<string, string>;
  filePos: Map<string, { gx: number; gy: number; islandId: string }>;
  /** Files whose island_id matches no island: counted and named by
   * the caller, never silently dropped or invented onto an island. */
  droppedFiles: string[];
}


/**
 * Greedy hub placement (plot units). Islands are placed
 * strongest first: the most-connected island takes the centre,
 * and each next island takes the best-scoring free spot on
 * expanding rings around the import-weighted centre of the
 * islands already placed. Seeded jitter per island. No overlaps.
 */
/** Deterministic RNG (mulberry32) so the layout never changes
 * between loads of the same repo. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type PlaceItem = { isl: { id: string }; cols: number; rows: number; px: number; py: number };

/**
 * Bridge-first annealing. The greedy pass gives a legal layout;
 * this pass moves islands to cut the bridge cost: sum over pairs
 * of sqrt(count) x centre-distance squared, plus a compactness
 * term on the bounding box. Strong pairs pull together until
 * they are neighbours, so a strong bridge becomes a short hop
 * over open water instead of a line across the map (the root
 * fault behind the bridge complaints). Deterministic: the RNG
 * is seeded from the island ids. No overlaps, ever.
 */
export function annealPlacement(items: PlaceItem[], bridges: { from_island: string; to_island: string; count: number }[]): void {
  if (items.length < 3) return;
  const idx = new Map(items.map((it, i) => [it.isl.id, i]));
  const pairs: { a: number; b: number; w: number }[] = [];
  const pairByKey = new Map<string, { a: number; b: number; w: number }>();
  for (const br of bridges) {
    const a = idx.get(br.from_island);
    const b = idx.get(br.to_island);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? a + "|" + b : b + "|" + a;
    const existing = pairByKey.get(key);
    if (existing) {
      existing.w = Math.max(existing.w, br.count);
      continue;
    }
    const p = { a, b, w: br.count };
    pairByKey.set(key, p);
    pairs.push(p);
  }
  if (!pairs.length) return;
  const overlapsAny = (i: number, x: number, y: number) =>
    items.some((o, j) => j !== i && x < o.px + o.cols + GAP_PLOTS && o.px < x + items[i].cols + GAP_PLOTS
      && y < o.py + o.rows + GAP_PLOTS && o.py < y + items[i].rows + GAP_PLOTS);
  const cost = (): number => {
    let e = 0;
    for (const p of pairs) {
      const A = items[p.a];
      const B = items[p.b];
      const dx = A.px + A.cols / 2 - (B.px + B.cols / 2);
      const dy = A.py + A.rows / 2 - (B.py + B.rows / 2);
      e += Math.sqrt(p.w) * (dx * dx + dy * dy);
    }
    const w = Math.max(...items.map((i) => i.px + i.cols)) - Math.min(...items.map((i) => i.px));
    const h = Math.max(...items.map((i) => i.py + i.rows)) - Math.min(...items.map((i) => i.py));
    return e + 1.5 * w * h;
  };
  const rand = mulberry32(hashSeed(items.map((i) => i.isl.id).sort().join("|")));
  let cur = cost();
  const iters = Math.min(24000, 400 * items.length);
  for (let k = 0; k < iters; k++) {
    const temp = 400 * Math.pow(0.004, k / iters) + 0.5;
    const i = Math.floor(rand() * items.length);
    const it = items[i];
    const ox = it.px;
    const oy = it.py;
    let j = -1;
    let jx = 0;
    let jy = 0;
    if (rand() < 0.25) {
      // Swap two islands: helps big islands move in a full city.
      j = Math.floor(rand() * items.length);
      if (j === i) continue;
      jx = items[j].px;
      jy = items[j].py;
      it.px = jx; it.py = jy;
      items[j].px = ox; items[j].py = oy;
      if (overlapsAny(i, it.px, it.py) || overlapsAny(j, ox, oy)) {
        it.px = ox; it.py = oy; items[j].px = jx; items[j].py = jy;
        continue;
      }
    } else {
      const range = temp > 60 ? 7 : 3;
      it.px += Math.floor(rand() * (range * 2 + 1)) - range;
      it.py += Math.floor(rand() * (range * 2 + 1)) - range;
      if (overlapsAny(i, it.px, it.py)) {
        it.px = ox; it.py = oy;
        continue;
      }
    }
    const next = cost();
    if (next <= cur || rand() < Math.exp(-(next - cur) / temp)) {
      cur = next;
    } else {
      if (j >= 0) { items[j].px = jx; items[j].py = jy; }
      it.px = ox; it.py = oy;
    }
  }
}

/** Does the segment p-q touch the rect (plot units)? */
function segHitsRect(
  p: { gx: number; gy: number },
  q: { gx: number; gy: number },
  r: GridRect,
): boolean {
  const inside = (pt: { gx: number; gy: number }) =>
    pt.gx >= r.x && pt.gx <= r.x + r.w && pt.gy >= r.y && pt.gy <= r.y + r.h;
  if (inside(p) || inside(q)) return true;
  const edges: [{ gx: number; gy: number }, { gx: number; gy: number }][] = [
    [{ gx: r.x, gy: r.y }, { gx: r.x + r.w, gy: r.y }],
    [{ gx: r.x + r.w, gy: r.y }, { gx: r.x + r.w, gy: r.y + r.h }],
    [{ gx: r.x + r.w, gy: r.y + r.h }, { gx: r.x, gy: r.y + r.h }],
    [{ gx: r.x, gy: r.y + r.h }, { gx: r.x, gy: r.y }],
  ];
  const cross = (a: { gx: number; gy: number }, b: { gx: number; gy: number }, c: { gx: number; gy: number }) =>
    (b.gx - a.gx) * (c.gy - a.gy) - (b.gy - a.gy) * (c.gx - a.gx);
  const segInt = (
    a: { gx: number; gy: number }, b: { gx: number; gy: number },
    c: { gx: number; gy: number }, d: { gx: number; gy: number },
  ) => {
    const d1 = cross(c, d, a);
    const d2 = cross(c, d, b);
    const d3 = cross(a, b, c);
    const d4 = cross(a, b, d);
    if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0) {
      // Collinear: hit only when the projections overlap.
      return Math.max(Math.min(a.gx, b.gx), Math.min(c.gx, d.gx)) <= Math.min(Math.max(a.gx, b.gx), Math.max(c.gx, d.gx))
        && Math.max(Math.min(a.gy, b.gy), Math.min(c.gy, d.gy)) <= Math.min(Math.max(a.gy, b.gy), Math.max(c.gy, d.gy));
    }
    return ((d1 >= 0 && d2 <= 0) || (d1 <= 0 && d2 >= 0)) && ((d3 >= 0 && d4 <= 0) || (d3 <= 0 && d4 >= 0));
  };
  return edges.some(([e1, e2]) => segInt(p, q, e1, e2));
}

/** The bridge path (plot units) between two placed items, the
 * same choice the renderer makes: straight on one axis when the
 * rectangles overlap, else shore-to-shore. */
function pairPath(
  a: PlaceItem,
  b: PlaceItem,
): { gx: number; gy: number }[] {
  const ra: GridRect = { x: a.px, y: a.py, w: a.cols, h: a.rows };
  const rb: GridRect = { x: b.px, y: b.py, w: b.cols, h: b.rows };
  const axis = bridgeAxisLegs(ra, rb);
  if (axis) return [axis[0], axis[1]];
  const span = bridgeSpan(ra, rb);
  if (!span) return [{ gx: a.px + a.cols / 2, gy: a.py + a.rows / 2 }, { gx: b.px + b.cols / 2, gy: b.py + b.rows / 2 }];
  // Same elbow the renderer draws (spanLegs in renderCity.ts):
  // straight only near a map axis, else two legs along the axes.
  const dx = Math.abs(span[1].gx - span[0].gx);
  const dy = Math.abs(span[1].gy - span[0].gy);
  if (Math.min(dx, dy) <= Math.max(dx, dy) * 0.35) return [span[0], span[1]];
  const elbow = dx >= dy ? { gx: span[1].gx, gy: span[0].gy } : { gx: span[0].gx, gy: span[1].gy };
  return [span[0], elbow, span[1]];
}

/**
 * Bridge repair (owner diagnosis, second half): after annealing,
 * walk the strong pairs (15+ imports) in count order. When an
 * island sits between a pair, try to move the smaller island to
 * a free spot next to its partner. A move sticks only when the
 * pair's path becomes clear and the moved island's other strong
 * pairs do not get worse in total. Two passes, deterministic.
 */
export function repairBridges(items: PlaceItem[], bridges: { from_island: string; to_island: string; count: number }[]): void {
  if (items.length < 3) return;
  const idx = new Map(items.map((it, i) => [it.isl.id, i]));
  const strong: { a: number; b: number; w: number }[] = [];
  const seenPair = new Set<string>();
  for (const br of bridges) {
    if (br.count < 15) continue;
    const a = idx.get(br.from_island);
    const b = idx.get(br.to_island);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? a + "|" + b : b + "|" + a;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    strong.push({ a, b, w: br.count });
  }
  strong.sort((x, y) => y.w - x.w);
  // Land reaches one cell (0.5 plot) past the rect as shore
  // margin, so the checked rect grows by that much.
  const rectOf = (i: number): GridRect => ({ x: items[i].px - 0.5, y: items[i].py - 0.5, w: items[i].cols + 1, h: items[i].rows + 1 });
  const pathClear = (a: number, b: number): boolean => {
    const pts = pairPath(items[a], items[b]);
    return items.every((_, j) => {
      if (j === a || j === b) return true;
      const r = rectOf(j);
      for (let i = 0; i + 1 < pts.length; i++) if (segHitsRect(pts[i], pts[i + 1], r)) return false;
      return true;
    });
  };
  const splitCountFor = (): number =>
    strong.filter((p) => !pathClear(p.a, p.b)).length;
  const overlapsAt = (i: number, x: number, y: number) =>
    items.some((o, j) => j !== i && x < o.px + o.cols + GAP_PLOTS && o.px < x + items[i].cols + GAP_PLOTS
      && y < o.py + o.rows + GAP_PLOTS && o.py < y + items[i].rows + GAP_PLOTS);
  for (let pass = 0; pass < 2; pass++) {
    for (const pair of strong) {
      if (pathClear(pair.a, pair.b)) continue;
      // Move the lighter island (less total bridge weight, then
      // smaller area): leaves move, hubs stay in the middle.
      const wA = strong.filter((p) => p.a === pair.a || p.b === pair.a).reduce((n, p) => n + p.w, 0);
      const wB = strong.filter((p) => p.a === pair.b || p.b === pair.b).reduce((n, p) => n + p.w, 0);
      const sizeA = items[pair.a].cols * items[pair.a].rows;
      const sizeB = items[pair.b].cols * items[pair.b].rows;
      const mover = wA !== wB ? (wA < wB ? pair.a : pair.b) : (sizeA < sizeB ? pair.a : pair.b);
      const anchorI = mover === pair.a ? pair.b : pair.a;
      const before = splitCountFor();
      const ox = items[mover].px;
      const oy = items[mover].py;
      const anchorC = { x: items[anchorI].px + items[anchorI].cols / 2, y: items[anchorI].py + items[anchorI].rows / 2 };
      let best: { x: number; y: number; score: number } | null = null;
      for (let r = 0; r <= 30 && !best; r += 2) {
        for (let step = 0; step < 24; step++) {
          const ang = (step / 24) * Math.PI * 2 + (hashSeed(items[mover].isl.id) % 628) / 100;
          const x = Math.round(anchorC.x + Math.cos(ang) * (r + items[anchorI].cols / 2) - items[mover].cols / 2);
          const y = Math.round(anchorC.y + Math.sin(ang) * (r + items[anchorI].rows / 2) * 0.9 - items[mover].rows / 2);
          if (overlapsAt(mover, x, y)) continue;
          items[mover].px = x;
          items[mover].py = y;
          const ok = pathClear(pair.a, pair.b) && splitCountFor() < before;
          items[mover].px = ox;
          items[mover].py = oy;
          if (!ok) continue;
          const score = Math.hypot(x + items[mover].cols / 2 - anchorC.x, y + items[mover].rows / 2 - anchorC.y);
          if (!best || score < best.score) best = { x, y, score };
        }
      }
      if (best) {
        items[mover].px = best.x;
        items[mover].py = best.y;
      }
    }
  }
}

export function relaxPlacement(
  items: { isl: { id: string }; cols: number; rows: number; px: number; py: number }[],
  bridges: { from_island: string; to_island: string; count: number }[],
): void {
  if (items.length < 2) return;
  const idx = new Map(items.map((it, i) => [it.isl.id, i]));
  const weight = items.map(() => 0);
  const neigh: Map<number, number>[] = items.map(() => new Map<number, number>());
  for (const b of bridges) {
    const a = idx.get(b.from_island);
    const c = idx.get(b.to_island);
    if (a === undefined || c === undefined || a === c) continue;
    neigh[a].set(c, (neigh[a].get(c) ?? 0) + b.count);
    neigh[c].set(a, (neigh[c].get(a) ?? 0) + b.count);
    weight[a] += b.count;
    weight[c] += b.count;
  }
  // Strongest first: the hub takes the centre, later islands take
  // the best free spot near the islands they connect to.
  const order = items.map((_, i) => i).sort((a, b) => weight[b] - weight[a] || items[a].isl.id.localeCompare(items[b].isl.id));
  const placedIdx: number[] = [];
  const overlaps = (x: number, y: number, it: (typeof items)[number]) =>
    placedIdx.some((j) => {
      const o = items[j];
      return x < o.px + o.cols + GAP_PLOTS && o.px < x + it.cols + GAP_PLOTS
        && y < o.py + o.rows + GAP_PLOTS && o.py < y + it.rows + GAP_PLOTS;
    });
  for (const i of order) {
    const it = items[i];
    if (placedIdx.length === 0) {
      it.px = 0;
      it.py = 0;
      placedIdx.push(i);
      continue;
    }
    // Anchor: import-weighted centre of already placed islands.
    let ax = 0, ay = 0, aw = 0;
    for (const j of placedIdx) {
      ax += (items[j].px + items[j].cols / 2) * (1 + (neigh[i].get(j) ?? 0));
      ay += (items[j].py + items[j].rows / 2) * (1 + (neigh[i].get(j) ?? 0));
      aw += 1 + (neigh[i].get(j) ?? 0);
    }
    ax /= aw; ay /= aw;
    const jitter = ((hashSeed(it.isl.id) % 100) / 100 - 0.5) * 2;
    let best: { x: number; y: number; score: number } | null = null;
    for (let r = 0; r <= 48 && !best; r += 2) {
      for (let step = 0; step < 24; step++) {
        const ang = (step / 24) * Math.PI * 2 + (hashSeed(it.isl.id) % 628) / 100;
        const cx = ax + Math.cos(ang) * r;
        const cy = ay + Math.sin(ang) * r * 0.8;
        const x = Math.round(cx - it.cols / 2);
        const y = Math.round(cy - it.rows / 2);
        if (overlaps(x, y, it)) continue;
        let score = Math.hypot(cx - ax, cy - ay) * 2 + jitter;
        for (const j of placedIdx) {
          const w = neigh[i].get(j);
          if (w) score += w * Math.hypot(cx - (items[j].px + items[j].cols / 2), cy - (items[j].py + items[j].rows / 2)) * 0.15;
        }
        if (!best || score < best.score) best = { x, y, score };
      }
    }
    // The search always finds a spot: radius grows until free.
    let fallback = 50;
    while (!best) {
      const x = Math.round(ax + fallback), y = Math.round(ay);
      if (!overlaps(x, y, it)) best = { x, y, score: 0 };
      fallback += 4;
    }
    it.px = best.x;
    it.py = best.y;
    placedIdx.push(i);
  }
  annealPlacement(items, bridges);
  repairBridges(items, bridges);
  const minX = Math.min(...items.map((i) => i.px));
  const minY = Math.min(...items.map((i) => i.py));
  for (const it of items) { it.px -= minX; it.py -= minY; }
}

export function layoutCity(extraction: Extraction): CityLayout {
  const byIsland = new Map<string, typeof extraction.files>();
  for (const f of extraction.files) {
    const list = byIsland.get(f.island_id) ?? [];
    list.push(f);
    byIsland.set(f.island_id, list);
  }
  // Largest islands first so the shelf rows stay balanced.
  const islands = [...extraction.islands].sort(
    (a, b) => b.file_count - a.file_count || a.id.localeCompare(b.id),
  );
  const placed: CityIsland[] = [];
  const buildings: CityBuilding[] = [];
  const fileToIsland = new Map<string, string>();
  const filePos = new Map<string, { gx: number; gy: number; islandId: string }>();

  let cursorX = 0;
  let cursorY = 0;
  let shelfH = 0;
  // Aim for a roughly square city: shelf width from total plots.
  const totalPlots = extraction.files.length;
  const shelfPlots = Math.max(8, Math.ceil(Math.sqrt(totalPlots) * 1.6));

  interface Pending {
    isl: (typeof islands)[number];
    files: Extraction["files"][number][];
    cols: number;
    rows: number;
    testOnly: boolean;
    mustKeep: Set<string>;
    assignments: { x: number; y: number }[] | null; // plot per file (arranged islands)
    px: number; // plot units, relaxed below
    py: number;
  }
  const pending: Pending[] = [];
  for (const isl of islands) {
    const files = (byIsland.get(isl.id) ?? []).slice().sort((a, b) => a.path.localeCompare(b.path));
    if (files.length === 0) continue;
    // A test-only island does not earn land by file count (owner
    // call, 2026-10-27): backend/tests held 103 files and was the
    // biggest island on the map while saying the least. It gets a
    // compact 3x2-plot islet; its pennants stack inside.
    const testOnly = files.every((f) => f.building === "pennant");
    const cols = testOnly ? 3 : Math.ceil(Math.sqrt(files.length));
    const rows = testOnly ? 2 : Math.ceil(files.length / cols);
    if (cursorX > 0 && cursorX + cols > shelfPlots) {
      cursorX = 0;
      cursorY += shelfH + GAP_PLOTS;
      shelfH = 0;
    }
    const assignments = testOnly ? null : arrangePlots(files.map((f) => f.building), cols, rows);
    const mustKeep = new Set<string>();
    files.forEach((f, i) => {
      const lx = testOnly ? i % (cols * PLOT) : assignments![i].x * PLOT;
      const ly = testOnly ? Math.floor(i / (cols * PLOT)) % (rows * PLOT) : assignments![i].y * PLOT;
      for (let dy = 0; dy < (testOnly ? 1 : PLOT); dy++)
        for (let dx = 0; dx < (testOnly ? 1 : PLOT); dx++) mustKeep.add(lx + dx + "," + (ly + dy));
    });
    pending.push({ isl, files, cols, rows, testOnly, mustKeep, assignments, px: cursorX, py: cursorY });
    cursorX += cols + GAP_PLOTS;
    shelfH = Math.max(shelfH, rows);
  }

  // Smarter placement (owner, 2026-10-27): shelf packing gives
  // the start positions only. Greedy hub placement then puts the
  // most-connected island in the centre and settles the rest
  // around the islands they connect to, with seeded jitter.
  // Nothing here is random per load.
  relaxPlacement(pending, extraction.bridges);

  for (const item of pending) {
    const { isl, files } = item;
    const cols = item.cols, rows = item.rows, testOnly = item.testOnly;
    const x = Math.round(item.px) * PLOT;
    const y = Math.round(item.py) * PLOT;
    // The shape runs over the plot area plus a one-cell shore
    // margin on every side. Buildings keep one free cell around
    // them (DESIGN.md layout rule), and the margin is where the
    // organic outline can actually cut: without it, edge plots
    // force a rectangle.
    const localShape = islandShape(isl.id, cols * PLOT + 2, rows * PLOT + 2, new Set([...item.mustKeep].map((k) => {
      const [lx, ly] = k.split(",").map(Number);
      return lx + 1 + "," + (ly + 1);
    })));
    const cells = new Set<string>([...localShape].map((k) => {
      const [lx, ly] = k.split(",").map(Number);
      return x + lx - 1 + "," + (y + ly - 1);
    }));
    const island: CityIsland = {
      id: isl.id,
      name: isl.name,
      path: isl.path,
      x,
      y,
      cols,
      rows,
      gate: { gx: x, gy: y },
      center: { gx: x + (cols * PLOT) / 2, gy: y + (rows * PLOT) / 2 },
      cells,
      testOnly,
      testCount: testOnly ? files.length : 0,
    };
    placed.push(island);
    files.forEach((f, i) => {
      const gx = testOnly ? x + (i % (cols * PLOT)) : x + item.assignments![i].x * PLOT;
      const gy = testOnly
        ? y + (Math.floor(i / (cols * PLOT)) % (rows * PLOT))
        : y + item.assignments![i].y * PLOT;
      buildings.push({ file: f.path, islandId: isl.id, building: f.building, gx, gy });
      fileToIsland.set(f.path, isl.id);
      filePos.set(f.path, { gx, gy, islandId: isl.id });
    });
  }

  const knownIslands = new Set(placed.map((i) => i.id));
  const droppedFiles = extraction.files
    .filter((f) => !knownIslands.has(f.island_id))
    .map((f) => f.path);

  const cols = placed.reduce((m, i) => Math.max(m, i.x + i.cols * PLOT), 0);
  const rows = placed.reduce((m, i) => Math.max(m, i.y + i.rows * PLOT), 0);
  return {
    islands: placed,
    buildings,
    bridges: extraction.bridges.map((b) => ({ from: b.from_island, to: b.to_island, count: b.count })),
    cols,
    rows,
    fileToIsland,
    filePos,
    droppedFiles,
  };
}

/**
 * Draw depth of a building on a plot: the plot's FRONT corner plus
 * the same 0.6 the test map uses (map/placement.ts). Using the back
 * corner buries short buildings (markets) under the tile rows in
 * front of them.
 */
export function plotDepth(gx: number, gy: number): number {
  return gx + PLOT - 1 + (gy + PLOT - 1) + 0.6;
}

export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The water-only span of a bridge between two island rectangles
 * (grid cells): the centre-to-centre line clipped out of both
 * islands, so a bridge starts and ends at a shoreline instead of
 * crossing the land it connects. Returns null when the rectangles
 * overlap along the line (no water between them to draw on).
 */
export function bridgeSpan(a: GridRect, b: GridRect): [{ gx: number; gy: number }, { gx: number; gy: number }] | null {
  const ax = a.x + a.w / 2;
  const ay = a.y + a.h / 2;
  const dx = b.x + b.w / 2 - ax;
  const dy = b.y + b.h / 2 - ay;
  const inside = (r: GridRect): [number, number] => {
    let t0 = -Infinity;
    let t1 = Infinity;
    if (dx === 0) {
      if (ax < r.x || ax > r.x + r.w) return [1, 0];
    } else {
      const ta = (r.x - ax) / dx;
      const tb = (r.x + r.w - ax) / dx;
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    }
    if (dy === 0) {
      if (ay < r.y || ay > r.y + r.h) return [1, 0];
    } else {
      const ta = (r.y - ay) / dy;
      const tb = (r.y + r.h - ay) / dy;
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    }
    return [t0, t1];
  };
  const exitA = inside(a)[1];
  const enterB = inside(b)[0];
  if (!(exitA < enterB)) return null;
  return [
    { gx: ax + dx * exitA, gy: ay + dy * exitA },
    { gx: ax + dx * enterB, gy: ay + dy * enterB },
  ];
}

/**
 * A straight bridge along one map axis between two island
 * rectangles: possible when the rectangles overlap on the other
 * axis. Returns the shore-to-shore span on that axis, or null
 * when neither axis overlaps (the caller then bends the span).
 * A straight one-axis bridge uses one direction asset and never
 * bends in open water.
 */
export function bridgeAxisLegs(a: GridRect, b: GridRect): [{ gx: number; gy: number }, { gx: number; gy: number }] | null {
  const oy0 = Math.max(a.y, b.y);
  const oy1 = Math.min(a.y + a.h, b.y + b.h);
  if (oy1 - oy0 > 0.5) {
    const gy = (oy0 + oy1) / 2;
    const bRight = b.x + b.w / 2 > a.x + a.w / 2;
    return [
      { gx: bRight ? a.x + a.w : a.x, gy },
      { gx: bRight ? b.x : b.x + b.w, gy },
    ];
  }
  const ox0 = Math.max(a.x, b.x);
  const ox1 = Math.min(a.x + a.w, b.x + b.w);
  if (ox1 - ox0 > 0.5) {
    const gx = (ox0 + ox1) / 2;
    const bBelow = b.y + b.h / 2 > a.y + a.h / 2;
    return [
      { gx, gy: bBelow ? a.y + a.h : a.y },
      { gx, gy: bBelow ? b.y : b.y + b.h },
    ];
  }
  return null;
}

/**
 * The water-only parts of a bridge path (owner diagnosis: a
 * bridge to a far island ignored islands in between and ran
 * through them). The path is sampled every 0.1 cells; runs over
 * land are cut out, so the deck stops at the middle island's
 * shore and resumes on its other side. Short slivers go away.
 */
export function waterSegments(
  points: { gx: number; gy: number }[],
  isLand: (gx: number, gy: number) => boolean,
): [{ gx: number; gy: number }, { gx: number; gy: number }][] {
  const segs: [{ gx: number; gy: number }, { gx: number; gy: number }][] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b.gx - a.gx, b.gy - a.gy);
    const steps = Math.max(1, Math.ceil(len / 0.1));
    let start: { gx: number; gy: number } | null = null;
    let prev: { gx: number; gy: number } | null = null;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const p = { gx: a.gx + (b.gx - a.gx) * t, gy: a.gy + (b.gy - a.gy) * t };
      const land = isLand(Math.floor(p.gx), Math.floor(p.gy));
      if (!land && !start) start = p;
      if (land && start && prev) {
        segs.push([start, prev]);
        start = null;
      }
      prev = p;
    }
    if (start && prev) segs.push([start, prev]);
  }
  return segs.filter(([p, q]) => Math.hypot(q.gx - p.gx, q.gy - p.gy) > 0.3);
}

export interface BridgeDeck {
  len: number; // grid cells along the span
  a: { gx: number; gy: number };
  b: { gx: number; gy: number };
  perp: { gx: number; gy: number }; // half-width offset, grid cells
  corners: [{ gx: number; gy: number }, { gx: number; gy: number }, { gx: number; gy: number }, { gx: number; gy: number }];
}

/** Deck geometry for a shore-to-shore span: corners in grid space,
 * half width growing slowly with the import count. Named apart
 * from the test map's axis-aligned bridgeDeck on purpose. */
export function cityBridgeDeck(
  span: [{ gx: number; gy: number }, { gx: number; gy: number }],
  count: number,
): BridgeDeck {
  const [a, b] = span;
  const dx = b.gx - a.gx;
  const dy = b.gy - a.gy;
  const len = Math.hypot(dx, dy);
  const hw = Math.min(0.26, 0.13 + 0.03 * Math.log2(count + 1));
  const perp = { gx: (-dy / len) * hw, gy: (dx / len) * hw };
  return {
    len,
    a,
    b,
    perp,
    corners: [
      { gx: a.gx - perp.gx, gy: a.gy - perp.gy },
      { gx: b.gx - perp.gx, gy: b.gy - perp.gy },
      { gx: b.gx + perp.gx, gy: b.gy + perp.gy },
      { gx: a.gx + perp.gx, gy: a.gy + perp.gy },
    ],
  };
}

export interface BridgeChevron {
  tip: { gx: number; gy: number };
  wingA: { gx: number; gy: number };
  wingB: { gx: number; gy: number };
}

/**
 * Direction chevron in grid space for a span: tip toward the
 * imported island, wings sized from the deck's own half-width so
 * the arrow never sticks out past the rails. Reversing the span
 * reverses the chevron (two-way imports get one at each end).
 */
export function bridgeChevron(
  span: [{ gx: number; gy: number }, { gx: number; gy: number }],
  deck: BridgeDeck,
): BridgeChevron {
  const [a, b] = span;
  const len = Math.hypot(b.gx - a.gx, b.gy - a.gy);
  const ux = (b.gx - a.gx) / len;
  const uy = (b.gy - a.gy) / len;
  const cx = a.gx + (b.gx - a.gx) * 0.72;
  const cy = a.gy + (b.gy - a.gy) * 0.72;
  return {
    tip: { gx: cx + ux * 0.45, gy: cy + uy * 0.45 },
    wingA: { gx: cx - ux * 0.3 + deck.perp.gx * 0.8, gy: cy - uy * 0.3 + deck.perp.gy * 0.8 },
    wingB: { gx: cx - ux * 0.3 - deck.perp.gx * 0.8, gy: cy - uy * 0.3 - deck.perp.gy * 0.8 },
  };
}

/** Corner piece (bridge-corner.png): a mitered V composited from the
 * straight tiles at exactly +-atan(0.5), strips run frame-middle on
 * the axes exactly like addDeck (anchor 0.5), so rails continue
 * without a step at the butt joints. E opening (arms to the east);
 * the renderer mirrors it for W openings. Built by
 * /tmp/corner/surgery.mjs (kept, re-runnable): see the PR for the 8
 * failed generations that led to surgery. */
export const CORNER_TILE_H = 645; // built at straight-tile scale: height maps to targetH like the tiles
export const CORNER_DECK_W = 266; // deck band width in art px (bridge-a rows 234-500)
export const CORNER_ARM_LEN = 462; // vertex to arm tip along the arm axis, art px (2 tile units)
export const CORNER_ANCHOR = { x: 0.0224, y: 0.4564 }; // vertex (outer miter point) as art fractions
export const CORNER_OVERLAP_W = 0.2; // legs end this far (deck widths) inside the arms, hiding their cuts
export const CORNER_MIN_LEG = 0.5; // legs shorter than shorten + this (cells) keep straight tiles (no corner)

/** One deck height per import count, same in every direction. Single
 * source for the renderer (legs and corners scale together). */
export function cornerTargetH(count: number): number {
  return Math.min(62, 44 + 3 * Math.log2(count + 1));
}

/** How far each leg shortens toward its shore so the corner arms cover
 * the joint: arm length minus the overlap, in grid cells. */
export function cornerShortenCells(count: number, TW = 64): number {
  const scale = cornerTargetH(count) / CORNER_TILE_H;
  const worldPx = (CORNER_ARM_LEN - CORNER_OVERLAP_W * CORNER_DECK_W) * scale;
  return worldPx / (TW * Math.hypot(0.5, 0.25));
}

export interface GridPt { gx: number; gy: number }

export interface CornerKind { sharp: boolean; mirror: boolean; angleDeg: number }

/** Which way a bent 3-point path turns on screen. Sharp = interior
 * angle under 100 degrees (bent grid turns project to 53 or 127, a
 * clean split). Mirror = the V opens west (arms extend -x), so the
 * renderer flips the E-opening art. Pure: tested, renderer-agnostic. */
export function cornerKind(
  a: GridPt,
  elbow: GridPt,
  b: GridPt,
  project: (gx: number, gy: number) => [number, number],
): CornerKind {
  const [ex, ey] = project(elbow.gx, elbow.gy);
  const v1 = [project(a.gx, a.gy)[0] - ex, project(a.gx, a.gy)[1] - ey];
  const v2 = [project(b.gx, b.gy)[0] - ex, project(b.gx, b.gy)[1] - ey];
  const l1 = Math.hypot(v1[0], v1[1]);
  const l2 = Math.hypot(v2[0], v2[1]);
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2);
  const angleDeg = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
  return { sharp: angleDeg < 100, mirror: v1[0] + v2[0] < 0, angleDeg };
}

export interface CornerPlacement {
  gx: number; gy: number; // elbow grid point (corner vertex sits here)
  mirror: boolean; // V opens west: flip the art
  ends: [GridPt, GridPt, GridPt, GridPt]; // shortened legs: [p0, E1', E2', p2]
}

/** Corner placement for a bent 3-point deck path, or null when the
 * joint keeps straight tiles: wide turn, a leg too short to hold the
 * arms, or land anywhere in the joint disk (the straight tiles clip
 * around land, the corner sprite cannot, so it stays away). The legs
 * end inside the arms so the corner art covers their ragged tiling
 * cuts. isLand takes integer cells, same contract as waterSegments. */
export function cornerPlacement(
  points: [GridPt, GridPt, GridPt],
  count: number,
  project: (gx: number, gy: number) => [number, number],
  TW = 64,
  isLand?: (gx: number, gy: number) => boolean,
): CornerPlacement | null {
  const [p0, elbow, p2] = points;
  const kind = cornerKind(p0, elbow, p2, project);
  if (!kind.sharp) return null;
  const cells = cornerShortenCells(count, TW);
  const leg1 = Math.hypot(p0.gx - elbow.gx, p0.gy - elbow.gy);
  const leg2 = Math.hypot(p2.gx - elbow.gx, p2.gy - elbow.gy);
  if (leg1 <= cells + CORNER_MIN_LEG || leg2 <= cells + CORNER_MIN_LEG) return null;
  if (isLand) {
    // Joint disk: arm length plus half a deck width, in cells. Any
    // land inside vetoes the corner (conservative: the arms are thin
    // but land beside them still reads wrong under the sprite).
    const s = cornerTargetH(count) / CORNER_TILE_H;
    const r = ((CORNER_ARM_LEN + CORNER_DECK_W / 2) * s) / (TW * Math.hypot(0.5, 0.25));
    for (let dx = -r; dx <= r; dx += 0.3) {
      for (let dy = -r; dy <= r; dy += 0.3) {
        if (dx * dx + dy * dy > r * r) continue;
        if (isLand(Math.floor(elbow.gx + dx), Math.floor(elbow.gy + dy))) return null;
      }
    }
  }
  const toward = (from: GridPt, to: GridPt): GridPt => {
    const dx = to.gx - from.gx;
    const dy = to.gy - from.gy;
    const len = Math.hypot(dx, dy);
    return { gx: from.gx + (dx / len) * cells, gy: from.gy + (dy / len) * cells };
  };
  return { gx: elbow.gx, gy: elbow.gy, mirror: kind.mirror, ends: [p0, toward(elbow, p0), toward(elbow, p2), p2] };
}

export interface CornerDecision {
  legs: [GridPt, GridPt][]; // leg spans for waterSegments: full or shortened
  corner: { gx: number; gy: number; mirror: boolean } | null;
}

/** The renderer's whole per-pair corner choice as one pure function
 * (tested; renderCity only draws what this returns). Without the
 * sprite art, or for straight paths, wide turns, short legs, or land
 * in the joint: full legs, no corner. Otherwise shortened legs plus
 * the corner record. */
export function cornerDecision(
  points: GridPt[],
  count: number,
  project: (gx: number, gy: number) => [number, number],
  TW: number,
  opts: { art: boolean; isLand?: (gx: number, gy: number) => boolean },
): CornerDecision {
  if (!opts.art || points.length !== 3) {
    const legs: [GridPt, GridPt][] = [];
    for (let i = 0; i + 1 < points.length; i++) legs.push([points[i], points[i + 1]]);
    return { legs, corner: null };
  }
  const placement = cornerPlacement(
    points as [GridPt, GridPt, GridPt],
    count,
    project,
    TW,
    opts.isLand,
  );
  if (!placement) {
    const [p0, elbow, p2] = points;
    return { legs: [[p0, elbow], [elbow, p2]], corner: null };
  }
  const [p0, e1, e2, p2] = placement.ends;
  return {
    legs: [[p0, e1], [e2, p2]],
    corner: { gx: placement.gx, gy: placement.gy, mirror: placement.mirror },
  };
}

/** Isometric projection for a city of any size (same math as the test map). */
export function cityProjector(layout: { cols: number; rows: number }, TW: number) {
  const TH = TW / 2;
  const ox = (layout.rows * TW) / 2 + TW;
  const oy = TW * 1.2;
  return {
    TW,
    TH,
    project: (gx: number, gy: number): [number, number] => [
      ox + ((gx - gy) * TW) / 2,
      oy + ((gx + gy) * TH) / 2,
    ],
    width: Math.ceil(((layout.cols + layout.rows) * TW) / 2 + TW * 2),
    height: Math.ceil(((layout.cols + layout.rows) * TH) / 2 + TW * 2.4),
  };
}
