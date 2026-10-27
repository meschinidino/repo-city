import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import type { PixelData } from "./pixels";
import type { SheetPixels } from "./pipeline";

const spritesDir = join(dirname(fileURLToPath(import.meta.url)), "../../../assets/sprites");

export function loadSheetPixels(name: string): PixelData {
  const png = PNG.sync.read(readFileSync(join(spritesDir, name)));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
}

export function loadAllSheets(): SheetPixels {
  return {
    buildings: loadSheetPixels("buildings.png"),
    coast: loadSheetPixels("coast.png"),
    ship: loadSheetPixels("ship.png"),
    marketTrees: loadSheetPixels("market-flags-trees.png"),
  };
}
