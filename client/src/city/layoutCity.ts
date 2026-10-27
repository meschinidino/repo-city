// Data-driven city layout (T7 first slice): islands from a real
// extraction, shelf-packed on the iso grid with water between them.
// Every building sits on a 2x2 plot (the largest sprite footprint),
// row-major inside its island. Layout is frozen once computed —
// districts never move while a session works (design: map stability).

import type { Extraction } from "./types";

export const PLOT = 2; // cells per building plot edge
export const GAP_PLOTS = 2; // water between islands, in plots (4 cells)

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
    const x = cursorX * PLOT;
    const y = cursorY * PLOT;
    // Occupied plot cells in island-local coords: the shape must
    // keep every one of them as land.
    const mustKeep = new Set<string>();
    files.forEach((f, i) => {
      const lx = testOnly ? i % (cols * PLOT) : (i % cols) * PLOT;
      const ly = testOnly ? Math.floor(i / (cols * PLOT)) % (rows * PLOT) : Math.floor(i / cols) * PLOT;
      for (let dy = 0; dy < (testOnly ? 1 : PLOT); dy++)
        for (let dx = 0; dx < (testOnly ? 1 : PLOT); dx++) mustKeep.add(lx + dx + "," + (ly + dy));
    });
    // The shape runs over the plot area plus a one-cell shore
    // margin on every side. Buildings keep one free cell around
    // them (DESIGN.md layout rule), and the margin is where the
    // organic outline can actually cut: without it, edge plots
    // force a rectangle.
    const localShape = islandShape(isl.id, cols * PLOT + 2, rows * PLOT + 2, new Set([...mustKeep].map((k) => {
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
      const gx = testOnly ? x + (i % (cols * PLOT)) : x + (i % cols) * PLOT;
      const gy = testOnly
        ? y + (Math.floor(i / (cols * PLOT)) % (rows * PLOT))
        : y + Math.floor(i / cols) * PLOT;
      buildings.push({ file: f.path, islandId: isl.id, building: f.building, gx, gy });
      fileToIsland.set(f.path, isl.id);
      filePos.set(f.path, { gx, gy, islandId: isl.id });
    });
    cursorX += cols + GAP_PLOTS;
    shelfH = Math.max(shelfH, rows);
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
