// Spec §12 M2: SVG and curves.json import, chaining strokes with pen-up jumps that are not drawn,
// the spectrum panel in step with the circles, and following the pen.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { debug, expect, open, test } from './fixtures.ts';

const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url);

async function upload(page: Page, name: string) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#upload').click()]);
  await chooser.setFiles(fileURLToPath(fixture(name)));
  await expect(page.locator('#toast')).toContainText(/已匯入|Imported/, { timeout: 15_000 });
}

type Point = [number, number];
const evalDebug = <T,>(page: Page, fn: string, arg?: unknown) =>
  page.evaluate(([f, a]) => {
    const d = (window as unknown as { __l2f: { debug(): Record<string, unknown> } }).__l2f.debug();
    const v = d[f as string];
    return typeof v === 'function' ? (v as (x: unknown) => unknown)(a) : v;
  }, [fn, arg] as const) as Promise<T>;

/** Is there brass (the approximation's colour) within r pixels of the point? */
async function brassNear(page: Page, p: Point, r = 2): Promise<boolean> {
  return page.evaluate(([x, y, rad]) => {
    const c = document.querySelector('#view') as HTMLCanvasElement;
    const ratio = c.width / c.getBoundingClientRect().width;
    const size = 2 * rad + 1;
    const data = c.getContext('2d')!.getImageData(Math.round((x - rad) * ratio), Math.round((y - rad) * ratio), Math.round(size * ratio), Math.round(size * ratio)).data;
    for (let i = 0; i < data.length; i += 4) if (data[i + 2] - data[i] < -18) return true; // red well above blue
    return false;
  }, [p[0], p[1], r] as const);
}

test('an SVG with four shapes: chained with jumps that are not drawn, and the share shown', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); // paused, with the whole approximation drawn
  await open(page);
  await upload(page, 'four-shapes.svg');
  const d = await debug(page);
  expect(d.state.source).toMatchObject({ type: 'svg', name: 'four-shapes.svg', strokes: 4 });
  expect(d.jumpRatio).toBeGreaterThan(0);
  expect(d.jumpRatio).toBeLessThanOrEqual((d.state.source as unknown as { originalJumpRatio: number }).originalJumpRatio);
  await expect(page.locator('#metric-jumps-row')).toBeVisible();
  await expect(page.locator('#metric-jumps')).toContainText('原始順序');
  await expect(page.locator('#status')).toContainText('four-shapes.svg');

  // Circles and the original out of the way: brass along the drawing, none along the jumps.
  await page.getByText('顯示圓', { exact: true }).click();
  await page.getByText('顯示原始線稿', { exact: true }).click();
  await page.waitForTimeout(200);
  const jumps = await evalDebug<Point[]>(page, 'mids', 2);
  const inks = await evalDebug<Point[]>(page, 'mids', 0);
  expect(jumps.length).toBe(4); // three between the shapes and the one back to the start
  for (const p of jumps) expect(await brassNear(page, p), `jump at ${p}`).toBe(false);
  let drawn = 0;
  for (const p of inks) if (await brassNear(page, p, 3)) drawn++;
  expect(drawn / inks.length).toBeGreaterThan(0.9);
});

test('line2func curves.json: strokes chained, fill hatching left out and said so', async ({ page }) => {
  await open(page);
  await upload(page, 'curves-small.json');
  await expect(page.locator('#toast')).toContainText('略過 1 條填色斜線');
  const d = await debug(page);
  expect(d.state.source).toMatchObject({ type: 'line2func', strokes: 3 });
  expect(d.N).toBeGreaterThanOrEqual(1024);
});

