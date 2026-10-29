import { describe, expect, it } from "vitest";
import { deckEdges, deckRibbon, deckTargetH } from "./layoutCity";

describe("deckTargetH", () => {
  it("grows slowly with count and caps at 62", () => {
    expect(deckTargetH(0)).toBe(44);
    expect(deckTargetH(23)).toBeCloseTo(57.755, 3);
    expect(deckTargetH(101)).toBe(62);
  });
});

describe("deckRibbon", () => {
  it("straight path makes one strip, u by arclength", () => {
    const [s] = deckRibbon([[0, 0], [100, 0]], 10, [20]);
    expect(s.positions).toEqual([0, -10, 0, 10, 100, -10, 100, 10]);
    expect(s.uvs).toEqual([0, 0, 0, 1, 5, 0, 5, 1]);
    expect(s.indices).toEqual([0, 1, 2, 1, 3, 2, 2, 1, 0, 2, 3, 1]);
  });

  it("triangles cover the whole quad, both rails", () => {
    const inTri = (px: number, py: number, t: number[]): boolean => {
      const [ax, ay, bx, by, cx, cy] = t;
      const s = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): number =>
        Math.sign((x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3));
      // Boundary counts as covered (shared quad diagonals).
      const d1 = s(px, py, ax, ay, bx, by);
      const d2 = s(px, py, bx, by, cx, cy);
      const d3 = s(px, py, cx, cy, ax, ay);
      return !((d1 > 0 || d2 > 0 || d3 > 0) && (d1 < 0 || d2 < 0 || d3 < 0));
    };
    const covered = (s: { positions: number[]; indices: number[] }, px: number, py: number): boolean => {
      for (let k = 0; k + 2 < s.indices.length; k += 3) {
        const t = [0, 1, 2].flatMap((j) => {
          const v = s.indices[k + j];
          return [s.positions[2 * v], s.positions[2 * v + 1]];
        });
        if (inTri(px, py, t)) return true;
      }
      return false;
    };
    // Straight: points near both rails plus the middle.
    const [straight] = deckRibbon([[0, 0], [100, 0]], 10, [20]);
    for (const [px, py] of [[50, 8], [50, -8], [10, 9], [90, -9], [50, 0]] as const) {
      expect(covered(straight, px, py)).toBe(true);
    }
    // Mitered leg: quad middle plus the right-rail interior
    // (the old diagonal left a hole along the right rail).
    const [leg] = deckRibbon([[-100, 0], [0, 0], [60, -80]], 10, [20, 20]);
    expect(covered(leg, -50, 0)).toBe(true);
    expect(covered(leg, -48.3, 6.7)).toBe(true);
  });

  it("53° deflection miters both edges, seam shares verts+uvs", () => {
    const strips = deckRibbon([[-100, 0], [0, 0], [60, -80]], 10, [20, 20]);
    expect(strips).toHaveLength(2);
    const [a, b] = strips;
    // Miter: 1/cos(26.5°) = 1.118 < limit 2. Inner (-5,-10), outer (5,10).
    const [ix, iy, ox, oy] = a.positions.slice(4);
    expect(ix).toBeCloseTo(-5, 10);
    expect(iy).toBeCloseTo(-10, 10);
    expect(ox).toBeCloseTo(5, 10);
    expect(oy).toBeCloseTo(10, 10);
    expect(a.uvs[4]).toBeCloseTo(4.75, 10); // inner edge shorter: 95/20
    expect(a.uvs[6]).toBeCloseTo(5.25, 10); // outer edge longer: 105/20
    expect(a.positions).toHaveLength(8); // no bevel facet
    // Seam: leg 2 starts exactly where leg 1 ends (positions and u).
    expect(b.positions.slice(0, 4)).toEqual(a.positions.slice(4));
    expect(b.uvs.slice(0, 4)).toEqual(a.uvs.slice(4));
    expect(b.uvs[4]).toBeCloseTo(9.5, 10);
    expect(b.uvs[6]).toBeCloseTo(10.5, 10);
  });

  it("127° deflection bevels the outer edge, miters the inner", () => {
    const strips = deckRibbon([[-100, 0], [0, 0], [-60.1815, -79.8636]], 10, [20, 20]);
    expect(strips).toHaveLength(2);
    const [a, b] = strips;
    // Miter would run 2.24× half width: outer chords O1->O2 instead.
    const [ix, iy] = a.positions.slice(4, 8);
    expect(ix).toBeCloseTo(-20.0569, 4); // inner miter x
    expect(iy).toBeCloseTo(-10, 8); // inner miter y
    expect(a.positions).toHaveLength(10); // quad + bevel-facet vert
    expect(a.positions[8]).toBeCloseTo(7.9864, 3); // facet O2 x
    expect(a.positions[9]).toBeCloseTo(-6.0182, 3); // facet O2 y
    expect(a.uvs[8]).toBeCloseTo(5.89493, 4); // facet outer u accumulates
    expect(a.uvs[9]).toBe(1);
    expect(a.indices.slice(12)).toEqual([3, 2, 4, 4, 2, 3]);
    // Seam: leg 2 starts on the facet edge (same positions, same u).
    expect(b.positions.slice(0, 4)).toEqual([a.positions[4], a.positions[5], a.positions[8], a.positions[9]]);
    expect(b.uvs.slice(0, 4)).toEqual([a.uvs[4], a.uvs[5], a.uvs[8], a.uvs[9]]);
    expect(b.positions).toHaveLength(8);
  });

  it("right turns mirror inner and outer", () => {
    const [a] = deckRibbon([[-100, 0], [0, 0], [60, 80]], 10, [20, 20]);
    // 53° deflection, right turn: inner miter sits right (y>0), outer left.
    const [ox, oy, qx, qy] = a.positions.slice(4);
    expect(ox).toBeCloseTo(5, 10);
    expect(oy).toBeCloseTo(-10, 10);
    expect(qx).toBeCloseTo(-5, 10);
    expect(qy).toBeCloseTo(10, 10);
    expect(a.uvs[4]).toBeCloseTo(5.25, 10);
    expect(a.uvs[6]).toBeCloseTo(4.75, 10);
  });

  it("left-side bevel mirrors the right-side one", () => {
    const strips = deckRibbon([[-100, 0], [0, 0], [-60.1815, 79.8636]], 10, [20, 20]);
    expect(strips).toHaveLength(2);
    const [a, b] = strips;
    // Mirror of the 127° right-side bevel: outer chord on the left.
    const [ox, oy, ix, iy] = a.positions.slice(4);
    expect(ox).toBeCloseTo(0, 10);
    expect(oy).toBeCloseTo(-10, 10);
    expect(ix).toBeCloseTo(-20.0569, 4);
    expect(iy).toBeCloseTo(10, 8);
    expect(a.positions).toHaveLength(10);
    expect(a.positions[8]).toBeCloseTo(7.9864, 3);
    expect(a.positions[9]).toBeCloseTo(6.0182, 3);
    expect(a.uvs[8]).toBeCloseTo(5.89493, 4);
    expect(a.uvs[9]).toBe(0);
    expect(b.positions.slice(0, 4)).toEqual([a.positions[8], a.positions[9], a.positions[6], a.positions[7]]);
    expect(b.uvs.slice(0, 4)).toEqual([a.uvs[8], a.uvs[9], a.uvs[6], a.uvs[7]]);
  });

  it("short legs butt at their cross-sections instead of folding", () => {
    // 90° turn, first leg 8px: the miter vertex would sit 10px back.
    const strips = deckRibbon([[0, 0], [8, 0], [8, 30]], 10, [20, 20]);
    expect(strips).toHaveLength(2);
    const [a, b] = strips;
    expect(a.positions).toEqual([0, -10, 0, 10, 8, -10, 8, 10]);
    // Unshared seam (a wedge, not a fold): leg 2 starts on its own cross-section.
    expect(b.positions.slice(0, 4)).toEqual([18, 0, -2, 0]);
    for (const s of strips) {
      expect(s.positions.every(Number.isFinite)).toBe(true);
      expect(s.uvs.every(Number.isFinite)).toBe(true);
    }
  });

  it("exact reversals butt without swapping sides", () => {
    const strips = deckRibbon([[0, 0], [50, 0], [0, 0]], 10, [20, 20]);
    expect(strips).toHaveLength(2);
    const [a, b] = strips;
    expect(a.positions).toEqual([0, -10, 0, 10, 50, -10, 50, 10]);
    // Leg 2 doubles back over leg 1 as a proper rectangle, v=0 on
    // its own left (no bowtie, no side swap).
    expect(b.positions).toEqual([50, 10, 50, -10, 0, 10, 0, -10]);
  });

  it("zero-length legs neither crash nor poison u", () => {
    const strips = deckRibbon([[0, 0], [0, 0], [100, 0]], 10, [20, 20]);
    expect(strips).toHaveLength(2);
    for (const s of strips) {
      expect(s.positions.every(Number.isFinite)).toBe(true);
      expect(s.uvs.every(Number.isFinite)).toBe(true);
    }
    expect(strips[1].uvs[4]).toBe(5);
    expect(strips[1].uvs[6]).toBe(5);
  });

  it("leading zero-length legs take the first real direction", () => {
    // No false bend at the path start: the ribbon runs straight up.
    const strips = deckRibbon([[0, 0], [0, 0], [0, 100]], 10, [20, 20]);
    expect(strips).toHaveLength(2);
    expect(strips[1].positions).toEqual([10, 0, -10, 0, 10, 100, -10, 100]);
  });

  it("one period covers all legs", () => {
    const one = deckRibbon([[-100, 0], [0, 0], [60, -80]], 10, [20]);
    const two = deckRibbon([[-100, 0], [0, 0], [60, -80]], 10, [20, 20]);
    expect(one).toEqual(two);
  });

  it("rejects empty input", () => {
    expect(deckRibbon([], 10, [20])).toEqual([]);
    expect(deckRibbon([[0, 0]], 10, [20])).toEqual([]);
    expect(deckRibbon([[0, 0], [1, 0]], 0, [20])).toEqual([]);
  });
});

