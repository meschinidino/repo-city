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
    const cols = Math.ceil(Math.sqrt(files.length));
    const rows = Math.ceil(files.length / cols);
    if (cursorX > 0 && cursorX + cols > shelfPlots) {
      cursorX = 0;
      cursorY += shelfH + GAP_PLOTS;
      shelfH = 0;
    }
    const x = cursorX * PLOT;
    const y = cursorY * PLOT;
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
    };
    placed.push(island);
    files.forEach((f, i) => {
      const gx = x + (i % cols) * PLOT;
      const gy = y + Math.floor(i / cols) * PLOT;
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
