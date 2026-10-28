import { describe, it, expect } from "vitest";
import { arrangePlots, bridgeAxisLegs, bridgeChevron, bridgeSpan, cityBridgeDeck, islandShape, layoutCity, PLOT, plotDepth, waterSegments } from "./layoutCity";
import type { Extraction } from "./types";

// Hand-built extraction in the server's schema (not a live repo):
// layout math only, no rendering claims.
const EXTRACTION: Extraction = {
  schema_version: 1,
  is_stand_in_fixture: true,
  repo_root: "/fixture",
  counts: { files_parsed: 10, files_with_parse_errors: 0, total_imports: 3, resolved_imports: 3, unresolved_imports: 0 },
  islands: [
    { id: "api", name: "api", path: "packages/api", file_count: 6, files: [] },
    { id: "web", name: "web", path: "packages/web", file_count: 4, files: [] },
  ],
  files: [
    ...Array.from({ length: 6 }, (_, i) => ({ path: `packages/api/src/f${i}.ts`, island_id: "api", roles: [], building: "cottage", import_count: 0, importer_count: 0 })),
    ...Array.from({ length: 4 }, (_, i) => ({ path: `packages/web/src/w${i}.tsx`, island_id: "web", roles: [], building: "market", import_count: 0, importer_count: 0 })),
  ],
  bridges: [{ from_island: "web", to_island: "api", count: 3 }],
};

describe("city layout from an extraction (fixture)", () => {
  it("places every file exactly once, islands never share cells", () => {
    const layout = layoutCity(EXTRACTION);
    expect(layout.buildings).toHaveLength(10);
    expect(new Set(layout.buildings.map((b) => b.file)).size).toBe(10);
    const plots = new Set(layout.buildings.map((b) => `${b.gx},${b.gy}`));
    expect(plots.size).toBe(10);
    const [a, b] = layout.islands;
    const aRight = a.x + a.cols * PLOT;
    const aBottom = a.y + a.rows * PLOT;
    const overlap = b.x < aRight && b.y < aBottom && a.x < b.x + b.cols * PLOT && a.y < b.y + b.rows * PLOT;
    expect(overlap).toBe(false);
  });

  it("maps files to islands and positions for the event reducer", () => {
    const layout = layoutCity(EXTRACTION);
    expect(layout.fileToIsland.get("packages/web/src/w2.tsx")).toBe("web");
    const pos = layout.filePos.get("packages/api/src/f5.ts");
    expect(pos?.islandId).toBe("api");
    expect(layout.bridges).toEqual([{ from: "web", to: "api", count: 3 }]);
    expect(layout.cols).toBeGreaterThan(0);
    expect(layout.rows).toBeGreaterThan(0);
  });

  it("wraps to a new shelf row and keeps every pair of islands disjoint", () => {
    const many: Extraction = {
      ...EXTRACTION,
      islands: Array.from({ length: 6 }, (_, k) => ({ id: `isle${k}`, name: `isle${k}`, path: `isle${k}`, file_count: 9, files: [] })),
      files: Array.from({ length: 6 }, (_, k) =>
        Array.from({ length: 9 }, (_, i) => ({ path: `isle${k}/f${i}.ts`, island_id: `isle${k}`, roles: [], building: "cottage", import_count: 0, importer_count: 0 })),
      ).flat(),
      bridges: [],
    };
    const layout = layoutCity(many);
    expect(layout.islands.length).toBe(6);
    expect(new Set(layout.islands.map((i) => i.y)).size).toBeGreaterThan(1); // wrapped
    for (let a = 0; a < layout.islands.length; a++) {
      for (let b = a + 1; b < layout.islands.length; b++) {
        const A = layout.islands[a];
        const B = layout.islands[b];
        const overlap = B.x < A.x + A.cols * PLOT && A.x < B.x + B.cols * PLOT && B.y < A.y + A.rows * PLOT && A.y < B.y + B.rows * PLOT;
        expect(overlap, `${A.id} vs ${B.id}`).toBe(false);
      }
    }
    expect(layout.droppedFiles).toEqual([]);
  });

  it("an island wider than the shelf still places disjointly", () => {
    const wide: Extraction = {
      ...EXTRACTION,
      islands: [
        { id: "huge", name: "huge", path: "huge", file_count: 400, files: [] },
        { id: "tiny", name: "tiny", path: "tiny", file_count: 1, files: [] },
      ],
      files: [
        ...Array.from({ length: 400 }, (_, i) => ({ path: `huge/f${i}.ts`, island_id: "huge", roles: [], building: "cottage", import_count: 0, importer_count: 0 })),
        { path: "tiny/one.ts", island_id: "tiny", roles: [], building: "cottage", import_count: 0, importer_count: 0 },
      ],
      bridges: [],
    };
    const layout = layoutCity(wide);
    const [huge, tiny] = layout.islands;
    expect(layout.buildings).toHaveLength(401);
    // Disjoint on some axis, in any direction: hub placement is
    // free to put the tiny island left or above, not only after.
    const disjoint =
      tiny.x >= huge.x + huge.cols * PLOT || huge.x >= tiny.x + tiny.cols * PLOT
      || tiny.y >= huge.y + huge.rows * PLOT || huge.y >= tiny.y + tiny.rows * PLOT;
    expect(disjoint).toBe(true);
  });

  it("files pointing at unknown islands are reported, not placed", () => {
    const orphan: Extraction = {
      ...EXTRACTION,
      files: [...EXTRACTION.files, { path: "nowhere/x.ts", island_id: "missing", roles: [], building: "cottage", import_count: 0, importer_count: 0 }],
    };
    const layout = layoutCity(orphan);
    expect(layout.droppedFiles).toEqual(["nowhere/x.ts"]);
    expect(layout.buildings.map((b) => b.file)).not.toContain("nowhere/x.ts");
    expect(layout.fileToIsland.has("nowhere/x.ts")).toBe(false);
  });

  it("an island with no parsed files gets no land", () => {
    const empty: Extraction = { ...EXTRACTION, islands: [...EXTRACTION.islands, { id: "ghost", name: "ghost", path: "ghost", file_count: 0, files: [] }] };
    const layout = layoutCity(empty);
    expect(layout.islands.map((i) => i.id)).not.toContain("ghost");
  });
});

