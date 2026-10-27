import { buildWorld, type SheetPixels } from "./map/pipeline";
import { renderWorld } from "./map/renderPixi";
import type { PixelData } from "./map/pixels";
import { usedSprites } from "./map/pipeline";
import { occlusion } from "./map/placement";
import { PASS } from "./map/checks";
import buildingsUrl from "../../assets/sprites/buildings.png";
import coastUrl from "../../assets/sprites/coast.png";
import shipUrl from "../../assets/sprites/ship.png";
import marketTreesUrl from "../../assets/sprites/market-flags-trees.png";

async function loadPixels(url: string): Promise<PixelData> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: d.data };
}

async function main() {
  const status = document.getElementById("status")!;
  const sheets: SheetPixels = {
    buildings: await loadPixels(buildingsUrl),
    coast: await loadPixels(coastUrl),
    ship: await loadPixels(shipUrl),
    marketTrees: await loadPixels(marketTreesUrl),
  };
  const world = buildWorld(sheets);

  // Fail-level geometry checks from DESIGN.md: a failing check stops the render, naming the check.
  const used = usedSprites(world);
  const failures: string[] = [];
  const count = world.buildings.count + world.coast.count + world.shipComp.count + world.marketTrees.count;
  if (count !== 36) failures.push(`sprites found (${count}/36)`);
  if (world.buildings.touching + world.coast.touching + world.shipComp.touching + world.marketTrees.touching !== 0) failures.push("sprites cropped at sheet edge");
  if (Math.max(...used.map((s) => s.aspectErrorPct ?? Infinity)) >= PASS.plateShapePct) failures.push("plate shape vs footprint");
  if (Math.max(...used.map((s) => s.overhangPct ?? Infinity)) >= PASS.baseOutsidePct) failures.push("base outside footprint");
  const edge = Math.max(...world.tiles.map((t) => t.err));
  if (edge >= PASS.tileEdgePct) failures.push(`tile edge error ${edge.toFixed(2)}%`);
  if (Math.max(...world.tiles.map((t) => t.gap)) >= PASS.tileGapPct) failures.push("gaps inside tile top face");
  if (world.layout.overlaps || world.layout.offLand || world.layout.onRoad) failures.push("footprint overlap/off-land/bridge landing");
  if (world.layout.crowd !== 0) failures.push("building without one free cell");
  if (world.layout.treeOnFoot || world.layout.treeFront) failures.push("tree placement");
  if ((occlusion(world)[0]?.pct ?? 0) >= PASS.hiddenPct) failures.push("building hidden by others");

  if (failures.length) {
    status.textContent = `Sprite pipeline check failed: ${failures.join("; ")}. Map not rendered.`;
    status.classList.add("fail");
    (window as unknown as { __failures: string[] }).__failures = failures;
    return;
  }

  const params = new URLSearchParams(location.search);
  const TW = params.get("full") ? 200 : Math.min(140, (innerWidth * Math.min(2, devicePixelRatio || 1)) / 21);
  const app = await renderWorld(world, TW);
  document.getElementById("app")!.appendChild(app.canvas);
  app.canvas.style.width = params.get("full") ? `${app.canvas.width}px` : "100%";
  if (!params.get("full")) app.canvas.style.height = "auto";
  status.textContent = `Three-island test map · ${world.layout.placed.length} buildings · ${world.layout.trees.length} trees · tile edge error ${edge.toFixed(2)}% · all fail-level checks pass`;
  (window as unknown as { __world: unknown }).__world = world;
}

main().catch((e) => {
  const status = document.getElementById("status")!;
  status.textContent = `Couldn't build the scene: ${e?.message ?? e}`;
  status.classList.add("fail");
  console.error(e);
});
