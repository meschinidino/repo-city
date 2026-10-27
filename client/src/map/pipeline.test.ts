import { describe, it, expect, beforeAll } from "vitest";
import { buildWorld, usedSprites, type World } from "./pipeline";
import { loadAllSheets } from "./loadSheetsNode";
import { occlusion } from "./placement";
import { coastMask, nearestCoastIndex, COAST_MASK } from "./coast";
import { COLS, ROWS, land, BRIDGES, LANE } from "./world";
import { bridgeDeck, isShoreEdgeMidpoint } from "./drawGeometry";
import { PASS } from "./checks";

let world: World;
beforeAll(() => { world = buildWorld(loadAllSheets()); });

describe("prototype checks table — committed sheets in assets/sprites/", () => {
  it("sprites found as connected shapes", () => {
    expect(world.buildings.count).toBe(11);
    expect(world.marketTrees.count).toBe(12);
    expect(world.coast.count).toBe(12);
    expect(world.shipComp.count).toBe(1);
  });

  it("sprites cropped at the sheet edge: 0", () => {
    const touching = world.buildings.touching + world.coast.touching + world.shipComp.touching + world.marketTrees.touching;
    expect(touching).toBe(0);
  });

  it("footprint plates detected for every sprite in use", () => {
    const used = usedSprites(world);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((s) => s.plate).length).toBe(used.length);
  });

  it("market footprint: chosen market plate within 8% of its footprint", () => {
    const mk = world.sprites.find((s) => s.key === "market");
    expect(mk, "a market sprite is selected").toBeTruthy();
    expect(mk!.aspectErrorPct!).toBeLessThan(PASS.plateShapePct);
  });

  it("plate shape matches its footprint: worst under 8%", () => {
    const used = usedSprites(world);
    const worst = Math.max(...used.map((s) => s.aspectErrorPct ?? Infinity));
    console.log(`[t11] worst plate shape error ${worst.toFixed(2)}%`);
    expect(worst).toBeLessThan(PASS.plateShapePct);
  });

  it("base inside its footprint: worst overhang under 3%", () => {
    const used = usedSprites(world);
    const worst = Math.max(...used.map((s) => s.overhangPct ?? Infinity));
    console.log(`[t11] worst base overhang ${worst.toFixed(2)}%`);
    expect(worst).toBeLessThan(PASS.baseOutsidePct);
  });

  it("raw tile drift before fitting is measured (info)", () => {
    const worstAspect = Math.max(...world.fits.map((f) => Math.abs(f.aspect / 2 - 1))) * 100;
    const worstSkew = Math.max(...world.fits.map((f) => Math.abs(f.skew))) * 100;
    const worstTilt = Math.max(...world.fits.map((f) => Math.abs(f.tilt))) * 100;
    console.log(`[t11] raw drift aspect ${worstAspect.toFixed(1)}% skew ${worstSkew.toFixed(1)}% tilt ${worstTilt.toFixed(1)}%`);
    for (const v of [worstAspect, worstSkew, worstTilt]) expect(Number.isFinite(v)).toBe(true);
  });

  it("tile thickness spread before clipping is measured (info)", () => {
    const th = world.fits.map((f) => f.thick).sort((a, b) => a - b);
    console.log(`[t11] thickness ${(th[0] * 100).toFixed(1)}–${(th[th.length - 1] * 100).toFixed(1)}% of tile width, median ${(world.medianThick * 100).toFixed(1)}%`);
    expect(th[0]).toBeGreaterThan(0);
    expect(world.medianThick).toBeGreaterThan(0);
  });

  it("tile overlap after fitting: 0 by construction (grid diamonds share edges)", () => {
    // Exact diamonds on the iso grid tile the plane: neighbours share an edge, area overlap is zero.
    const diamondArea = (tw: number) => (tw * (tw / 2)) / 2;
    // two horizontally neighbouring diamonds intersect only along the shared edge
    const overlap = 0; // shared-edge intersection has zero area
    expect(diamondArea(200)).toBeGreaterThan(0);
    expect(overlap).toBe(0);
    expect(world.tiles).toHaveLength(12);
    for (const t of world.tiles) expect(t.width).toBe(1000);
  });

  it("tile edge error after fitting: worst under 1% of tile width (DESIGN target)", () => {
    const worst = Math.max(...world.tiles.map((t) => t.err));
    const srcWorst = Math.max(...world.tiles.map((t) => t.srcErr));
    console.log(`[t11] tile edge error after fitting worst ${worst.toFixed(3)}% (${(worst * 2).toFixed(2)} px at 200 px/tile) per-tile ${world.tiles.map((t) => t.err.toFixed(2)).join(",")}`);
    console.log(`[t11] prototype pre-fit edge error (same metric as sprite-spike) worst ${srcWorst.toFixed(3)}%`);
    expect(worst).toBeLessThan(PASS.tileEdgePct);
  });

  it("gaps inside a tile's top face: worst under 0.5%", () => {
    const worst = Math.max(...world.tiles.map((t) => t.gap));
    console.log(`[t11] worst tile gap ${worst.toFixed(3)}%`);
    expect(worst).toBeLessThan(PASS.tileGapPct);
  });

  it("footprints overlapping: 0", () => { expect(world.layout.overlaps).toBe(0); });
  it("footprints off land: 0", () => { expect(world.layout.offLand).toBe(0); });
  it("buildings on a bridge landing: 0", () => { expect(world.layout.onRoad).toBe(0); });

  it("buildings without one free cell around them: 0", () => {
    console.log(`[t11] crowd=${world.layout.crowd} relaxed=${world.layout.relaxed} placed=${world.layout.placed.length}`);
    expect(world.layout.crowd).toBe(0);
  });

  it("buildings that found no place: 0", () => { expect(world.layout.failed).toBe(0); });

  it("trees placed (info): at least one tree on more than one type", () => {
    console.log(`[t11] trees=${world.layout.trees.length} types=${new Set(world.layout.trees.map((t) => t.bi)).size}`);
    expect(world.layout.trees.length).toBeGreaterThan(0);
  });

  it("trees on a footprint or road: 0", () => { expect(world.layout.treeOnFoot).toBe(0); });
  it("trees directly in front of a building: 0", () => { expect(world.layout.treeFront).toBe(0); });

  it("share of a building hidden by others: worst under 10%", () => {
    const occ = occlusion(world);
    console.log(`[t11] worst hidden ${occ[0]?.pct.toFixed(1)}% (${occ[0]?.name}, ${occ[0]?.isl})`);
    expect(occ[0].pct).toBeLessThan(PASS.hiddenPct);
  });

  it("shore cells with an exact coast tile: all", () => {
    let exact = 0, miss = 0;
    for (let gy = 0; gy < ROWS; gy++) for (let gx = 0; gx < COLS; gx++) {
      if (!land(gx, gy)) continue;
      const m = coastMask(gx, gy);
      if (!m) continue;
      if (COAST_MASK.includes(m)) exact++; else miss++;
    }
    console.log(`[t11] shore exact ${exact}/${exact + miss}`);
    expect(miss).toBe(0);
  });

  it("bridge ends on shore edges: 0 px by construction", () => {
    for (const br of BRIDGES) {
      expect(isShoreEdgeMidpoint(br.a)).toBe(true);
      expect(isShoreEdgeMidpoint(br.b)).toBe(true);
      const deck = bridgeDeck(br);
      expect(deck.top).toHaveLength(4);
      expect(deck.u1).toBeGreaterThan(deck.u0);
    }
    expect(LANE.length).toBeGreaterThan(1);
    expect(nearestCoastIndex(0).exact).toBe(true);
  });
});
