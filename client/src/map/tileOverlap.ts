import type { PixelData } from "./pixels";
import { TWBASE } from "./tileFit";

/**
 * Measured tile overlap: composite fitted tiles on the iso grid the
 * way the renderer does (east neighbour offset (+TW/2, +TW/4), south
 * neighbour (-TW/2, +TW/4) in tile-image space) and count sampled
 * pixels covered by the top faces of two or more tiles. A pixel is
 * on a tile's top face when it is opaque there and inside the exact
 * top diamond — the thickness sides below the diamond are meant to
 * be overdrawn by front neighbours, so they do not count.
 */
export interface OverlapMeasure {
  overlapPx: number;
  topPx: number;
  overlapPct: number;
}

const STEP = 4; // sample every 4th pixel; tiles are TWBASE wide

function topFaceCovers(tile: PixelData, lx: number, ly: number): boolean {
  if (lx < 0 || ly < 0 || lx >= tile.width || ly >= tile.height) return false;
  // inside the exact top diamond (centre TW/2, TW/4; radii TW/2, TW/4)
  if (Math.abs(lx - TWBASE / 2) / (TWBASE / 2) + Math.abs(ly - TWBASE / 4) / (TWBASE / 4) > 1) return false;
  return tile.data[(ly * tile.width + lx) * 4 + 3] > 160;
}

/** Overlap of `tile` with `east` and `south` neighbours placed on the grid. */
export function measureTileOverlap(tile: PixelData, east: PixelData, south: PixelData): OverlapMeasure {
  const placed: { img: PixelData; ox: number; oy: number }[] = [
    { img: tile, ox: 0, oy: 0 },
    { img: east, ox: TWBASE / 2, oy: TWBASE / 4 },
    { img: south, ox: -TWBASE / 2, oy: TWBASE / 4 },
  ];
  let overlapPx = 0;
  let topPx = 0;
  for (let y = 0; y < TWBASE; y += STEP) {
    for (let x = -TWBASE / 2; x < TWBASE * 1.5; x += STEP) {
      let covers = 0;
      for (const p of placed) {
        if (topFaceCovers(p.img, x - p.ox, y - p.oy)) covers++;
      }
      if (covers > 0) topPx++;
      if (covers > 1) overlapPx++;
    }
  }
  return { overlapPx, topPx, overlapPct: topPx ? (overlapPx / topPx) * 100 : 0 };
}

/** Worst arrangement: every fitted tile against every neighbour in
 * both the east and the south slot, mixed with itself. */
export function worstTileOverlap(tiles: PixelData[]): OverlapMeasure & { tile: number; east: number; south: number } {
  let worst: (OverlapMeasure & { tile: number; east: number; south: number }) | null = null;
  const consider = (m: OverlapMeasure, tile: number, east: number, south: number) => {
    // Seed from the first real measurement so a zero-overlap world
    // still reports the pixels that were actually sampled.
    if (!worst || m.overlapPct > worst.overlapPct) worst = { ...m, tile, east, south };
  };
  for (let i = 0; i < tiles.length; i++) {
    for (let e = 0; e < tiles.length; e++) {
      consider(measureTileOverlap(tiles[i], tiles[e], tiles[i]), i, e, i);
      consider(measureTileOverlap(tiles[i], tiles[i], tiles[e]), i, i, e);
    }
  }
  return worst ?? { overlapPx: 0, topPx: 0, overlapPct: 0, tile: -1, east: -1, south: -1 };
}
