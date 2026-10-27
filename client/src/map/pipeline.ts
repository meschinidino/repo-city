import { keyMagenta } from "./colorKey";
import { connectedComponents, type ComponentsResult } from "./components";
import { measurePlate, chooseFootprint, plateRatio, overhangPct, type Plate } from "./plate";
import { tileFit, fitTile, type TileFit } from "./tileFit";
import { layout, type LayoutResult } from "./layout";
import { BFOOT, BKEYS, BNAMES, EXPECTED, XFOOT, XKEYS, XNAMES } from "./sheets";
import { COAST_NAMES } from "./coast";
import { PASS } from "./checks";
import type { PixelData } from "./pixels";
import type { Footprint } from "./plate";

export interface BuiltSprite extends PixelData {
  name: string; key: string; foot: Footprint; plate: Plate | null;
  ratio?: number; aspectErrorPct?: number; overhangPct?: number;
}
export interface FittedTile extends PixelData { name: string; gap: number; err: number; srcErr: number; fit: TileFit }
export interface World {
  buildings: ComponentsResult; coast: ComponentsResult; shipComp: ComponentsResult; marketTrees: ComponentsResult;
  sprites: BuiltSprite[];
  ship: PixelData;
  rawTiles: (PixelData & { name: string })[];
  fits: TileFit[];
  medianThick: number;
  tiles: FittedTile[];
  layout: LayoutResult;
}

export interface SheetPixels { buildings: PixelData; coast: PixelData; ship: PixelData; marketTrees: PixelData }

function makeSprite(cut: PixelData, name: string, key: string, candidates: Footprint[]): BuiltSprite {
  const { plate, keyed } = measurePlate(cut);
  const base: BuiltSprite = { ...keyed, name, key, foot: candidates[0], plate };
  if (!plate) return base;
  const ratio = plateRatio(plate);
  const { foot, aspectErrorPct } = chooseFootprint(ratio, candidates);
  base.foot = foot; base.ratio = ratio; base.aspectErrorPct = aspectErrorPct; base.overhangPct = overhangPct(plate);
  return base;
}

/** Full pipeline on decoded sheets. Pure: browser feeds ImageData, tests feed PNG pixels. */
export function buildWorld(sheets: SheetPixels): World {
  const buildings = connectedComponents(keyMagenta(sheets.buildings), EXPECTED.buildings);
  const coast = connectedComponents(keyMagenta(sheets.coast), EXPECTED.coast);
  const shipComp = connectedComponents(keyMagenta(sheets.ship), EXPECTED.ship);
  const marketTrees = connectedComponents(keyMagenta(sheets.marketTrees), EXPECTED.marketTrees);

  const sprites: BuiltSprite[] = [
    ...buildings.sprites.map((s, i) => makeSprite(s, BNAMES[i], BKEYS[i], [BFOOT[i]])),
    ...marketTrees.sprites.map((s, i) => makeSprite(s, XNAMES[i], XKEYS[i], XFOOT[i])),
  ];
  const markets = sprites.filter((s) => s.key === "market2" || s.key === "market3").sort((a, b) => (a.aspectErrorPct ?? 99) - (b.aspectErrorPct ?? 99));
  if (markets[0]) markets[0].key = "market";

  const rawTiles = coast.sprites.map((s, i) => ({ ...s, name: COAST_NAMES[i] }));
  const fits = rawTiles.map((s) => tileFit(s));
  const thicks = fits.map((f) => f.thick).sort((a, b) => a - b);
  const medianThick = thicks[Math.floor(thicks.length / 2)];
  const tiles: FittedTile[] = rawTiles.map((s, i) => {
    const t = fitTile(s, fits[i], medianThick);
    return { ...t.image, name: s.name, gap: t.gap, err: t.err, srcErr: t.srcErr, fit: fits[i] };
  });

  return {
    buildings, coast, shipComp, marketTrees, sprites,
    ship: shipComp.sprites[0],
    rawTiles, fits, medianThick, tiles,
    layout: layout(sprites),
  };
}

/**
 * Fail-level geometry checks from DESIGN.md, as the render gate: a
 * non-empty result means the client must not render and must name
 * the failing checks. Kept beside the pipeline so tests exercise the
 * exact list the page enforces.
 */
export function renderGateFailures(world: World): string[] {
  const failures: string[] = [];
  const used = usedSprites(world);
  const count = world.buildings.count + world.coast.count + world.shipComp.count + world.marketTrees.count;
  if (count !== 36) failures.push(`sprites found (${count}/36)`);
  if (world.buildings.touching + world.coast.touching + world.shipComp.touching + world.marketTrees.touching !== 0) failures.push("sprites cropped at sheet edge");
  if (Math.max(...used.map((s) => s.aspectErrorPct ?? Infinity)) >= PASS.plateShapePct) failures.push("plate shape vs footprint");
  if (Math.max(...used.map((s) => s.overhangPct ?? Infinity)) >= PASS.baseOutsidePct) failures.push("base outside footprint");
  const edge = Math.max(...world.tiles.map((t) => t.err));
  if (edge >= PASS.tileEdgePct) failures.push(`tile edge error ${edge.toFixed(2)}%`);
  if (Math.max(...world.tiles.map((t) => t.gap)) >= PASS.tileGapPct) failures.push("gaps inside tile top face");
  if (world.layout.overlaps || world.layout.offLand || world.layout.onRoad) failures.push("footprint overlap/off-land/bridge landing");
  if (world.layout.failed !== 0) failures.push(`buildings that found no place (${world.layout.failed})`);
  if (world.layout.crowd !== 0) failures.push("building without one free cell");
  if (world.layout.treeOnFoot || world.layout.treeFront) failures.push("tree placement");
  return failures;
}

export function usedSprites(world: World): BuiltSprite[] {
  const keys = new Set<string>(["tree"]);
  // island lists are in world.ts; collect keys directly to avoid a cycle
  for (const k of ["gate", "lighthouse", "containers", "ruin", "flags", "cottage", "keep", "silos", "market", "slate", "construction"]) keys.add(k);
  return world.sprites.filter((s) => keys.has(s.key));
}