describe("bridgeSpan (design review: bridges stay on water)", () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  const b = { x: 30, y: 4, w: 10, h: 10 };
  it("starts and ends on the shorelines, never inside either island", () => {
    const span = bridgeSpan(a, b);
    expect(span).not.toBeNull();
    const [p, q] = span!;
    const insideInterior = (pt: { gx: number; gy: number }, r: typeof a) =>
      pt.gx > r.x + 0.001 && pt.gx < r.x + r.w - 0.001 && pt.gy > r.y + 0.001 && pt.gy < r.y + r.h - 0.001;
    expect(insideInterior(p, a)).toBe(false);
    expect(insideInterior(q, b)).toBe(false);
    // sampled points along the drawn span stay out of both interiors
    for (let i = 0; i <= 10; i++) {
      const pt = { gx: p.gx + ((q.gx - p.gx) * i) / 10, gy: p.gy + ((q.gy - p.gy) * i) / 10 };
      expect(insideInterior(pt, a)).toBe(false);
      expect(insideInterior(pt, b)).toBe(false);
    }
  });
  it("returns null when islands overlap along the line (no water)", () => {
    expect(bridgeSpan(a, { x: 5, y: 5, w: 10, h: 10 })).toBeNull();
  });
});

describe("bridgeSpan directions and degenerate cases", () => {
  const a = { x: 20, y: 20, w: 10, h: 10 };
  const cases: [string, { x: number; y: number; w: number; h: number }][] = [
    ["left", { x: 0, y: 22, w: 10, h: 10 }],
    ["above", { x: 22, y: 0, w: 10, h: 10 }],
    ["vertical (dx = 0)", { x: 20, y: 50, w: 10, h: 10 }],
    ["diagonal down-left", { x: 0, y: 50, w: 10, h: 10 }],
  ];
  for (const [name, b] of cases) {
    it(`span stays out of both interiors: ${name}`, () => {
      const span = bridgeSpan(a, b);
      expect(span).not.toBeNull();
      const inInterior = (pt: { gx: number; gy: number }, r: typeof a) =>
        pt.gx > r.x + 0.001 && pt.gx < r.x + r.w - 0.001 && pt.gy > r.y + 0.001 && pt.gy < r.y + r.h - 0.001;
      const [p, q] = span!;
      for (let i = 0; i <= 10; i++) {
        const pt = { gx: p.gx + ((q.gx - p.gx) * i) / 10, gy: p.gy + ((q.gy - p.gy) * i) / 10 };
        expect(inInterior(pt, a)).toBe(false);
        expect(inInterior(pt, b)).toBe(false);
      }
    });
  }
  it("touching islands have no water span", () => {
    expect(bridgeSpan(a, { x: 30, y: 20, w: 10, h: 10 })).toBeNull();
  });
  it("an island to itself has no span", () => {
    expect(bridgeSpan(a, a)).toBeNull();
  });
});

