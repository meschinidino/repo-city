import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

/**
 * First E2E smoke: the client loads the committed sheets, every fail-level
 * geometry check passes, and the three-island test map actually renders.
 * This is a load/render smoke only; the five user journeys in
 * specs/test-plan.md need features (sessions, event stream) that do not
 * exist yet, and get their own specs when those land.
 */

interface WorldSummary { placed: number; trees: number; islands: string[] }

function collectErrors(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  return errors;
}

async function worldSummary(page: import("@playwright/test").Page): Promise<WorldSummary> {
  return page.evaluate(() => {
    const w = (window as unknown as { __world?: { layout: { placed: { isl: string }[]; trees: unknown[] } } }).__world;
    if (!w) throw new Error("window.__world not set: pipeline did not complete");
    return {
      placed: w.layout.placed.length,
      trees: w.layout.trees.length,
      islands: [...new Set(w.layout.placed.map((p) => p.isl))].sort(),
    };
  });
}

/** Share of screenshot pixels within `tol` of a colour, per channel. */
function colourShare(png: PNG, rgb: [number, number, number], tol = 28): number {
  let hit = 0;
  const total = png.width * png.height;
  for (let i = 0; i < png.data.length; i += 16) { // every 4th pixel
    if (Math.abs(png.data[i] - rgb[0]) <= tol && Math.abs(png.data[i + 1] - rgb[1]) <= tol && Math.abs(png.data[i + 2] - rgb[2]) <= tol) hit++;
  }
  return hit / (total / 4);
}

test("client loads, pipeline checks pass, three islands render", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");

  // Fail-level checks gate the render in main.ts; this text only appears when they all pass.
  await expect(page.locator("#status")).toContainText("all fail-level checks pass");
  await expect(page.locator("#status")).toContainText(/tile edge error \d+\.\d+%/);
  await expect(page.locator("#status")).not.toHaveClass(/fail/);

  const world = await worldSummary(page);
  expect(world.islands).toEqual(["api", "auth", "payments"]);
  expect(world.placed).toBe(17);
  expect(world.trees).toBe(15);

  const canvas = page.locator("#app canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box && box.width).toBeGreaterThan(300);

  // The rendered frame is the real map, not a blank or solid canvas:
  // mostly sea, with grass islands and at least some sail-orange on it.
  const shot = PNG.sync.read(await page.screenshot());
  expect(colourShare(shot, [0x4f, 0x98, 0xa6])).toBeGreaterThan(0.2); // sea base colour
  expect(colourShare(shot, [0x9c, 0xc5, 0x4a], 60)).toBeGreaterThan(0.01); // grass
  expect(colourShare(shot, [0xe8, 0x81, 0x2b], 60)).toBeGreaterThan(0.0002); // sail orange

  expect(errors).toEqual([]);
});

test("full-size render is 200 px per tile (4200x2440 canvas)", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?full=1");

  await expect(page.locator("#status")).toContainText("all fail-level checks pass");
  const dims = await page.locator("#app canvas").evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }));
  expect(dims).toEqual({ w: 4200, h: 2440 });
  expect(errors).toEqual([]);
});
