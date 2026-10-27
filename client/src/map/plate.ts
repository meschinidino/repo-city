import { isCyan, keyCyanPlate } from "./colorKey";
import type { PixelData, Pt } from "./pixels";

export interface Plate { L: Pt; R: Pt; B: Pt; T: Pt; band: number; out: number; reach: number }
export type Footprint = [number, number];

export interface MeasuredResult { plate: Plate | null; keyed: PixelData }

/** Measure cyan plate corners + overhang/reach, then key the plate out. Port of prototype `plate`. */
export function measurePlate(sprite: PixelData): MeasuredResult {
  const { width: w, height: h, data: p } = sprite;
  let L: Pt | null = null, R: Pt | null = null, B: Pt | null = null, n = 0;
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
    const i = (y * w + xx) * 4;
    if (p[i + 3] < 120 || !isCyan(p[i], p[i + 1], p[i + 2])) continue;
    n++;
    if (!L || xx < L[0] || (xx === L[0] && y < L[1])) L = [xx, y];
    if (!R || xx > R[0] || (xx === R[0] && y < R[1])) R = [xx, y];
    if (!B || y > B[1]) B = [xx, y];
  }
  if (n < 200 || !L || !R || !B) return { plate: null, keyed: sprite };
  let sx = 0, c = 0;
  for (let xx = 0; xx < w; xx++) for (let y = B[1] - 1; y <= B[1]; y++) {
    if (y < 0) continue;
    const i = (y * w + xx) * 4;
    if (p[i + 3] >= 120 && isCyan(p[i], p[i + 1], p[i + 2])) { sx += xx; c++; }
  }
  B = [c ? sx / c : B[0], B[1]];
  const T: Pt = [L[0] + R[0] - B[0], L[1] + R[1] - B[1]];
  const inside = (px: number, py: number) => {
    const q = [T, R!, B!, L!]; let sgn = 0;
    for (let k = 0; k < 4; k++) {
      const a = q[k], b = q[(k + 1) % 4];
      const cr = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
      if (cr !== 0) { if (sgn && Math.sign(cr) !== sgn) return false; sgn = Math.sign(cr); }
    }
    return true;
  };
  let band = 0, out = 0;
  const lineY = (xx: number) => L![1] + ((R![1] - L![1]) * (xx - L![0])) / (R![0] - L![0]);
  const cxp = (L[0] + R[0]) / 2, cyp = (L[1] + R[1]) / 2;
  const rs: number[] = [];
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
    const i = (y * w + xx) * 4;
    if (p[i + 3] < 120 || isCyan(p[i], p[i + 1], p[i + 2]) || y < lineY(xx)) continue;
    band++;
    const r = Math.abs(xx - cxp) / ((R[0] - L[0]) / 2) + (y - cyp) / (B[1] - cyp);
    if (r < 0.95) rs.push(r);
    if (!inside(xx + 0.5, y + 0.5) && r > 1.03) out++;
  }
  rs.sort((a, b) => a - b);
  const reachRaw = rs.length ? rs[Math.floor(rs.length * 0.995)] : 1;
  const plate: Plate = { L, R, B, T, band, out, reach: Math.max(0.5, Math.min(reachRaw, 1.2)) };
  return { plate, keyed: keyCyanPlate(sprite) };
}

/** Candidate closest to measured plate ratio (log-space), as prototype `mk`. */
export function chooseFootprint(ratio: number, candidates: Footprint[]): { foot: Footprint; aspectErrorPct: number } {
  const sorted = candidates.slice().sort((a, b) => Math.abs(Math.log(ratio / (a[0] / a[1]))) - Math.abs(Math.log(ratio / (b[0] / b[1]))));
  const foot = sorted[0];
  return { foot, aspectErrorPct: Math.abs(ratio / (foot[0] / foot[1]) - 1) * 100 };
}

export function plateRatio(plate: Plate): number {
  const lw = Math.hypot(plate.B[0] - plate.L[0], plate.B[1] - plate.L[1]);
  const ld = Math.hypot(plate.R[0] - plate.B[0], plate.R[1] - plate.B[1]);
  return lw / ld;
}
export function overhangPct(plate: Plate): number {
  return plate.band ? (plate.out / plate.band) * 100 : 0;
}
