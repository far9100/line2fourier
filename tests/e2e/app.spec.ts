import type { Page } from '@playwright/test';
import { debug, evalDebug, expect, inkNear, open, openStill, test, type Point } from './fixtures.ts';

/** The share of the drawing's line that is on screen in black (one stretch in eight looked at). */
async function lineDrawn(page: Page): Promise<number> {
  const mids = (await evalDebug<Point[]>(page, 'mids', 0)).filter((_, i) => i % 8 === 0);
  let drawn = 0;
  for (const p of mids) if (await inkNear(page, p, 4)) drawn++;
  return drawn / mids.length;
}

test('opens playing a drawing, with the page in Traditional Chinese', async ({ page, problems }) => {
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-TW');
  await expect(page.locator('.bar button')).toHaveText(['清除', '自己畫', '上傳圖片', '重播']); // the whole bar (D51)
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
  await expect(page.locator('.bar button')).toHaveText(['Clear', 'Draw your own', 'Upload image', 'Replay']);
  await expect(page.locator('#demo')).toHaveText('Show convergence');
  await page.reload();
  await expect(page.locator('#clear')).toHaveText('Clear');
  await page.getByRole('button', { name: '中文' }).click();
  await expect(page.locator('#clear')).toHaveText('清除');
});

test('the same seed draws the same thing; without one the page picks one; a seed typed in draws that drawing', async ({ page }) => {
  await open(page, 'gen=star&seed=7&play=0');
  const first = await debug(page);
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { __l2f?: unknown }).__l2f);
  const again = await debug(page);
  expect(again.metrics).toEqual(first.metrics);
  expect(again.used).toEqual(first.used);
  // No seed in the address: the page picks one, and shows it under More settings.
  await open(page, 'gen=star&play=0');
  const next = await debug(page);
  expect(next.state.source.generator).toBe('star');
  expect(next.state.source.seed).not.toBe(7);
  await expect(page.locator('#seed')).toHaveValue(String(next.state.source.seed));
  // The first seed typed there brings the first drawing back.
  await page.locator('#advanced-title').click();
  await page.locator('#seed').fill('7');
  await page.locator('#seed-apply').click();
  const back = await debug(page);
  expect(back.state.source).toEqual({ type: 'random', generator: 'star', seed: 7 });
  expect(back.metrics).toEqual(first.metrics);
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

test('a drawing is drawn once: the pen stops where it started with the whole line on screen, and Replay draws it again (D50)', async ({ page }) => {
  test.slow(); // half a minute of the page's time, every frame of it drawn
  await openStill(page, 'gen=creature&seed=42&play=0'); // a cycle takes 8 s of the page's time
  await page.getByText('顯示圓', { exact: true }).click(); // only the line, to look at it
  await page.locator('#replay').click();

  // Half way: half of the line. Space pauses there, as before.
  await page.clock.runFor(4000);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Space');
  await page.clock.runFor(500);
  const half = await debug(page);
  expect(half.state.playing).toBe(false);
  expect(half.finished).toBe(false);
  expect(half.t).toBeCloseTo(0.5, 6);
  const some = await lineDrawn(page);
  expect(some).toBeGreaterThan(0.3);
  expect(some).toBeLessThan(0.85);
  await page.keyboard.press('Space');

  // The pen comes back to where it started and stops there, all of the line drawn.
  await page.clock.runFor(3900);
  expect((await debug(page)).finished).toBe(false);
  await page.clock.runFor(200);
  const done = await debug(page);
  expect(done.finished).toBe(true);
  expect(done.t).toBeGreaterThan(0.999);
  expect(done.state.playing).toBe(true); // not paused: the next drawing is drawn without being asked
  await page.clock.runFor(2000);
  expect((await debug(page)).t).toBe(done.t);
  expect(await lineDrawn(page)).toBeGreaterThan(0.9);

  // More circles: the whole of the new curve, still stopped.
  await page.keyboard.press('ArrowRight');
  await page.clock.runFor(100);
  expect(await debug(page)).toMatchObject({ M: 60, finished: true, t: done.t });
  expect(await lineDrawn(page)).toBeGreaterThan(0.9);

  // Replay starts over: when the drawing is done ...
  await page.locator('#replay').click();
  await page.clock.runFor(1000);
  const replay = await debug(page);
  expect(replay.finished).toBe(false);
  expect(replay.t).toBeGreaterThan(0.12);
  expect(replay.t).toBeLessThan(0.13);
  // ... while it is being drawn ...
  await page.locator('#replay').click();
  await page.clock.runFor(160);
  expect((await debug(page)).t).toBeCloseTo(0.02, 6);
  // ... and from a pause, which it ends (D51).
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Space');
  expect((await debug(page)).state.playing).toBe(false);
  await page.locator('#replay').click();
  await page.clock.runFor(160);
  const resumed = await debug(page);
  expect(resumed.state.playing).toBe(true);
  expect(resumed.t).toBeCloseTo(0.02, 6);
  // Space draws a finished drawing again, too.
  await page.clock.runFor(8000);
  expect((await debug(page)).finished).toBe(true);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Space');
  await page.clock.runFor(1000);
  expect((await debug(page)).finished).toBe(false);

  // Another drawing after one is done is drawn too.
  await page.clock.runFor(7100);
  expect((await debug(page)).finished).toBe(true);
  await page.locator('#advanced-title').click();
  await page.locator('#seed').fill('43');
  await page.locator('#seed-apply').click();
  await page.clock.runFor(1000);
  const next = await debug(page);
  expect(next.state.source.seed).toBe(43);
  expect(next.finished).toBe(false);
  expect(next.t).toBeGreaterThan(0.12);
  expect(next.t).toBeLessThan(0.13);
});