describe("deckEdges", () => {
  it("follows a straight strip end to end", () => {
    const edges = deckEdges(deckRibbon([[0, 0], [100, 0]], 10, [20]));
    expect(edges.left).toEqual([[0, -10], [100, -10]]);
    expect(edges.right).toEqual([[0, 10], [100, 10]]);
  });

  it("chains miter seams without duplicating the shared verts", () => {
    const edges = deckEdges(deckRibbon([[-100, 0], [0, 0], [60, -80]], 10, [20, 20]));
    expect(edges.left).toHaveLength(3);
    expect(edges.right).toHaveLength(3);
    const want: [number, number][][] = [
      [[-100, -10], [-5, -10], [52, -86]],
      [[-100, 10], [5, 10], [68, -74]],
    ];
    [edges.left, edges.right].forEach((edge, e) => {
      edge.forEach((pt, k) => {
        expect(pt[0]).toBeCloseTo(want[e][k][0], 8);
        expect(pt[1]).toBeCloseTo(want[e][k][1], 8);
      });
    });
  });

  it("extends the outer edge through the bevel facet", () => {
    const edges = deckEdges(deckRibbon([[-100, 0], [0, 0], [-60.1815, -79.8636]], 10, [20, 20]));
    expect(edges.left).toHaveLength(3);
    expect(edges.left[0]).toEqual([-100, -10]);
    expect(edges.left[1][0]).toBeCloseTo(-20.0569, 4);
    expect(edges.left[1][1]).toBeCloseTo(-10, 8);
    expect(edges.left[2][0]).toBeCloseTo(-68.1679, 4);
    expect(edges.left[2][1]).toBeCloseTo(-73.8455, 4);
    expect(edges.right).toHaveLength(4);
    expect(edges.right[0]).toEqual([-100, 10]);
    expect(edges.right[1][0]).toBeCloseTo(0, 10);
    expect(edges.right[1][1]).toBeCloseTo(10, 10);
    expect(edges.right[2][0]).toBeCloseTo(7.9864, 3);
    expect(edges.right[2][1]).toBeCloseTo(-6.0182, 3);
    expect(edges.right[3][0]).toBeCloseTo(-52.1951, 3);
    expect(edges.right[3][1]).toBeCloseTo(-85.8817, 3);
  });
});
