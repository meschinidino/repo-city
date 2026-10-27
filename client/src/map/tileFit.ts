import { createPixels, type PixelData, type Pt } from "./pixels";

export interface TileFit { T: Pt; L: Pt; R: Pt; B: Pt; thick: number; aspect: number; skew: number; tilt: number; edgeErr: number }

interface Line { m: number; c: number }
function fitLineLS(pts: { x: number; y: number }[]): Line {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const { x, y } of pts) { n++; sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const m = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { m, c: (sy - m * sx) / n };
}
export const TWBASE = 1000;

/** Port of prototype `tileFit` (least-squares lines over the middle 60% of each upper edge). */
export function tileFit(s: PixelData): TileFit {
  const { width: w, height: h, data: p } = s;
  const a = (xx: number, y: number) => p[(y * w + xx) * 4 + 3] > 160;
  const top = new Array<number>(w).fill(-1);
  const bot = new Array<number>(w).fill(-1);
  for (let xx = 0; xx < w; xx++) {
    for (let y = 0; y < h; y++) if (a(xx, y)) { top[xx] = y; break; }
    for (let y = h - 1; y >= 0; y--) if (a(xx, y)) { bot[xx] = y; break; }
  }
  let minx = 0; while (top[minx] < 0) minx++;
  let maxx = w - 1; while (top[maxx] < 0) maxx--;
  let tx = minx;
  for (let xx = minx; xx <= maxx; xx++) if (top[xx] >= 0 && top[xx] < top[tx]) tx = xx;
  const seg = (x0: number, x1: number) => {
    const pts: { x: number; y: number }[] = [];
    for (let xx = Math.round(x0); xx <= Math.round(x1); xx++) if (top[xx] >= 0) pts.push({ x: xx, y: top[xx] });
    return fitLineLS(pts);
  };
  const mid = (minx + maxx) / 2;
  let Lf = seg(minx + (mid - minx) * 0.2, minx + (mid - minx) * 0.8);
  let Rf = seg(mid + (maxx - mid) * 0.2, mid + (maxx - mid) * 0.8);
  let Tx = (Rf.c - Lf.c) / (Lf.m - Rf.m);
  Lf = seg(minx + (Tx - minx) * 0.2, minx + (Tx - minx) * 0.8);
  Rf = seg(Tx + (maxx - Tx) * 0.2, Tx + (maxx - Tx) * 0.8);
  Tx = (Rf.c - Lf.c) / (Lf.m - Rf.m);
  const T: Pt = [Tx, Lf.m * Tx + Lf.c];
  const width0 = maxx - minx;
  let lx = minx; while (lx < Tx && Math.abs(top[lx] - (Lf.m * lx + Lf.c)) > width0 * 0.03) lx++;
  let rx = maxx; while (rx > Tx && Math.abs(top[rx] - (Rf.m * rx + Rf.c)) > width0 * 0.03) rx--;
  const L: Pt = [lx, Lf.m * lx + Lf.c];
  const R: Pt = [rx, Rf.m * rx + Rf.c];
  const B: Pt = [L[0] + R[0] - T[0], L[1] + R[1] - T[1]];
  let edgeErr = 0;
  for (let xx = Math.round(lx + (Tx - lx) * 0.15); xx <= Math.round(rx - (rx - Tx) * 0.15); xx++) {
    if (top[xx] < 0 || Math.abs(xx - Tx) < (rx - lx) * 0.08) continue;
    const pred = xx < Tx ? Lf.m * xx + Lf.c : Rf.m * xx + Rf.c;
    edgeErr = Math.max(edgeErr, Math.abs(top[xx] - pred));
  }
  const th: number[] = [];
  for (let xx = Math.round(L[0] + 4); xx <= Math.round(R[0] - 4); xx++) {
    if (bot[xx] < 0) continue;
    const ey = xx < B[0] ? L[1] + ((B[1] - L[1]) * (xx - L[0])) / (B[0] - L[0]) : B[1] + ((R[1] - B[1]) * (xx - B[0])) / (R[0] - B[0]);
    th.push(bot[xx] - ey);
  }
  th.sort((u, v) => u - v);
  const width = R[0] - L[0];
  return { T, L, R, B, thick: (th[Math.floor(th.length / 2)] || 0) / width, aspect: width / (B[1] - T[1]), skew: (T[0] - (L[0] + R[0]) / 2) / width, tilt: (R[1] - L[1]) / width, edgeErr: (edgeErr / width) * 100 };
}

export interface Affine { A: number; B: number; C: number; D: number; E: number; F: number; worst: number }
/** Least-squares affine from 4 source to 4 destination corners. Port of prototype `affine4`. */
export function affine4(src: Pt[], dst: Pt[]): Affine {
  const solve = (k: 0 | 1) => {
    const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    src.forEach((q, i) => {
      const r = [q[0], q[1], 1];
      for (let u = 0; u < 3; u++) { b[u] += r[u] * dst[i][k]; for (let v = 0; v < 3; v++) a[u][v] += r[u] * r[v]; }
    });
    const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const Dd = det(a);
    return [0, 1, 2].map((cc) => det(a.map((row, ri) => row.map((v, ci) => (ci === cc ? b[ri] : v)))) / Dd);
  };
  const X = solve(0), Y = solve(1);
  let worst = 0;
  src.forEach((q, i) => {
    const px = X[0] * q[0] + X[1] * q[1] + X[2], py = Y[0] * q[0] + Y[1] * q[1] + Y[2];
    worst = Math.max(worst, Math.hypot(px - dst[i][0], py - dst[i][1]));
  });
  return { A: X[0], C: X[1], E: X[2], B: Y[0], D: Y[1], F: Y[2], worst };
}

