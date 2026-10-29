import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Drag-connect journey: lane drops validate through the real UI
 * (same island, duplicate, multi-hop cycle, quest on target),
 * a valid drop opens the editable confirm, watch refuses at
 * create, Escape cancels, and an API-seeded drag quest draws
 * its lane after reload. The UI create with a real agent would
 * spawn a live agent run, so the suite stops at the watch
 * refusal; the spawned create path is probe-verified live, and
 * the server accept side is covered by the HTTP suite.
 */

let SERVER = "";
let serverProc: ChildProcess | undefined;
let repoDir = "";
let workRoot = "";

const API = "@fixture/api";
const CLI = "@fixture/cli";
const SHARED = "@fixture/shared";
const WEB = "@fixture/web";

test.beforeAll(async () => {
  test.setTimeout(290_000);
  const serverDir = resolve(process.cwd(), "../server");
  const bin = join(serverDir, "target/debug/repo-city-server-bin");
  if (!existsSync(bin)) {
    execSync("cargo build --bin repo-city-server-bin", {
      cwd: serverDir,
      env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` },
      stdio: "pipe",
      timeout: 280_000,
    });
  }
  workRoot = mkdtempSync(join(tmpdir(), "repo-city-drag-"));
  repoDir = join(workRoot, "repo");
  cpSync(join(serverDir, "tests/fixtures/sample-monorepo"), repoDir, { recursive: true });
  // Private copy only: shared -> cli closes a multi-hop loop
  // (api -> shared -> cli), so drag cli -> api must refuse as a
  // cycle. The committed fixture keeps its hand-counted shape.
  writeFileSync(
    join(repoDir, "packages/shared/src/cycle-probe.ts"),
    'import { run } from "@fixture/cli";\nconsole.log(run);\n',
  );
  for (let attempt = 0; attempt < 5 && !SERVER; attempt++) {
    const port = 9600 + Math.floor(Math.random() * 400);
    const candidate = `http://127.0.0.1:${port}`;
    const occupied = await fetch(`${candidate}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
    if (occupied) continue;
    serverProc = spawn(bin, ["--port", String(port), "--db", join(workRoot, "drag.db")], { stdio: "ignore" });
    for (let i = 0; i < 25 && !SERVER; i++) {
      try {
        const res = await fetch(`${candidate}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok && serverProc.exitCode === null) {
          await new Promise((r) => setTimeout(r, 300));
          if (serverProc.exitCode === null) SERVER = candidate;
        }
      } catch { /* not up yet */ }
      if (!SERVER) await new Promise((r) => setTimeout(r, 200));
    }
    if (!SERVER) serverProc.kill();
  }
  if (!SERVER) throw new Error("repo-city server did not come up");
});

test.afterAll(() => {
  serverProc?.kill();
  if (workRoot) rmSync(workRoot, { recursive: true, force: true });
});

type CityHandle = {
  islandCenterScreen: (id: string) => [number, number] | null;
  laneDebug: () => { lanes: number; confirming: boolean; preview: boolean };
};

async function drag(
  page: import("@playwright/test").Page,
  from: string,
  to: string,
): Promise<void> {
  const box = await page.locator("#app canvas").boundingBox();
  if (!box) throw new Error("no canvas box");
  const pts = await page.evaluate(([f, t]) => {
    const c = (window as unknown as { __city: { city: CityHandle } }).__city.city;
    return [c.islandCenterScreen(f), c.islandCenterScreen(t)];
  }, [from, to] as const);
  if (!pts[0] || !pts[1]) throw new Error(`island center missing for ${from} -> ${to}`);
  const [ax, ay] = [box.x + pts[0][0], box.y + pts[0][1]];
  const [bx, by] = [box.x + pts[1][0], box.y + pts[1][1]];
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(bx, by, { steps: 12 });
  await page.mouse.up();
}

async function laneDebug(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const c = (window as unknown as { __city: { city: CityHandle } }).__city.city;
    return c.laneDebug();
  });
}

