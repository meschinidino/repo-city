import { createPixels, type PixelData } from "./pixels";

export interface CutSprite extends PixelData { cell: number }
export interface ComponentsResult {
  sprites: CutSprite[];
  count: number;
  expected: number;
  merged: number;
  dropped: number;
  touching: number;
}

interface Comp { id: number; area: number; x0: number; y0: number; x1: number; y1: number; cx: number; cy: number; ids: number[]; cell?: number }

/** Connected components on the alpha mask; specks <1500px merge into nearest large shape within 40px. Port of prototype `components`. */
export function connectedComponents(k: PixelData, expected: number): ComponentsResult {
  const { width: W, height: H, data: p } = k;
  const lab = new Int32Array(W * H);
  const comps: Comp[] = [];
  let n = 0;
  const st = new Int32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (lab[i] || p[i * 4 + 3] <= 40) continue;
    n++; let sp = 0; st[sp++] = i; lab[i] = n;
    let area = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, sx = 0, sy = 0;
    while (sp) {
      const j = st[--sp]; area++;
      const xx = j % W, yy = (j / W) | 0; sx += xx; sy += yy;
      x0 = Math.min(x0, xx); x1 = Math.max(x1, xx); y0 = Math.min(y0, yy); y1 = Math.max(y1, yy);
      const nb = [j - 1, j + 1, j - W, j + W];
      for (const kk of nb) {
        if (kk < 0 || kk >= W * H) continue;
        if ((kk === j - 1 && xx === 0) || (kk === j + 1 && xx === W - 1)) continue;
        if (!lab[kk] && p[kk * 4 + 3] > 40) { lab[kk] = n; st[sp++] = kk; }
      }
    }
    comps.push({ id: n, area, x0, y0, x1, y1, cx: sx / area, cy: sy / area, ids: [n] });
  }
  const big = comps.filter((c) => c.area >= 1500);
  const small = comps.filter((c) => c.area < 1500);
  let merged = 0, dropped = 0;
  for (const s of small) {
    let best: Comp | null = null, bd = 1e9;
    for (const b of big) {
      const dx = Math.max(b.x0 - s.x1, 0, s.x0 - b.x1);
      const dy = Math.max(b.y0 - s.y1, 0, s.y0 - b.y1);
      const d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = b; }
    }
    if (best && bd < 40) {
      best.ids.push(s.id);
      best.x0 = Math.min(best.x0, s.x0); best.y0 = Math.min(best.y0, s.y0);
      best.x1 = Math.max(best.x1, s.x1); best.y1 = Math.max(best.y1, s.y1);
      merged++;
    } else dropped++;
  }
  const cellOf = (c: Comp) => Math.min(2, Math.floor(((c.y0 + c.y1) / 2) / (H / 3))) * 4 + Math.min(3, Math.floor(((c.x0 + c.x1) / 2) / (W / 4)));
  const ordered = big.map((c) => ({ c, k: cellOf(c) })).sort((a, b) => a.k - b.k).map((o) => { o.c.cell = o.k; return o.c; });
  const touching = ordered.filter((c) => c.x0 <= 0 || c.y0 <= 0 || c.x1 >= W - 1 || c.y1 >= H - 1).length;
  const sprites: CutSprite[] = ordered.map((c) => {
    const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
    const out = createPixels(w, h) as CutSprite;
    out.cell = c.cell!;
    const set = new Set(c.ids);
    for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
      const si = (c.y0 + y) * W + (c.x0 + xx);
      if (set.has(lab[si])) {
        const s4 = si * 4, d4 = (y * w + xx) * 4;
        out.data[d4] = p[s4]; out.data[d4 + 1] = p[s4 + 1]; out.data[d4 + 2] = p[s4 + 2]; out.data[d4 + 3] = p[s4 + 3];
      }
    }
    return out;
  });
  return { sprites, count: ordered.length, expected, merged, dropped, touching };
}
