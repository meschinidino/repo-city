import { test, expect } from "@playwright/test";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Day-3 gate journey, browser half: open a repo -> islands from the
 * real extraction -> an edit lands as a real watcher event -> the
 * ship docks and the building lights -> Stop -> English report from
 * the real diff. The edit is made by this test on the filesystem
 * (like a shell edit); NO agent is spawned in this journey, so it
 * proves the watcher/report path, not live-agent behavior.
 */

const SERVER_PORT = 8800 + Math.floor(Math.random() * 400);
const SERVER = `http://127.0.0.1:${SERVER_PORT}`;
let serverProc: ChildProcess | undefined;
let repoDir = "";
let workRoot = "";

function git(args: string[]) {
  execSync(`git ${args.join(" ")}`, {
    cwd: repoDir,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@test", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@test" },
    stdio: "pipe",
  });
}

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
  workRoot = mkdtempSync(join(tmpdir(), "repo-city-e2e-"));
  repoDir = join(workRoot, "repo");
  cpSync(join(serverDir, "tests/fixtures/sample-monorepo"), repoDir, { recursive: true });
  git(["init", "-q"]);
  git(["add", "."]);
  git(["commit", "-qm", "fixture"]);
  serverProc = spawn(join(serverDir, "target/debug/repo-city-server-bin"), ["--port", String(SERVER_PORT), "--db", join(workRoot, "e2e.db")], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${SERVER}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("repo-city server did not come up");
});

test.afterAll(() => {
  serverProc?.kill();
  if (workRoot) rmSync(workRoot, { recursive: true, force: true });
});

test("city gate journey (watcher-driven, no agent): islands, lit building, report", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

  await page.goto(`/?repo=${encodeURIComponent(repoDir)}&server=${encodeURIComponent(SERVER)}`);
  await expect(page.locator("#status")).toContainText("Repo City · 4 islands · 12 buildings");
  const islands = await page.evaluate(() => {
    const c = (window as unknown as { __city: { layout: { islands: { id: string }[] } } }).__city;
    return c.layout.islands.map((i) => i.id).sort();
  });
  expect(islands).toEqual(["@fixture/api", "@fixture/cli", "@fixture/shared", "@fixture/web"]);

  // A shell-style edit: nothing names this file except the watcher.
  appendFileSync(join(repoDir, "packages/api/src/index.ts"), "\n// e2e touch\n");
  await page.waitForFunction(() => {
    const c = (window as unknown as { __city: { view: { litFiles: string[]; shipFile: string | null } } }).__city;
    return c.view.litFiles.includes("packages/api/src/index.ts") && c.view.shipFile === "packages/api/src/index.ts";
  }, undefined, { timeout: 30_000 });
  await expect(page.locator("#status")).toContainText("ship at packages/api/src/index.ts");

  // The drawing follows the state: the ship sprite ends up at the
  // lit building's screen position, not just in the view model.
  await page.waitForFunction(() => {
    const c = (window as unknown as { __city: { city: { shipScreenPos(): [number, number]; fileScreenPos(f: string): [number, number] | null; shipVisible: boolean } } }).__city;
    if (!c.city.shipVisible) return false;
    const [sx, sy] = c.city.shipScreenPos();
    const target = c.city.fileScreenPos("packages/api/src/index.ts");
    if (!target) return false;
    return Math.hypot(sx - target[0], sy - target[1]) < 180;
  }, undefined, { timeout: 30_000 });

  await page.locator("#stop-report").click();
  await expect(page.locator("#report")).toContainText("template_from_diff");
  await expect(page.locator("#report")).toContainText("Changed 1 file");
  expect(errors).toEqual([]);
});