test("drag journey: refusals, confirm, cancel, seeded lane", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

  await page.goto(`/?repo=${encodeURIComponent(repoDir)}&server=${encodeURIComponent(SERVER)}`);
  await expect(page.locator("#status")).toContainText("Repo City · 4 islands");
  await expect(page.locator("#app canvas")).toBeVisible();
  // Every load bootstraps one island-less watch session, so the
  // bar starts at one token, not zero.
  await expect(page.locator("#tokens .token")).toHaveCount(1);

  // Guard against fixture drift: the copy must carry the
  // shared -> cli edge the cycle refusal needs.
  const edges = await page.evaluate(() => {
    const w = window as unknown as { __city: { layout: { bridges: { from: string; to: string }[] } } };
    return w.__city.layout.bridges.map((b) => `${b.from}>${b.to}`);
  });
  expect(edges).toContain(`${SHARED}>${CLI}`);
  const names = await page.evaluate(() => {
    const w = window as unknown as { __city: { layout: { islands: { id: string; name: string }[] } } };
    return Object.fromEntries(w.__city.layout.islands.map((i) => [i.id, i.name]));
  });

  // Same island: a press and release on one island is a tap
  // (it picks the target), never a lane and never a toast.
  await drag(page, API, API);
  expect((await laneDebug(page)).confirming).toBe(false);
  await expect(page.locator("#toast")).toBeHidden();
  await expect(page.locator("#quest-task")).toHaveValue("");
  await page.locator("#questlog-close").click();

  // Duplicate: web already imports shared.
  await drag(page, SHARED, WEB);
  await expect(page.locator("#toast")).toContainText(`${names[WEB]} already uses ${names[SHARED]}.`);
  expect((await laneDebug(page)).confirming).toBe(false);

  // Multi-hop cycle: cli -> api would close
  // api -> shared -> cli. (The toast truncates the loop, so
  // only its head is asserted here; the full loop text is
  // covered by the lane unit tests.)
  await drag(page, CLI, API);
  const toast = page.locator("#toast");
  await expect(toast).toContainText("That would close an import cycle:");
  await expect(toast).toContainText(names[CLI]);
  expect((await laneDebug(page)).confirming).toBe(false);

  // Valid drop: the quest form opens as the confirm card with
  // the task prefilled, editable, target picked, lane drawn.
  await drag(page, CLI, WEB);
  await expect(page.locator("#questlog")).toBeVisible();
  await expect(page.locator("#quest-task")).toHaveValue(
    `Connect ${names[WEB]} to ${names[CLI]} so ${names[WEB]} can use ${names[CLI]}`,
  );
  await expect(page.locator("#island-select")).toHaveValue(WEB);
  expect((await laneDebug(page)).confirming).toBe(true);
  await page.locator("#quest-task").fill("Hook web up to cli");

  // A drag quest without an agent does no work: watch refuses
  // at create, on the card, in words. (The agent select
  // defaults to Claude, which would spawn a live run here.)
  await page.locator("#agent-select").selectOption("watch");
  await page.locator("#create-btn").click();
  await expect(page.locator("#detail-error")).toContainText("needs an agent");

  // Escape cancels the confirm: no quest, no lane, log shut.
  // Only the bootstrapped token remains.
  await page.keyboard.press("Escape");
  await expect(page.locator("#questlog")).toBeHidden();
  expect(await laneDebug(page)).toEqual({ lanes: 0, confirming: false, preview: false });
  await expect(page.locator("#tokens .token")).toHaveCount(1);
  await expect(page.locator("#tokens .token", { hasText: "Hook web up" })).toHaveCount(0);

  // A drag quest seeded through the API draws its lane after
  // reload: reconcile runs against the real extraction.
  const created = await fetch(`${SERVER}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-repo-city": "1", origin: "http://localhost:5173" },
    body: JSON.stringify({
      repo_path: repoDir,
      island_id: WEB,
      source_island_id: CLI,
      task: "e2e lane",
      spawn: false,
    }),
  });
  if (!created.ok) throw new Error(`seed quest refused: ${await created.text()}`);
  await page.reload();
  await expect(page.locator("#status")).toContainText("Repo City · 4 islands");
  await expect(page.locator("#tokens .token", { hasText: "e2e lane" })).toHaveCount(1);
  await expect.poll(() => laneDebug(page).then((d) => d.lanes)).toBe(1);

  // Quest on target: web already holds a working quest, so a
  // second drop onto it refuses (its own validator, in words).
  await drag(page, API, WEB);
  await expect(page.locator("#toast")).toContainText(`${names[WEB]} already has a working quest.`);
  expect((await laneDebug(page)).confirming).toBe(false);

  expect(errors).toEqual([]);
});