describe("bridgeAxisLegs (owner: direction assets, straight one-axis bridges)", () => {
  it("y-overlap gives a straight span along x at the overlap middle", () => {
    const legs = bridgeAxisLegs({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 4, w: 10, h: 10 });
    expect(legs).toEqual([{ gx: 10, gy: 7 }, { gx: 20, gy: 7 }]);
  });
  it("x-overlap gives a straight span along y", () => {
    const legs = bridgeAxisLegs({ x: 0, y: 0, w: 10, h: 10 }, { x: 4, y: 20, w: 10, h: 10 });
    expect(legs).toEqual([{ gx: 7, gy: 10 }, { gx: 7, gy: 20 }]);
  });
  it("reversed sides flip the shore points", () => {
    const legs = bridgeAxisLegs({ x: 20, y: 4, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 });
    expect(legs).toEqual([{ gx: 20, gy: 7 }, { gx: 10, gy: 7 }]);
  });
  it("no overlap on either axis gives null (caller bends)", () => {
    expect(bridgeAxisLegs({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 })).toBeNull();
  });
});

describe("waterSegments (owner: bridges must not run through islands in between)", () => {
  const path = [{ gx: 0, gy: 0 }, { gx: 20, gy: 0 }];
  it("open water stays one segment", () => {
    expect(waterSegments(path, () => false)).toHaveLength(1);
  });
  it("a land block in the middle cuts the deck in two", () => {
    const segs = waterSegments(path, (gx) => gx >= 8 && gx < 12);
    expect(segs).toHaveLength(2);
    expect(segs[0][1].gx).toBeLessThanOrEqual(8);
    expect(segs[1][0].gx).toBeGreaterThanOrEqual(12);
  });
  it("a path fully over land draws nothing", () => {
    expect(waterSegments(path, () => true)).toHaveLength(0);
  });
});

describe("plotDepth and cityBridgeDeck (user feedback 2026-10-27)", () => {
  it("building depth beats every ground tile on its own plot", () => {
    // Ground tiles draw at gx+gy; a building must sort after the
    // front row of its 2x2 plot or short sprites sink under it.
    expect(plotDepth(4, 6)).toBeGreaterThan(4 + 1 + (6 + 1));
    expect(plotDepth(4, 6)).toBe(4 + PLOT - 1 + (6 + PLOT - 1) + 0.6);
  });
  it("deck corners sit one half-width off the span axis", () => {
    const deck = cityBridgeDeck([{ gx: 0, gy: 0 }, { gx: 10, gy: 0 }], 3);
    expect(deck.len).toBe(10);
    const [c0, , c2] = deck.corners;
    expect(Math.abs(c0.gy)).toBeCloseTo(Math.hypot(deck.perp.gx, deck.perp.gy), 6);
    expect(c2.gy).toBeCloseTo(-c0.gy, 6);
    expect(cityBridgeDeck([{ gx: 0, gy: 0 }, { gx: 10, gy: 0 }], 128).perp.gy).toBeGreaterThan(deck.perp.gy);
  });
});

