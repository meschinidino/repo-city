import { clonePixels, type PixelData } from "./pixels";

/** Key out magenta (#FF00FF) exactly as prototype/sprite-spike/index.html `keyed`. */
export function keyMagenta(img: PixelData): PixelData {
  const out = clonePixels(img);
  const p = out.data;
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i], g = p[i + 1], b = p[i + 2];
    const m = Math.min(r, b) - g;
    if (m > 105 && Math.abs(r - b) < 90) { p[i + 3] = 0; continue; }
    if (m > 25 && Math.abs(r - b) < 110) {
      const s = m - 25;
      p[i] = Math.max(0, r - s);
      p[i + 2] = Math.max(0, b - s);
      if (m > 60) p[i + 3] = Math.round((255 * (105 - m)) / 45);
    }
  }
  return out;
}

export function isCyan(r: number, g: number, b: number): boolean {
  return g > 165 && b > 165 && r < 120 && Math.abs(g - b) < 70;
}

/** Key out the cyan footprint plate and despill its edge (prototype `plate`, second half). Mutates a clone. */
export function keyCyanPlate(img: PixelData): PixelData {
  const out = clonePixels(img);
  const p = out.data;
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i], g = p[i + 1], b = p[i + 2];
    if (p[i + 3] === 0) continue;
    if (isCyan(r, g, b)) { p[i + 3] = 0; continue; }
    const m = Math.min(g, b) - r;
    if (m > 70 && Math.abs(g - b) < 70) {
      const k = m - 70;
      p[i + 1] = Math.max(0, g - k);
      p[i + 2] = Math.max(0, b - k);
      p[i + 3] = Math.min(p[i + 3], Math.round(255 * Math.max(0, 1 - (m - 70) / 90)));
    }
  }
  return out;
}
