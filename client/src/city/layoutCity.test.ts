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

  it("an island with no parsed files gets no land", () => {
    const empty: Extraction = { ...EXTRACTION, islands: [...EXTRACTION.islands, { id: "ghost", name: "ghost", path: "ghost", file_count: 0, files: [] }] };
    const layout = layoutCity(empty);
    expect(layout.islands.map((i) => i.id)).not.toContain("ghost");
  });
});
