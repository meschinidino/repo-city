import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * T12 harbor journey: the bar lists the repo's sessions, a quest
 * is created from the form (watcher only — no agent is spawned),
 * the quest pauses, resumes, and archives from the quest log, and
 * the 3-quest cap speaks in words. Sessions are real server
 * sessions against a fixture repo copy.
 */

let SERVER = "";
let serverProc: ChildProcess | undefined;
let repoDir = "";
let workRoot = "";

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
  workRoot = mkdtempSync(join(tmpdir(), "repo-city-harbor-"));
  repoDir = join(workRoot, "repo");
  cpSync(join(serverDir, "tests/fixtures/sample-monorepo"), repoDir, { recursive: true });
  for (let attempt = 0; attempt < 5 && !SERVER; attempt++) {
    const port = 9200 + Math.floor(Math.random() * 400);
    const candidate = `http://127.0.0.1:${port}`;
    const occupied = await fetch(`${candidate}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
    if (occupied) continue;
    serverProc = spawn(bin, ["--port", String(port), "--db", join(workRoot, "harbor.db")], { stdio: "ignore" });
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

test("harbor bar journey: tokens, create, cap, pause, archive", async ({ page }) => {
  await page.goto(`/?repo=${encodeURIComponent(repoDir)}&server=${encodeURIComponent(SERVER)}`);
  await expect(page.locator("#status")).toContainText("Repo City · 4 islands");

  // The primary session is a token in the bar.
  await expect(page.locator("#tokens .token")).toHaveCount(1);

  // Create two quests from the form (watch only: no agent spawns).
  await page.locator("#new-quest").click();
  await expect(page.locator("#questlog")).toBeVisible();
  // Two working quests may not hold the same island (server lock),
  // so each quest takes its own island.
  const islandA = await page.locator("#island-select option").nth(1).getAttribute("value");
  const islandB = await page.locator("#island-select option").nth(2).getAttribute("value");
  for (const [task, islandValue] of [["Fix the sample quest", islandA], ["Tidy the sample docs", islandB]] as const) {
    await page.locator("#quest-task").fill(task);
    await page.locator("#island-select").selectOption(islandValue!);
    await page.locator("#agent-select").selectOption("watch");
    await page.locator("#create-btn").click();
    await expect(page.locator("#detail-title")).toHaveText(task);
  }
  await expect(page.locator("#tokens .token")).toHaveCount(3);

  // The map follows the quest just created: its ship docks at
  // that quest's island before any file event exists.
  const docked = await page.evaluate((island) => {
    const c = (window as unknown as { __city: { view: { shipIsland: string | null; sessionId: string }; city: { shipVisible: boolean } } }).__city;
    return c.view.shipIsland === island && c.city.shipVisible;
  }, islandB);
  expect(docked).toBe(true);

  // Watch-only quests do not count toward the server cap (only
  // spawned working quests with worktrees do): create stays open.
  // The cap rule itself is unit-tested in bar.test.ts.
  await expect(page.locator("#create-btn")).toBeEnabled();
  await expect(page.locator("#cap-note")).toBeHidden();

  // Muse is a first-class agent choice: picking it swaps the
  // model and effort lists to the Muse words (Spark model,
  // Ultra effort), and the selects stay enabled.
  await page.locator("#agent-select").selectOption("muse");
  await expect(page.locator("#model-select")).toBeEnabled();
  await expect(page.locator("#model-select option[value='muse-spark-1.3']")).toHaveCount(1);
  await expect(page.locator("#effort-select option[value='ultra']")).toHaveCount(1);
  await page.locator("#agent-select").selectOption("watch");
  await expect(page.locator("#model-select")).toBeDisabled();

  // Pause and resume the selected quest from the quest log.
  await page.locator("#act-pause").click();
  await expect(page.locator("#detail-state")).toContainText("paused");
  // The agent feed shows the quest's real event lines, and a
  // watch-only quest offers no message box (no agent runs).
  await expect(page.locator("#agent-feed")).toContainText("Session paused.");
  await expect(page.locator("#msg-row")).toBeHidden();
  await page.locator("#act-resume").click();
  await expect(page.locator("#detail-state")).toContainText("working");

  // Stop, then archive: the token leaves the bar.
  await page.locator("#act-stop").click();
  await expect(page.locator("#detail-state")).toContainText("stopped");
  await page.locator("#act-archive").click();
  await expect(page.locator("#tokens .token")).toHaveCount(2);
  await expect(page.locator("#create-btn")).toBeEnabled();
});
