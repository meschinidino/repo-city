import { describe, it, expect } from "vitest";
import {
  CORNER_ANCHOR,
  cityProjector,
  cornerDecision,
  cornerKind,
  cornerPlacement,
  cornerShortenCells,
  cornerTargetH,
} from "./layoutCity";
import { keyMagenta } from "../map/colorKey";
import { loadSheetPixels } from "../map/loadSheetsNode";

const project = cityProjector({ cols: 100, rows: 100 }, 64).project;

describe("bridge corner joints", () => {
  it("E opening: sharp 53 degrees, no mirror", () => {
    // Legs run +x and -y from the elbow: both arms extend +x on screen.
    const k = cornerKind({ gx: 20, gy: 0 }, { gx: 10, gy: 0 }, { gx: 10, gy: -10 }, project);
    expect(k.sharp).toBe(true);
    expect(k.mirror).toBe(false);
    expect(k.angleDeg).toBeCloseTo(53.13, 1);
  });

  it("W opening: sharp 53 degrees, mirrored", () => {
    const k = cornerKind({ gx: 0, gy: 0 }, { gx: 10, gy: 0 }, { gx: 10, gy: 10 }, project);
    expect(k.sharp).toBe(true);
    expect(k.mirror).toBe(true);
    expect(k.angleDeg).toBeCloseTo(53.13, 1);
  });

  it("N and S openings: wide 127 degrees, no corner", () => {
    const n = cornerKind({ gx: 0, gy: 10 }, { gx: 10, gy: 10 }, { gx: 10, gy: 0 }, project);
    expect(n.sharp).toBe(false);
    expect(n.angleDeg).toBeCloseTo(126.87, 1);
    const s = cornerKind({ gx: 10, gy: 10 }, { gx: 10, gy: 0 }, { gx: 20, gy: 0 }, project);
    expect(s.sharp).toBe(false);
    expect(s.angleDeg).toBeCloseTo(126.87, 1);
  });

  it("deck height follows the import count and caps at 62", () => {
    expect(cornerTargetH(23)).toBeCloseTo(44 + 3 * Math.log2(24), 6);
    expect(cornerTargetH(101)).toBe(62);
  });

  it("legs shorten by arm length minus overlap, in grid cells", () => {
    // count=23: targetH 57.76, scale 0.0895, (462-0.2*266)px -> 1.023 cells.
    expect(cornerShortenCells(23, 64)).toBeCloseTo(1.023, 3);
  });

  it("sharp bent path with long legs places the corner and shortens the legs", () => {
    const p = cornerPlacement(
      [{ gx: 20, gy: 0 }, { gx: 10, gy: 0 }, { gx: 10, gy: -10 }],
      23,
      project,
      64,
    );
    expect(p, "placement exists").not.toBeNull();
    expect(p!.mirror).toBe(false);
    expect(p!.gx).toBe(10);
    expect(p!.gy).toBe(0);
    // Legs run along +x and -y from the elbow; each shortens ~1.023 cells.
    expect(p!.ends[0]).toEqual({ gx: 20, gy: 0 });
    expect(p!.ends[1].gx).toBeCloseTo(11.023, 3);
    expect(p!.ends[1].gy).toBe(0);
    expect(p!.ends[2].gx).toBe(10);
    expect(p!.ends[2].gy).toBeCloseTo(-1.023, 3);
    expect(p!.ends[3]).toEqual({ gx: 10, gy: -10 });
  });

  it("wide joints keep straight tiles (no placement)", () => {
    expect(
      cornerPlacement([{ gx: 0, gy: 10 }, { gx: 10, gy: 10 }, { gx: 10, gy: 0 }], 23, project, 64),
    ).toBeNull();
  });

  it("legs too short for the arms keep straight tiles (no placement)", () => {
    expect(
      cornerPlacement([{ gx: 10.5, gy: 0 }, { gx: 10, gy: 0 }, { gx: 10, gy: -0.5 }], 23, project, 64),
    ).toBeNull();
  });

  it("vertex anchor pins the v2 surgery placement", () => {
    // The surgery builder reports cropped 535x815, vertex-anchor 0.0224 0.4564.
    expect(CORNER_ANCHOR.x).toBeCloseTo(0.0224, 4);
    expect(CORNER_ANCHOR.y).toBeCloseTo(0.4564, 4);
  });

  it("land in the joint disk vetoes the corner", () => {
    const isLand = (gx: number, gy: number) => gx === 10 && gy === 0;
    expect(
      cornerPlacement([{ gx: 20, gy: 0 }, { gx: 10, gy: 0 }, { gx: 10, gy: -10 }], 23, project, 64, isLand),
    ).toBeNull();
  });
});

