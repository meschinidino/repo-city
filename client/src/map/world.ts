export const MAP = [
  "......................",
  "..gggg................",
  ".gggggg......gggggg...",
  ".ggtggg.....gggggggg..",
  ".gggggg.....ggggtggg..",
  "..ggggg.....gggggggg..",
  "...ggg......gggggggg..",
  "............ggtggggg..",
  ".............gggggg...",
  "......................",
  "......................",
  "......................",
  "..gggg................",
  ".gggggg...............",
  ".ggtggg...............",
  ".gggggg...............",
  "..gggg................",
  "......................",
];
export const COLS = MAP[0].length;
export const ROWS = MAP.length;
export const land = (gx: number, gy: number): boolean => !!(MAP[gy] && MAP[gy][gx] && MAP[gy][gx] !== ".");

export interface IslandDef { name: string; seed: [number, number]; label: [number, number]; list: [string, string?][] }
export const ISLANDS: IslandDef[] = [
  { name: "api", seed: [3, 3], label: [0.2, 6.6], list: [["gate", "gate"], ["lighthouse", "landmark"], ["containers"], ["ruin"], ["flags"], ["cottage"]] },
  { name: "payments", seed: [15, 5], label: [17.2, 10.4], list: [["keep", "landmark"], ["silos"], ["market"], ["cottage"], ["slate"], ["construction"], ["flags"]] },
  { name: "auth", seed: [3, 14], label: [3.8, 18.1], list: [["keep", "landmark"], ["slate"], ["ruin"], ["cottage"]] },
];
export const BRIDGES = [
  { a: [7, 4.5] as [number, number], b: [12, 4.5] as [number, number] },
  { a: [3.5, 7] as [number, number], b: [3.5, 12] as [number, number] },
];
export const SHIPS: [number, number][] = [[10, 7.5], [8, 14]];
export const LANE: [number, number][] = [[6.6, 14.6], [9.5, 12.6], [12.4, 10.2], [14.4, 9.1]];

export function islandCells(seed: [number, number]): [number, number][] {
  const seen = new Set<string>(), q: [number, number][] = [seed], out: [number, number][] = [];
  while (q.length) {
    const [x, y] = q.pop()!;
    const k = x + "," + y;
    if (seen.has(k) || !land(x, y)) continue;
    seen.add(k); out.push([x, y]);
    q.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return out;
}

/** Isometric projection shared by Pixi rendering and geometry checks. */
export function projector(TW: number) {
  const TH = TW / 2;
  const ox = (ROWS * TW) / 2 + TW / 2, oy = TW * 1.6;
  return {
    TW, TH, ox, oy,
    project: (gx: number, gy: number): [number, number] => [ox + ((gx - gy) * TW) / 2, oy + ((gx + gy) * TH) / 2],
    width: Math.ceil(((COLS + ROWS) * TW) / 2 + TW),
    height: Math.ceil(((COLS + ROWS) * TH) / 2 + TW * 2.2),
  };
}