test('the demo ends by itself: the circles there were before, the whole line, the pen stopped (D50)', async ({ page }) => {
  test.slow(); // 35 s of the page's time, every frame of it drawn
  await openStill(page);
  await page.getByText('顯示圓', { exact: true }).click(); // less to draw in each frame
  await page.locator('#demo').click();
  // Each count takes 3.5 s: look in the middle of each. With frames 16 ms apart the fourth count ends
  // on a frame exactly (14 s is 875 of them), the time a hair short of the end without having gone
  // round: that is not the end of the drawing, and the demo goes on to 10 circles.
  await page.clock.runFor(1750);
  for (const M of [1, 2, 3, 5, 10, 20, 50, 100, 300, 1000]) {
    const d = await debug(page);
    expect(d.M).toBe(M);
    expect(d.finished).toBe(false);
    await page.clock.runFor(3500);
  }
  const d = await debug(page);
  expect(d.state.demo).toBeNull();
  expect(d.M).toBe(50);
  expect(d.finished).toBe(true);
  await expect(page.locator('#demo')).toHaveAttribute('aria-pressed', 'false');
  expect(await lineDrawn(page)).toBeGreaterThan(0.9);
});

/** Dark pixels on the canvas: the line, and nothing else, is that dark. */
const darkPixels = (page: Page) => page.evaluate(() => {
  const c = document.querySelector('#view') as HTMLCanvasElement;
  const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (Math.max(data[i], data[i + 1], data[i + 2]) < 110) n++;
  return n;
});

test('Clear empties the canvas, and what needs a drawing is put away until a line is drawn (D51)', async ({ page }) => {
  await open(page);
  await page.waitForTimeout(300);
  expect(await darkPixels(page)).toBeGreaterThan(0);
  await page.locator('#clear').click();
  const cleared = await debug(page);
  expect(cleared.empty).toBe(true);
  expect(cleared.state.source).toBeNull();
  await expect(page.locator('#empty-hint')).toBeVisible();
  await expect(page.locator('#empty-hint')).toContainText('畫布是空的');
  await expect(page.locator('#status')).toHaveText('沒有線稿');
  await expect(page.locator('#clear')).toBeDisabled();
  await expect(page.locator('#replay')).toBeDisabled();
  await expect(page.locator('#demo')).toBeDisabled();
  for (const id of ['#metric-rms', '#spectrum-section', '#outputs-section']) await expect(page.locator(id)).toBeHidden();
  // A project can still be opened from the panel; there is none to save, and nothing to copy.
  await page.locator('#export-title').click();
  await expect(page.locator('#project-open')).toBeVisible();
  await expect(page.locator('#project-save')).toBeDisabled();
  await expect(page.locator('#copy-desmos')).toBeHidden();
  await expect(page.locator('#download-svg')).toBeHidden();
  // Nothing is drawn, and the keys that act on a drawing do no harm (a script error fails the test).
  await page.waitForTimeout(100);
  expect(await darkPixels(page)).toBe(0);
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  expect((await debug(page)).empty).toBe(true);

  // A line drawn by hand fills the canvas again, and is drawn by the circles.
  await page.locator('#draw').click();
  await expect(page.locator('#empty-hint')).toBeHidden();
  await expect(page.locator('#replay')).toBeDisabled();
  const box = (await page.locator('#view').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 200, cy);
  await page.mouse.down();
  for (let i = 0; i <= 40; i++) await page.mouse.move(cx - 200 + 10 * i, cy + 120 * Math.sin(i / 6));
  await page.mouse.up();
  await expect.poll(async () => (await debug(page)).empty).toBe(false);
  const drawn = await debug(page);
  expect(drawn.state.source.type).toBe('freehand');
  expect(drawn.state.playing).toBe(true);
  await expect(page.locator('#replay')).toBeEnabled();
  await expect(page.locator('#clear')).toBeEnabled();
  await expect(page.locator('#metric-rms')).toBeVisible();
  await expect(page.locator('#copy-desmos')).toBeVisible();

  // Clear while drawing by hand leaves drawing, too.
  await page.locator('#draw').click();
  expect((await debug(page)).state.mode).toBe('draw');
  await page.locator('#clear').click();
  const again = await debug(page);
  expect(again.state.mode).toBe('play');
  expect(again.empty).toBe(true);
  await expect(page.locator('#draw-overlay')).toBeHidden();
  await expect(page.locator('#empty-hint')).toBeVisible();
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
  await page.locator('#advanced-title').click();
  await page.getByText('依頻率', { exact: true }).click();
  const byFreq = await debug(page);
  expect(byFreq.state.order).toBe('frequency');
  expect(byFreq.used.slice(0, 4)).toEqual([1, -1, 2, -2]);
  expect(byFreq.metrics.rmsError).toBeGreaterThanOrEqual(bySize.metrics.rmsError);
  await page.locator('#n-select').selectOption('4096');
  expect((await debug(page)).N).toBe(4096);
  await page.getByText('顯示圓', { exact: true }).click();
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