describe("cornerDecision", () => {
  const sharp = [{ gx: 20, gy: 0 }, { gx: 10, gy: 0 }, { gx: 10, gy: -10 }];

  it("sharp bent path returns shortened legs and the corner", () => {
    const d = cornerDecision(sharp, 23, project, 64, { art: true });
    expect(d.corner).toEqual({ gx: 10, gy: 0, mirror: false });
    expect(d.legs).toHaveLength(2);
    expect(d.legs[0][0]).toEqual(sharp[0]);
    expect(d.legs[0][1].gx).toBeCloseTo(11.023, 3);
    expect(d.legs[0][1].gy).toBe(0);
    expect(d.legs[1][0].gx).toBe(10);
    expect(d.legs[1][0].gy).toBeCloseTo(-1.023, 3);
    expect(d.legs[1][1]).toEqual(sharp[2]);
  });

  it("missing art keeps full legs and no corner", () => {
    const d = cornerDecision(sharp, 23, project, 64, { art: false });
    expect(d.corner).toBeNull();
    expect(d.legs).toEqual([[sharp[0], sharp[1]], [sharp[1], sharp[2]]]);
  });

  it("straight paths keep full legs and no corner", () => {
    const d = cornerDecision([sharp[0], sharp[1]], 23, project, 64, { art: true });
    expect(d.corner).toBeNull();
    expect(d.legs).toEqual([[sharp[0], sharp[1]]]);
  });

  it("wide and short joints keep full legs and no corner", () => {
    const wide = [{ gx: 0, gy: 10 }, { gx: 10, gy: 10 }, { gx: 10, gy: 0 }];
    const dw = cornerDecision(wide, 23, project, 64, { art: true });
    expect(dw.corner).toBeNull();
    expect(dw.legs).toEqual([[wide[0], wide[1]], [wide[1], wide[2]]]);
    const short = [{ gx: 10.5, gy: 0 }, { gx: 10, gy: 0 }, { gx: 10, gy: -0.5 }];
    const ds = cornerDecision(short, 23, project, 64, { art: true });
    expect(ds.corner).toBeNull();
    expect(ds.legs).toEqual([[short[0], short[1]], [short[1], short[2]]]);
  });

  it("land in the joint keeps full legs; land outside keeps the corner", () => {
    const veto = (gx: number, gy: number) => gx === 10 && gy === 0;
    const dv = cornerDecision(sharp, 23, project, 64, { art: true, isLand: veto });
    expect(dv.corner).toBeNull();
    expect(dv.legs).toEqual([[sharp[0], sharp[1]], [sharp[1], sharp[2]]]);
    const outside = (gx: number, gy: number) => gx === 12 && gy === 0;
    const dk = cornerDecision(sharp, 23, project, 64, { art: true, isLand: outside });
    expect(dk.corner).toEqual({ gx: 10, gy: 0, mirror: false });
    expect(dk.legs).toHaveLength(2);
  });
});

describe("bridge-corner.png asset", () => {
  it("matches the surgery construction (535x815, keyed, same palette)", () => {
    const c = loadSheetPixels("bridge-corner.png");
    expect(c.width).toBe(535);
    expect(c.height).toBe(815);
    // Key leaks use the shared magenta key, not a broad RGB guess: the v2
    // rotation leaves one warm edge pixel (255,147,175) that the old
    // r/b > 170, g < 150 check misread as magenta.
    const keyed = keyMagenta(c);
    let opaque = 0, magenta = 0, r = 0, g = 0, b = 0;
    for (let i = 0; i < c.data.length; i += 4) {
      if (c.data[i + 3] <= 128) continue;
      opaque++;
      r += c.data[i]; g += c.data[i + 1]; b += c.data[i + 2];
      if (keyed.data[i + 3] === 0) magenta++;
    }
    const share = opaque / (c.width * c.height);
    console.log(`[corner] opaque ${(share * 100).toFixed(1)}%`);
    expect(share).toBeGreaterThan(0.5);
    expect(share).toBeLessThan(0.72);
    expect(magenta).toBe(0);
    // Same wood as the straight tiles (A/B differ by 5.7; allow twice that).
    const a = loadSheetPixels("bridge-a.png");
    let r2 = 0, g2 = 0, b2 = 0, n2 = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i + 3] <= 128) continue;
      r2 += a.data[i]; g2 += a.data[i + 1]; b2 += a.data[i + 2]; n2++;
    }
    const dist = Math.hypot(r / opaque - r2 / n2, g / opaque - g2 / n2, b / opaque - b2 / n2);
    console.log(`[corner] palette dist to bridge-a ${dist.toFixed(1)}`);
    expect(dist).toBeLessThan(12);
  });
});
