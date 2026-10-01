import { debug, expect, open, test } from './fixtures.ts';

test('opens playing a drawing, with the page in Traditional Chinese', async ({ page, problems }) => {
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
  await expect(page.locator('#new-drawing')).toHaveText('換一張線稿');
  const a = await debug(page);
  await page.waitForTimeout(500);
  const b = await debug(page);
  expect(b.state.playing).toBe(true);
  expect(b.t).toBeGreaterThan(a.t);
  expect(b.state.source).toEqual({ type: 'random', generator: 'creature', seed: 42 });
  expect(b.frame!.circlesDrawn).toBeGreaterThan(5);
  // Brass trail pixels near the pen.
  const [x, y] = await page.evaluate(() => {
    const w = window as unknown as { __l2f: { debug(): { frame: { tip: [number, number] } } } };
    return w.__l2f.debug().frame.tip;
  });
  expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
  expect(await problems.csp()).toEqual([]);
});

test('switches to English and remembers it', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'EN' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#new-drawing')).toHaveText('New drawing');
  await expect(page.locator('#metric-largest')).toContainText('per cycle');
  await page.reload();
  await expect(page.locator('#new-drawing')).toHaveText('New drawing');
  await page.getByRole('button', { name: '中文' }).click();
  await expect(page.locator('#new-drawing')).toHaveText('換一張線稿');
});

test('the same seed draws the same thing; a new drawing gets a new seed', async ({ page }) => {
  await open(page, 'gen=star&seed=7&play=0');
  const first = await debug(page);
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __l2f?: unknown }).__l2f);
  const again = await debug(page);
  expect(again.metrics).toEqual(first.metrics);
  expect(again.used).toEqual(first.used);
  await page.locator('#new-drawing').click();
  const next = await debug(page);
  expect(next.state.source.generator).toBe('star');
  expect(next.state.source.seed).not.toBe(7);
  await expect(page.locator('#seed')).toHaveValue(String(next.state.source.seed));
});

test('keys: Space plays and pauses, arrows change M, D draws, Esc cancels', async ({ page }) => {
  await open(page);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Space');
  expect((await debug(page)).state.playing).toBe(false);
  await page.keyboard.press('ArrowRight');
  expect((await debug(page)).M).toBe(60);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  expect((await debug(page)).M).toBe(40);
  await page.keyboard.press('Shift+ArrowRight');
  expect((await debug(page)).M).toBe(41);
  await page.keyboard.press('d');
  expect((await debug(page)).state.mode).toBe('draw');
  await expect(page.locator('#draw-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  expect((await debug(page)).state.mode).toBe('play');
});

test('the circle slider and number box move M over the spec’s scale', async ({ page }) => {
  await open(page);
  await page.locator('#m-number').fill('7');
  await page.locator('#m-number').press('Enter');
  expect((await debug(page)).M).toBe(7);
  await page.locator('#m-number').fill('5000');
  await page.locator('#m-number').press('Tab');
  expect((await debug(page)).M).toBe(1023);
  await page.locator('#m-range').focus();
  await page.keyboard.press('Home');
  expect((await debug(page)).M).toBe(1);
  await page.keyboard.press('ArrowRight');
  expect((await debug(page)).M).toBe(2);
});

test('the demo steps through the circle counts and gives M back', async ({ page }) => {
  await open(page);
  await page.locator('#demo').click();
  expect((await debug(page)).M).toBe(1);
  await expect(page.locator('#demo')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await debug(page)).M, { timeout: 6000 }).toBe(2);
  await page.locator('#demo').click();
  const d = await debug(page);
  expect(d.state.demo).toBeNull();
  expect(d.M).toBe(50);
});

test('reduced motion: starts paused, with the whole approximation shown', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const d = await debug(page);
  expect(d.state.playing).toBe(false);
  expect(d.firstCycleDone).toBe(true);
  await page.waitForTimeout(300);
  expect((await debug(page)).t).toBe(0);
});

test('order, N and the toggles change what is computed and drawn', async ({ page }) => {
  await open(page, 'gen=star&seed=42&play=0');
  const bySize = await debug(page);
  await page.getByText('依頻率').click();
  const byFreq = await debug(page);
  expect(byFreq.state.order).toBe('frequency');
  expect(byFreq.used.slice(0, 4)).toEqual([1, -1, 2, -2]);
  expect(byFreq.metrics.rmsError).toBeGreaterThanOrEqual(bySize.metrics.rmsError);
  await page.locator('summary').click();
  await page.locator('#n-select').selectOption('4096');
  expect((await debug(page)).N).toBe(4096);
  await page.getByText('顯示圓').click();
  await page.waitForTimeout(100);
  expect((await debug(page)).frame!.circlesDrawn).toBe(0);
});

test('a phone-sized screen stacks the panel under the canvas', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const canvas = await page.locator('#view').boundingBox();
  const panel = await page.locator('.panel').boundingBox();
  expect(panel!.y).toBeGreaterThan(canvas!.y + canvas!.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