function invertAffine(f: Affine): Affine {
  const det = f.A * f.D - f.B * f.C;
  const A = f.D / det, B = -f.B / det, C = -f.C / det, D = f.A / det;
  return { A, B, C, D, E: -(A * f.E + C * f.F), F: -(B * f.E + D * f.F), worst: 0 };
}
function inPolygon(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ideal top-diamond upper-edge y for column x in fitted-tile space. */
export function diamondTopY(x: number, w = TWBASE): number {
  return Math.abs(x - w / 2) / 2;
}

/** Worst deviation of a fitted tile's top silhouette from the exact diamond, as % of tile width. Same sampling exclusions as prototype `tileFit`. */
export function fittedEdgeError(img: PixelData): number {
  const w = img.width;
  const top = new Array<number>(w).fill(-1);
  for (let xx = 0; xx < w; xx++) for (let y = 0; y < img.height; y++) if (img.data[(y * w + xx) * 4 + 3] > 160) { top[xx] = y; break; }
  let worst = 0;
  for (let xx = Math.round(w * 0.075); xx <= Math.round(w * 0.925); xx++) {
    if (top[xx] < 0 || Math.abs(xx - w / 2) < w * 0.08) continue;
    worst = Math.max(worst, Math.abs(top[xx] - diamondTopY(xx, w)));
  }
  return (worst / w) * 100;
}

/**
 * Warp a tile onto the exact diamond, straighten its upper edges, and clip to the shared tile shape.
 * Port of prototype `fitTile`, plus the T11 improvement: after the affine warp, each column is shifted
 * vertically by the smoothed (41-column moving average) residual between its real top edge and the ideal
 * diamond edge. That removes the low-frequency edge wander the affine fit cannot; the clip then bounds the rest.
 * `err` is the post-fit error measured on the result; `srcErr` is the prototype's pre-fit number.
 */
export function fitTile(s: PixelData, f: TileFit, thick: number): { image: PixelData; gap: number; err: number; srcErr: number } {
  const w = TWBASE, h = w / 2, th = thick * w;
  const outH = Math.ceil(h + th) + 2;
  const warped = createPixels(w, outH);
  const OV = 1.02, cxd = w / 2, cyd = h / 2;
  const grow = (q: Pt): Pt => [cxd + (q[0] - cxd) * OV, cyd + (q[1] - cyd) * OV];
  const fit = affine4([f.T, f.R, f.B, f.L], [grow([w / 2, 0]), grow([w, h / 2]), grow([w / 2, h]), grow([0, h / 2])]);
  const inv = invertAffine(fit);
  const shape: Pt[] = [[w / 2, 0], [w, h / 2], [w, h / 2 + th], [w / 2, h + th], [0, h / 2 + th], [0, h / 2]];
  for (let y = 0; y < outH; y++) for (let x = 0; x < w; x++) {
    if (!inPolygon(x + 0.5, y + 0.5, shape)) continue;
    const sx = inv.A * x + inv.C * y + inv.E, sy = inv.B * x + inv.D * y + inv.F;
    const x0 = Math.floor(sx), y0 = Math.floor(sy);
    if (x0 < 0 || y0 < 0 || x0 >= s.width || y0 >= s.height) continue;
    const si = (y0 * s.width + x0) * 4, di = (y * w + x) * 4;
    warped.data[di] = s.data[si]; warped.data[di + 1] = s.data[si + 1]; warped.data[di + 2] = s.data[si + 2]; warped.data[di + 3] = s.data[si + 3];
  }
  // edge straightening: per-column residual to the ideal diamond, smoothed so grass tufts do not tear the texture
  const residual = new Array<number>(w).fill(0);
  for (let xx = 0; xx < w; xx++) {
    let topY = -1;
    for (let y = 0; y < outH; y++) if (warped.data[(y * w + xx) * 4 + 3] > 160) { topY = y; break; }
    residual[xx] = topY < 0 ? 0 : topY - diamondTopY(xx, w);
  }
  const WIN = 41, half = (WIN - 1) / 2;
  const smooth = residual.map((_, xx) => {
    let sum = 0, cnt = 0;
    for (let k = -half; k <= half; k++) { const j = xx + k; if (j >= 0 && j < w) { sum += residual[j]; cnt++; } }
    return Math.round(sum / cnt);
  });
  const out = createPixels(w, outH);
  for (let xx = 0; xx < w; xx++) {
    const dy = smooth[xx];
    for (let y = 0; y < outH; y++) {
      const sy = y + dy;
      if (sy < 0 || sy >= outH) continue;
      if (!inPolygon(xx + 0.5, y + 0.5, shape)) continue;
      const si = (sy * w + xx) * 4, di = (y * w + xx) * 4;
      out.data[di] = warped.data[si]; out.data[di + 1] = warped.data[si + 1]; out.data[di + 2] = warped.data[si + 2]; out.data[di + 3] = warped.data[si + 3];
    }
  }
  let inD = 0, gap = 0;
  for (let yy = 1; yy < h - 1; yy += 2) for (let xx = 1; xx < w - 1; xx += 2) {
    if (Math.abs(xx - w / 2) / (w / 2) + Math.abs(yy - h / 2) / (h / 2) > 0.985) continue;
    inD++; if (out.data[(yy * w + xx) * 4 + 3] < 200) gap++;
  }
  return { image: out, gap: inD ? (gap / inD) * 100 : 0, err: fittedEdgeError(out), srcErr: f.edgeErr };
}
