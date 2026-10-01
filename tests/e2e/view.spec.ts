// DECISIONS.md D45: the drawing fills the window and can be looked at closely: the wheel zooms about
// the pointer, dragging moves it, a double click (or 0) shows it whole, and it can go full screen.
import type { Page } from '@playwright/test';
import { debug, expect, open, test } from './fixtures.ts';

interface Cam { s: number; cx: number; cy: number; ox: number; oy: number }
const camera = async (page: Page) => (await debug(page) as unknown as { camera: Cam }).camera;
const world = (c: Cam, x: number, y: number) => [c.cx + (x - c.ox) / c.s, c.cy - (y - c.oy) / c.s];

test('the drawing fills the window: no page scroll, the canvas most of it, the drawing most of the canvas', async ({ page }) => {
  await open(page, 'gen=creature&seed=42&play=0');
  const vp = page.viewportSize()!;
  const box = (await page.locator('#view').boundingBox())!;
  expect(box.width).toBeGreaterThan(0.7 * vp.width);
  expect(box.height).toBeGreaterThan(0.85 * vp.height);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(vp.height);
  const d = await debug(page) as unknown as { scale: number; size: number };
  expect(d.scale * d.size).toBeGreaterThan(0.88 * Math.min(box.width, box.height));
});

test('the wheel zooms about the pointer, dragging moves the view, a double click shows it whole', async ({ page }) => {
  await open(page, 'gen=star&seed=3&play=0');
  const box = (await page.locator('#view').boundingBox())!;
  // Whole pixels: the browser rounds a mouse event's position.
  const clientX = Math.round(box.x + box.width / 2 + 120), clientY = Math.round(box.y + box.height / 2 - 60);
  const px = clientX - box.x, py = clientY - box.y;
  const before = await camera(page);
  await page.mouse.move(clientX, clientY);
  await page.mouse.wheel(0, -500);
  await expect.poll(async () => (await camera(page)).s).toBeGreaterThan(2 * before.s);
  const zoomed = await camera(page);
  const [ax, ay] = world(before, px, py), [bx, by] = world(zoomed, px, py);
  expect(Math.abs(bx - ax) * zoomed.s).toBeLessThan(1); // the point under the pointer stayed put
  expect(Math.abs(by - ay) * zoomed.s).toBeLessThan(1);
  await expect(page.locator('#view-zoom')).not.toHaveText('1×');

  await page.mouse.down();
  await page.mouse.move(clientX - 100, clientY + 40, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await camera(page)).cx).not.toBe(zoomed.cx);
  const moved = await camera(page);
  expect((moved.cx - zoomed.cx) * moved.s).toBeCloseTo(100, 0);
  expect((moved.cy - zoomed.cy) * moved.s).toBeCloseTo(40, 0);

  await page.mouse.dblclick(clientX, clientY);
  await expect(page.locator('#view-zoom')).toHaveText('1×');
  expect((await camera(page)).s).toBeCloseTo(before.s, 6);
});

test('the zoom buttons and keys, and drawing by hand is left alone', async ({ page }) => {
  await open(page, 'gen=scribble&seed=5&play=0');
  const fit = await camera(page);
  await page.locator('#view-zoom-in').click();
  await expect(page.locator('#view-zoom')).toHaveText('1.5×');
  await page.locator('#view-fit').click();
  await expect(page.locator('#view-zoom')).toHaveText('1×');
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await expect(page.locator('#view-zoom')).toHaveText('2.3×');
  await page.keyboard.press('0');
  await expect(page.locator('#view-zoom')).toHaveText('1×');
  expect((await camera(page)).s).toBeCloseTo(fit.s, 6);

  await page.locator('#draw').click();
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(100);
  await expect(page.locator('#view-zoom')).toHaveText('1×');
});

test('full screen shows the canvas alone, and leaves again', async ({ page }) => {
  await open(page, 'gen=creature&seed=8&play=0');
  const button = page.locator('#view-fullscreen');
  test.skip(!(await button.isVisible()), 'this browser has no full screen');
  await button.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe('canvas-wrap');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('f');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null)).toBeNull();
});
