import { describe, it, expect } from "vitest";
import { layoutCity, PLOT } from "./layoutCity";
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
    const disjoint =
      tiny.x >= huge.x + huge.cols * PLOT || tiny.y >= huge.y + huge.rows * PLOT;
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