describe("bridgeChevron direction", () => {
  const span: [{ gx: number; gy: number }, { gx: number; gy: number }] = [{ gx: 0, gy: 0 }, { gx: 8, gy: 6 }];
  it("points toward the imported island on a diagonal span", () => {
    const deck = cityBridgeDeck(span, 5);
    const ch = bridgeChevron(span, deck);
    // tip is further along the span direction than both wings
    const along = (p: { gx: number; gy: number }) => p.gx * 0.8 + p.gy * 0.6;
    expect(along(ch.tip)).toBeGreaterThan(along(ch.wingA));
    expect(along(ch.tip)).toBeGreaterThan(along(ch.wingB));
    // wings stay within the deck half-width (inside the rails)
    const hw = Math.hypot(deck.perp.gx, deck.perp.gy);
    expect(Math.hypot(ch.wingA.gx - ch.wingB.gx, ch.wingA.gy - ch.wingB.gy) / 2).toBeLessThanOrEqual(hw);
  });
  it("reverses when the span reverses (two-way import)", () => {
    const fwd = bridgeChevron(span, cityBridgeDeck(span, 5));
    const rev = bridgeChevron([span[1], span[0]], cityBridgeDeck([span[1], span[0]], 5));
    expect(rev.tip.gx).toBeLessThan(fwd.tip.gx);
    expect(rev.tip.gy).toBeLessThan(fwd.tip.gy);
  });
});

describe("organic island shape", () => {
  it("is deterministic, keeps every building plot on land, and cuts some shore", () => {
    const keep = new Set<string>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) keep.add(x + "," + y);
    const a = islandShape("backend/app/modules/sales", 16, 14, keep);
    const b = islandShape("backend/app/modules/sales", 16, 14, keep);
    expect([...a].sort()).toEqual([...b].sort());
    for (const k of keep) expect(a.has(k)).toBe(true);
    expect(a.size).toBeLessThan(16 * 14); // some shore was cut
    expect(a.size).toBeGreaterThan(40); // and the island remains
  });

  it("a test-only island is compact no matter how many test files it holds", () => {
    const big = {
      ...EXTRACTION,
      islands: [{ id: "tests", name: "tests", path: "tests", file_count: 103, files: [] }],
      files: Array.from({ length: 103 }, (_, i) => ({
        path: `tests/t${i}.ts`, island_id: "tests", roles: [], building: "pennant", import_count: 0, importer_count: 0,
      })),
      bridges: [],
    } as Extraction;
    const layout = layoutCity(big);
    const [isl] = layout.islands;
    expect(isl.testOnly).toBe(true);
    expect(isl.testCount).toBe(103);
    expect(isl.cols * isl.rows).toBeLessThanOrEqual(6);
    expect(layout.buildings).toHaveLength(103);
  });
});

