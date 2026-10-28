import { expect, test } from '@playwright/test';

// Responsive regression (QA round, PR #18): at phone width the
// quest log sheet must sit above the bar. The create button once
// overlapped the bar buttons because the sheet used a fixed
// offset while the bar wraps taller.
const file = (path: string, island_id: string) => ({ path, island_id, roles: [], building: 'cottage', import_count: 0, importer_count: 0 });
const EXTRACTION = {
  files: [file('frontend/a.ts', 'frontend'), file('frontend/b.ts', 'frontend'), file('frontend/c.ts', 'frontend'), file('backend/x.py', 'backend'), file('backend/y.py', 'backend')],
  root: '/tmp/demo-repo', islands_by_id: {},
  workspaces: [], skipped_workspaces: [], packages: [],
  islands: [
    { id: 'frontend', name: 'frontend', path: 'frontend', files: ['frontend/a.ts', 'frontend/b.ts', 'frontend/c.ts'], file_count: 3 },
    { id: 'backend', name: 'backend', path: 'backend', files: ['backend/x.py', 'backend/y.py'], file_count: 2 },
  ],
  bridges: [], counts: { parsed: 5, resolved: 0, unresolved: 0 },
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

  // The Close button shuts the panel.
  await page.locator('#questlog-close').click();
  await expect(page.locator('#questlog')).toBeHidden();

  // Island click opens the quest with that target; a click on
  // open water closes it again and clears the ring.
  const pts = await page.evaluate(() => {
    const c = (window as unknown as { __city: { city: { islandScreenPos: (id: string) => [number, number] | null; islandAtScreen: (x: number, y: number) => string | null } } }).__city.city;
    let isl: [number, number] | null = null;
    let water: [number, number] | null = null;
    for (let x = 8; x < innerWidth - 8 && (!isl || !water); x += 12) {
      for (let y = 8; y < innerHeight - 120 && (!isl || !water); y += 12) {
        const hit = c.islandAtScreen(x, y);
        if (hit === 'frontend' && !isl) isl = [x, y];
        if (!hit && !water) water = [x, y];
      }
    }
    return { isl, water };
  });
  expect(pts.isl).not.toBeNull();
  expect(pts.water).not.toBeNull();
  await page.mouse.click(pts.isl![0], pts.isl![1]);
  await expect(page.locator('#questlog')).toBeVisible();
  await expect(page.locator('#island-select')).toHaveValue('frontend');
  await page.mouse.click(pts.water![0], pts.water![1]);
  await expect(page.locator('#questlog')).toBeHidden();
});