test('the spectrum shows exactly the circles in use, and picking one marks it', async ({ page }) => {
  await open(page, 'gen=star&seed=42&play=0&M=50');
  for (const order of ['依大小', '依頻率']) {
    await page.getByText(order, { exact: true }).click();
    for (const M of [1, 50, 300]) {
      await page.locator('#m-number').fill(String(M));
      await page.locator('#m-number').press('Enter');
      await page.waitForTimeout(50);
      const d = await debug(page);
      const used = await evalDebug<number[]>(page, 'spectrumUsed');
      expect(new Set(used)).toEqual(new Set(d.used));
      // Every circle in use that is at least 0.8 px on screen is drawn, and nothing else.
      const box = (await page.locator('#view').boundingBox())!;
      const visible = d.circles.filter(c => c.r >= 0.8 && c.x + c.r >= 0 && c.x - c.r <= box.width && c.y + c.r >= 0 && c.y - c.r <= box.height);
      expect(d.frame!.circlesDrawn).toBe(visible.length);
    }
  }
  // Pick the k of the fifth circle in use by clicking its stem.
  await page.getByText('依大小', { exact: true }).click();
  const d = await debug(page);
  const k = d.used[4];
  await page.locator('#spectrum').scrollIntoViewIfNeeded();
  const x = await evalDebug<number>(page, 'spectrumX', k);
  const box = (await page.locator('#spectrum').boundingBox())!;
  await page.mouse.click(x, box.y + box.height / 2);
  expect((await debug(page)).state.selectedK).toBe(k);
  await expect(page.locator('#spectrum-readout')).toContainText(`k = ${k}`);
  // The mark is drawn with the next frame.
  await expect.poll(async () => (await debug(page)).highlight).not.toBeNull();
  const picked = await debug(page);
  expect(picked.highlight!.j).toBe(4);
  expect(Math.hypot(picked.highlight!.x - picked.circles[4].x, picked.highlight!.y - picked.circles[4].y)).toBeLessThan(1e-6);
});

test('the spectrum takes its own arrow keys; the page’s arrows still change M', async ({ page }) => {
  await open(page, 'gen=creature&seed=1&play=0');
  await page.locator('#spectrum').focus();
  await page.keyboard.press('ArrowRight');
  expect((await debug(page)).state.selectedK).toBe(1);
  await page.keyboard.press('ArrowLeft');
  expect((await debug(page)).state.selectedK).toBe(-1);
  expect((await debug(page)).M).toBe(50);
  await page.keyboard.press('Escape');
  expect((await debug(page)).state.selectedK).toBeNull();
});

test('following the pen keeps it in the middle of the canvas', async ({ page }) => {
  await open(page, 'gen=scribble&seed=4');
  await page.getByText('跟隨筆尖', { exact: true }).click();
  await expect(page.locator('#zoom-field')).toBeVisible();
  await page.waitForTimeout(300);
  const d = await debug(page);
  const box = (await page.locator('#view').boundingBox())!;
  expect(Math.abs(d.tipScreen![0] - box.width / 2)).toBeLessThan(1);
  expect(Math.abs(d.tipScreen![1] - box.height / 2)).toBeLessThan(1);
  expect(d.state.view.zoom).toBe(8);
});

test('a file dropped on the page is opened', async ({ page }) => {
  await open(page);
  const svg = await readFile(fixture('four-shapes.svg'), 'utf8');
  await page.evaluate(text => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'dropped.svg', { type: 'image/svg+xml' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, svg);
  await expect(page.locator('#toast')).toContainText('dropped.svg');
  expect((await debug(page)).state.source.type).toBe('svg');
});

test('a project with the SVG embedded opens without asking; without it, the file is asked for', async ({ page }) => {
  await open(page, 'play=0');
  await upload(page, 'four-shapes.svg');
  await page.locator('#m-number').fill('40');
  await page.locator('#m-number').press('Enter');
  const before = await debug(page);

  await page.locator('#embed-source').check();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#project-save').click()]);
  const embedded = await readFile(await download.path(), 'utf8');
  expect(JSON.parse(embedded).source).toMatchObject({ type: 'svg', name: 'four-shapes.svg' });
  expect(JSON.parse(embedded).source.content).toContain('<svg');

  await page.locator('#new-drawing').click();
  let [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#project-open').click()]);
  await chooser.setFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(embedded) });
  await expect.poll(async () => (await debug(page)).state.source.type).toBe('svg');
  let after = await debug(page);
  expect(after.M).toBe(40);
  expect(after.metrics).toEqual(before.metrics);

  // Without the content: the project asks for the file, then keeps its own M.
  const bare = JSON.parse(embedded);
  delete bare.source.content;
  await page.locator('#new-drawing').click();
  [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#project-open').click()]);
  await chooser.setFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bare)) });
  await expect(page.locator('#toast')).toContainText('four-shapes.svg');
  expect((await debug(page)).state.source.type).toBe('random');
  await upload(page, 'four-shapes.svg');
  after = await debug(page);
  expect(after.M).toBe(40);
  expect(after.metrics).toEqual(before.metrics);
});