describe("hub placement", () => {
  it("puts the most-connected island closest to the centre and never overlaps islands", () => {
    const mk = (id: string, n: number) => ({
      path: `${id}/f.ts`, island_id: id, roles: [], building: "cottage", import_count: 0, importer_count: 0,
    });
    const ext = {
      counts: { files: 0, islands: 7, bridges: 6, parsed_imports: 0, resolved_imports: 0, unresolved_imports: 0 },
      islands: ["hub", "a", "b", "c", "d", "e", "f"].map((id) => ({ id, name: id, path: id, file_count: 4, files: [] })),
      files: ["hub", "a", "b", "c", "d", "e", "f"].flatMap((id) => [mk(id, 1), mk(id, 2), mk(id, 3), mk(id, 4)]),
      bridges: ["a", "b", "c", "d", "e", "f"].map((id) => ({ from_island: id, to_island: "hub", count: 20 })),
      unresolved_imports: [],
    } as unknown as Extraction;
    const layout = layoutCity(ext);
    const centre = {
      gx: layout.cols / 2, gy: layout.rows / 2,
    };
    const dist = (i: (typeof layout.islands)[number]) =>
      Math.hypot(i.center.gx - centre.gx, i.center.gy - centre.gy);
    const hub = layout.islands.find((i) => i.id === "hub")!;
    for (const isl of layout.islands) if (isl.id !== "hub") expect(dist(hub)).toBeLessThanOrEqual(dist(isl));
    // No two island plot-rects overlap (gap may shrink in the settle, land may not).
    for (let a = 0; a < layout.islands.length; a++) for (let b = a + 1; b < layout.islands.length; b++) {
      const A = layout.islands[a], B = layout.islands[b];
      const overlap = A.x < B.x + B.cols * PLOT && B.x < A.x + A.cols * PLOT && A.y < B.y + B.rows * PLOT && B.y < A.y + A.rows * PLOT;
      expect(overlap).toBe(false);
    }
    // Deterministic: same input, same map.
    expect(layoutCity(ext).islands.map((i) => [i.id, i.x, i.y])).toEqual(layout.islands.map((i) => [i.id, i.x, i.y]));
  });
});

describe("building arrangement inside an island", () => {
  it("landmark in the centre, same-kind adjacency minimised, deterministic", () => {
    const kinds = ["cottage", "cottage", "keep", "cottage", "cottage", "cottage", "cottage", "cottage", "cottage"];
    const a = arrangePlots(kinds, 3, 3);
    expect(a[2]).toEqual({ x: 1, y: 1 }); // the keep takes the centre
    const adj = (arr: { x: number; y: number }[]) => {
      let n = 0;
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
        if (kinds[i] === kinds[j] && Math.abs(arr[i].x - arr[j].x) + Math.abs(arr[i].y - arr[j].y) === 1) n++;
      }
      return n;
    };
    // 8 cottages on the 8 plots around a centre keep must touch;
    // the corners-only lower bound is 8 shared edges. Row-major
    // order gives the same grid here, so assert the count is the
    // minimum this fixture allows and that the rule is stable.
    expect(adj(a)).toBe(8);
    expect(arrangePlots(kinds, 3, 3)).toEqual(a);
  });

  it("spreads a mixed island better than row-major order", () => {
    const kinds = ["cottage", "cottage", "lighthouse", "cottage", "market", "cottage", "cottage", "silos", "cottage", "cottage", "cottage", "cottage", "cottage", "cottage", "cottage", "cottage"];
    const a = arrangePlots(kinds, 4, 4);
    expect(a[7]).toEqual({ x: 2, y: 2 }); // silos: highest-priority kind present, centre plot
    const pos = new Map(a.map((pl, i) => [i, pl]));
    let same = 0;
    for (let i = 0; i < kinds.length; i++) for (let j = i + 1; j < kinds.length; j++) {
      if (kinds[i] === kinds[j] && Math.abs(pos.get(i)!.x - pos.get(j)!.x) + Math.abs(pos.get(i)!.y - pos.get(j)!.y) === 1) same++;
    }
    let rowMajor = 0;
    for (let i = 0; i < kinds.length; i++) for (let j = i + 1; j < kinds.length; j++) {
      const pi = { x: i % 4, y: Math.floor(i / 4) }, pj = { x: j % 4, y: Math.floor(j / 4) };
      if (kinds[i] === kinds[j] && Math.abs(pi.x - pj.x) + Math.abs(pi.y - pj.y) === 1) rowMajor++;
    }
    expect(same).toBeLessThan(rowMajor);
  });
});
