import { land } from "./world";

/** 1:-x 2:-y 4:+x 8:+y water — order matches prototype COAST_MASK / CNAMES. */
export const COAST_MASK = [1, 2, 4, 8, 3, 6, 12, 9, 15, 0, 7, 13];
export const COAST_NAMES = ["Shore UL", "Shore UR", "Shore LR", "Shore LL", "Corner top", "Corner right", "Corner bottom", "Corner left", "Islet", "Plain grass", "No LL", "No UR"];
export const PLAIN_GRASS_INDEX = 9;

export function coastMask(gx: number, gy: number): number {
  return (land(gx - 1, gy) ? 0 : 1) | (land(gx, gy - 1) ? 0 : 2) | (land(gx + 1, gy) ? 0 : 4) | (land(gx, gy + 1) ? 0 : 8);
}
export function nearestCoastIndex(mask: number): { index: number; distance: number; exact: boolean } {
  let best = PLAIN_GRASS_INDEX, bd = 99;
  COAST_MASK.forEach((cm, i) => {
    let d = 0, v = cm ^ mask;
    while (v) { d += v & 1; v >>= 1; }
    if (d < bd) { bd = d; best = i; }
  });
  return { index: mask === 0 ? PLAIN_GRASS_INDEX : best, distance: bd, exact: COAST_MASK.includes(mask) };
}
/** Index into fitted coast tiles for a land cell (prototype scene rule). */
export function coastTileIndex(gx: number, gy: number): number {
  const m = coastMask(gx, gy);
  return m === 0 ? PLAIN_GRASS_INDEX : nearestCoastIndex(m).index;
}
