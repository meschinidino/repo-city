import { expect, test } from '@playwright/test';

// Responsive regression (QA round, PR #18): at phone width the
// quest log sheet must sit above the bar. The create button once
// overlapped the bar buttons because the sheet used a fixed
// offset while the bar wraps taller.
const EXTRACTION = {
  files: ['frontend/a.ts', 'backend/b.py'],
  root: '/tmp/demo-repo', islands_by_id: {},
  workspaces: [], skipped_workspaces: [], packages: [],
  islands: [
    { id: 'frontend', files: [], file_count: 1, roots: ['frontend'], link_file_count: 0 },
  ],
  bridges: [], counts: { parsed: 2, resolved: 0, unresolved: 0 },
};

test('narrow window: quest log does not overlap the bar', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.route('**/api/extraction**', (r) => r.fulfill({ json: EXTRACTION }));
  await page.route('**/api/sessions', (r) => r.fulfill({ json: [] }));
  await page.goto('/?repo=/tmp/demo-repo');
  await expect(page.locator('#status')).toContainText('islands');
  await page.locator('#new-quest').click();
  await expect(page.locator('#questlog')).toBeVisible();
  // The sheet has a 200ms rise animation; poll until it settles.
  await expect.poll(async () => page.evaluate(() => {
    const bar = document.getElementById('bar')!.getBoundingClientRect();
    const log = document.getElementById('questlog')!.getBoundingClientRect();
    return log.bottom <= bar.top + 1;
  })).toBe(true);
  const boxes = await page.evaluate(() => {
    const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    const [bar, log, create, fresh] = [r('bar'), r('questlog'), r('create-btn'), r('new-quest')];
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      logAboveBar: log.bottom <= bar.top + 1,
      createClear: create.bottom <= bar.top + 1 && !(create.left < fresh.right && create.right > fresh.left && create.top < fresh.bottom && create.bottom > fresh.top),
      logInView: log.top >= 0,
    };
  });
  expect(boxes.overflow).toBeLessThanOrEqual(0);
  expect(boxes.logAboveBar).toBe(true);
  expect(boxes.createClear).toBe(true);
  expect(boxes.logInView).toBe(true);
});
