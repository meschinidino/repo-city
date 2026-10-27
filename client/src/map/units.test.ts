import { describe, it, expect } from "vitest";
import { keyMagenta, isCyan } from "./colorKey";
import { connectedComponents } from "./components";
import { chooseFootprint } from "./plate";
import { coastMask, coastTileIndexWith, nearestCoastIndex, PLAIN_GRASS_INDEX } from "./coast";
import { createPixels } from "./pixels";

function solid(w: number, h: number, rgba: [number, number, number, number]) {
  const p = createPixels(w, h);
  for (let i = 0; i < p.data.length; i += 4) { p.data[i] = rgba[0]; p.data[i + 1] = rgba[1]; p.data[i + 2] = rgba[2]; p.data[i + 3] = rgba[3]; }
  return p;
}

describe("keying (simulated synthetic pixels)", () => {
  it("pure magenta becomes transparent, other colours stay", () => {
    const img = solid(2, 1, [255, 0, 255, 255]);
    img.data[4] = 10; img.data[5] = 200; img.data[6] = 10;
    const out = keyMagenta(img);
    expect(out.data[3]).toBe(0);
    expect(out.data[7]).toBe(255);
  });
  it("isCyan matches the plate colour only", () => {
    expect(isCyan(0, 255, 255)).toBe(true);
    expect(isCyan(200, 255, 255)).toBe(false);
    expect(isCyan(0, 100, 255)).toBe(false);
  });
});

describe("connected components (simulated synthetic pixels)", () => {
  it("finds separate shapes and orders by sheet cell", () => {
    const img = solid(80, 60, [0, 0, 0, 0]);
    // two 45x45 opaque blobs (>=1500 px) in different cells
    for (const [ox, oy] of [[0, 0], [40, 20]]) for (let y = 0; y < 40; y++) for (let x = 0; x < 38; x++) {
      const i = ((oy + y) * 80 + ox + x) * 4; img.data[i + 3] = 255;
    }
    const r = connectedComponents(img, 2);
    expect(r.count).toBe(2);
    expect(r.touching).toBeGreaterThan(0); // first blob touches the corner in this synthetic case
  });
});

describe("footprint choice", () => {
  it("a 1.95:1 plate picks 2x1 over 3x1", () => {
    expect(chooseFootprint(1.95, [[2, 1], [3, 1]]).foot).toEqual([2, 1]);
    expect(chooseFootprint(2.9, [[2, 1], [3, 1]]).foot).toEqual([3, 1]);
  });
});

describe("coast autotiling", () => {
  it("interior land has mask 0 and an exact plain-grass tile", () => {
    expect(coastMask(3, 3)).toBe(0);
    expect(nearestCoastIndex(0).exact).toBe(true);
  });
  it("a custom land test (city islands) gets shore tiles at its edge and grass inside", () => {
    // One 3x3 island at cells 10..12: centre is plain grass, a
    // corner cell gets a shore or corner tile, never plain grass.
    const land = (gx: number, gy: number) => gx >= 10 && gx < 13 && gy >= 10 && gy < 13;
    expect(coastTileIndexWith(land, 11, 11)).toBe(PLAIN_GRASS_INDEX);
    expect(coastTileIndexWith(land, 10, 10)).not.toBe(PLAIN_GRASS_INDEX);
    expect(coastTileIndexWith(land, 11, 10)).not.toBe(PLAIN_GRASS_INDEX);
  });
  it("unknown masks fall back to the nearest tile, never undefined", () => {
    const r = nearestCoastIndex(5);
    expect(r.index).toBeGreaterThanOrEqual(0);
    expect(r.distance).toBeGreaterThanOrEqual(0);
  });
});
