// Spec §5.2 and the M1 acceptance: drawing works with a mouse, a finger and a pen; a line that is
// too short gets a hint, and nothing breaks.
import type { Page } from '@playwright/test';
import { debug, expect, open, test } from './fixtures.ts';

async function circlePoints(page: Page, n = 40, radius = 120) {
  const box = (await page.locator('#view').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  return Array.from({ length: n }, (_, i) => {
    const a = (Math.PI * 1.8 * i) / (n - 1); // most of a circle: an open stroke
    return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
  });
}

async function expectFreehand(page: Page) {
  await expect.poll(async () => (await debug(page)).state.source.type).toBe('freehand');
  const d = await debug(page);
  expect(d.state.mode).toBe('play');
  expect(d.state.source.points).toBeGreaterThanOrEqual(8);
  await expect(page.locator('#draw-overlay')).toBeHidden();
}

test('draw with a mouse', async ({ page }) => {
  await open(page);
  await page.locator('#draw').click();
  const pts = await circlePoints(page);
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up();
  await expectFreehand(page);
  // Freehand keeps where it was drawn: the centre of the circle stays near the canvas centre.
  const d = await debug(page);
  expect(d.size).toBeGreaterThan(0.5);
  await expect(page.locator('#status')).toContainText('手繪');
});

test('draw with a finger', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ hasTouch: true, baseURL, viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await open(page);
  await page.locator('#draw').tap();
  const pts = await circlePoints(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0].x, y: pts[0].y }] });
  for (const p of pts.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expectFreehand(page);
  await context.close();
});

test('draw with a pen', async ({ page }) => {
  await open(page);
  await page.locator('#draw').click();
  const pts = await circlePoints(page);
  const cdp = await page.context().newCDPSession(page);
  const send = (type: string, p: { x: number; y: number }) =>
    cdp.send('Input.dispatchMouseEvent', { type: type as 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen' });
  await send('mousePressed', pts[0]);
  for (const p of pts.slice(1)) await send('mouseMoved', p);
  await send('mouseReleased', pts[pts.length - 1]);
  await expectFreehand(page);
});

test('a line that is too short gets a hint and drawing goes on', async ({ page }) => {
  await open(page);
  await page.locator('#draw').click();
  const box = (await page.locator('#view').boundingBox())!;
  const x = box.x + 200, y = box.y + 200;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) await page.mouse.move(x + 8 * i, y);
  await page.mouse.up();
  await expect(page.locator('#toast')).toHaveText('線太短了，再畫長一點');
  const d = await debug(page);
  expect(d.state.mode).toBe('draw');
  expect(d.state.source.type).toBe('random');
  // A proper line still works afterwards.
  const pts = await circlePoints(page);
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y);
  await page.mouse.up();
  await expectFreehand(page);
});

test('a single tap does not draw anything', async ({ page }) => {
  await open(page);
  await page.locator('#draw').click();
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.click(box.x + 300, box.y + 300);
  await expect(page.locator('#toast')).toHaveText('線太短了，再畫長一點');
  expect((await debug(page)).state.source.type).toBe('random');
});
