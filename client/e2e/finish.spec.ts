import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * T6 finish journey: a stopped quest shows the finish section
 * on its report card; Keep keeps it, Accept on a worktree-less
 * quest refuses honestly on the card, and Discard discards it.
 * Watcher-only quests (no agent spawns); the merge itself is
 * covered by the server HTTP suite with real worktrees.
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
  workRoot = mkdtempSync(join(tmpdir(), "repo-city-finish-"));
  repoDir = join(workRoot, "repo");
  cpSync(join(serverDir, "tests/fixtures/sample-monorepo"), repoDir, { recursive: true });
  for (let attempt = 0; attempt < 5 && !SERVER; attempt++) {
    const port = 9600 + Math.floor(Math.random() * 400);
    const candidate = `http://127.0.0.1:${port}`;
    const occupied = await fetch(`${candidate}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
    if (occupied) continue;
    serverProc = spawn(bin, ["--port", String(port), "--db", join(workRoot, "finish.db")], { stdio: "ignore" });
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

test("finish journey: keep, accept refusal, discard from the card", async ({ page }) => {
  await page.goto(`/?repo=${encodeURIComponent(repoDir)}&server=${encodeURIComponent(SERVER)}`);
  await expect(page.locator("#status")).toContainText("Repo City · 4 islands");
  await page.locator("#new-quest").click();
  await expect(page.locator("#questlog")).toBeVisible();
  const islandA = await page.locator("#island-select option").nth(1).getAttribute("value");
  const islandB = await page.locator("#island-select option").nth(2).getAttribute("value");

  // Quest one: stop it, open the card, keep it for later.
  await page.locator("#quest-task").fill("Keep this quest");
  await page.locator("#island-select").selectOption(islandA!);
  await page.locator("#agent-select").selectOption("watch");
  await page.locator("#create-btn").click();
  await expect(page.locator("#detail-title")).toHaveText("Keep this quest");
  await page.locator("#act-stop").click();
  await expect(page.locator("#detail-state")).toContainText("stopped");
  // Regression ISSUE-QA2: the follow-up input showed on quests
  // that cannot take a follow-up (no CLI session), its button
  // hidden but its input dangling. Found by /gstack-qa on 2026-10-29.
  await expect(page.locator("#follow-task")).toBeHidden();
  await page.locator("#act-report").click();
  const card = page.locator("#report");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Finish");
  await expect(card).toContainText("Merge into:");
  await card.getByRole("button", { name: "Keep for later" }).click();
  await expect(card).toContainText("Kept for later");
  await card.getByRole("button", { name: "Back to report" }).click();
  await expect(card).toContainText("Merge into:");
  await expect(page.locator("#tokens .token", { hasText: "kept" })).toHaveCount(1);
  // The open card covers the create button: close it, like a user would.
  await page.locator("#report-close").click();

  // Quest two: Accept on a worktree-less quest refuses on the
  // card (the server's own words), then Discard discards it.
  await page.locator("#quest-task").fill("Discard me");
  await page.locator("#island-select").selectOption(islandB!);
  await page.locator("#create-btn").click();
  await expect(page.locator("#detail-title")).toHaveText("Discard me");
  await page.locator("#act-stop").click();
  await page.locator("#act-report").click();
  await expect(card).toContainText("Merge into:");
  await card.getByRole("button", { name: "Accept" }).click();
  await expect(card).toContainText("Accept this quest?");
  await card.getByRole("button", { name: "Merge and run checks" }).click();
  await expect(card.locator(".report-err")).toContainText("no worktree");
  await card.getByRole("button", { name: "Back" }).click();
  await expect(card).toContainText("Merge into:");
  await card.getByRole("button", { name: "Discard" }).click();
  await expect(card).toContainText("Discard this quest?");
  await card.getByRole("button", { name: "Discard the work" }).click();
  await expect(card).toContainText("Discarded");
  await card.getByRole("button", { name: "Back to report" }).click();
  await expect(card).toContainText("Quest discarded");
  await expect(page.locator("#tokens .token", { hasText: "discarded" })).toHaveCount(1);

  // Discarded quests still archive out of the bar.
  await page.locator("#report-close").click();
  await page.locator("#act-archive").click();
  await expect(page.locator("#tokens .token")).toHaveCount(2);
});
