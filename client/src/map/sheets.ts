import type { Footprint } from "./plate";

export const BNAMES = ["Keep", "Sea gate", "Silos", "Lighthouse", "Cottage", "Cottage (slate)", "Market", "Containers", "Ruin", "Flags", "Construction"];
export const BKEYS = ["keep", "gate", "silos", "lighthouse", "cottage", "slate", "market-old", "containers", "ruin", "flags-old", "construction"];
export const BFOOT: Footprint[] = [[2, 2], [1, 1], [2, 2], [1, 1], [1, 1], [1, 1], [2, 1], [1, 1], [1, 1], [1, 1], [1, 1]];
export const XNAMES = ["Market 2×1", "Market 3×1", "Flags", "Pine", "Broad-leaf tree", "Three pines", "Bushes", "Birch", "Cypress", "Autumn tree", "Flowering bush", "Boulder + sapling"];
export const XKEYS = ["market2", "market3", "flags", "tree", "tree", "tree", "tree", "tree", "tree", "tree", "tree", "tree"];
export const XFOOT: Footprint[][] = [[[2, 1], [3, 1]], [[3, 1], [2, 1]], [[1, 1]], [[1, 1]], [[1, 1]], [[1, 1]], [[1, 1]], [[1, 1]], [[1, 1]], [[1, 1]], [[1, 1]], [[1, 1]]];
export const EXPECTED = { buildings: 11, coast: 12, ship: 1, marketTrees: 12 };
