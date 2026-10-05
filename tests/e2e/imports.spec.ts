// Spec §12 M2: SVG and curves.json import, the strokes joined into one walk whose pen-up moves are
// drawn apart from the lines, the spectrum panel in step with the circles, and following the pen.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { colourNear, debug, evalDebug, expect, inkNear, open, test, type Point } from './fixtures.ts';

const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url);

async function upload(page: Page, name: string) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#upload').click()]);
  await chooser.setFiles(fileURLToPath(fixture(name)));
  await expect(page.locator('#toast')).toContainText(/已匯入|Imported/, { timeout: 15_000 });
}

test('an SVG with four shapes far apart: walked with jumps, drawn black with grey jumps that can be hidden, the share shown', async ({ page }) => {
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

  // The circles out of the way (the original is hidden already): black along the drawing, never
  // along the jumps, which are grey (D44, D45) until they are hidden.
  await page.getByText('顯示圓', { exact: true }).click();
  await page.waitForTimeout(200);
  const jumps = await evalDebug<Point[]>(page, 'mids', 2);
  const inks = await evalDebug<Point[]>(page, 'mids', 0);
  expect(jumps.length).toBe(4); // four shapes, each too far from the others to walk to: four pen lifts
  for (const p of jumps) expect(await inkNear(page, p), `jump at ${p}`).toBe(false);
  let grey = 0;
  for (const p of jumps) if (await colourNear(page, 'grey', p, 4)) grey++;
  expect(grey).toBeGreaterThanOrEqual(3);
  let drawn = 0;
  for (const p of inks) if (await inkNear(page, p, 3)) drawn++;
  expect(drawn / inks.length).toBeGreaterThan(0.9);

  await page.getByText('顯示跳線', { exact: true }).click();
  await expect.poll(async () => (await debug(page)).state.view.showJumps).toBe(false);
  await page.waitForTimeout(200);
  for (const p of jumps) expect(await colourNear(page, 'grey', p, 4), `jump at ${p}`).toBe(false);
});

test('strokes that nearly touch are joined there, pen down, and the pen walks back instead of jumping (D46)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); // paused, with the whole approximation drawn
  await open(page);
  await upload(page, 'tee.svg');
  await expect(page.locator('#toast')).toContainText('1 處把靠得很近的筆畫接起來');
  const d = await debug(page);
  expect(d.state.source).toMatchObject({ type: 'svg', name: 'tee.svg', strokes: 2 });
  await expect(page.locator('#status')).toContainText('2 筆畫');
  expect(d.pieces).toBeGreaterThan(2); // the bar in two halves, the link, the stem, and the ways back
  // No pen-up move at all: the share is not even shown.
  expect(d.jumpRatio).toBe(0);
  expect(d.lengths[2]).toBe(0);
  await expect(page.locator('#metric-jumps-row')).toBeHidden();
  expect(await evalDebug<Point[]>(page, 'mids', 2)).toEqual([]);
  // A closed walk over a T goes along everything twice: as much walked again as drawn.
  expect(d.lengths[4]).toBeCloseTo(d.lengths[0], 9);
  expect(d.frame!.penUp).toBe(false); // back at the start, on a line it drew: the pen is down

  // The link is a line like the others: a piece of ink across the gap, 0.6 long of the drawing's 160.
  const toScreen = ([x, y]: Point): Point => [d.camera.ox + d.camera.s * (x - d.camera.cx), d.camera.oy - d.camera.s * (y - d.camera.cy)];
  const link = toScreen([0, (110 - 40.3) / 80]); // the middle of the gap, in the drawing's own units (long side 2, y up)
  const inks = await evalDebug<Point[]>(page, 'mids', 0);
  expect(inks.some(p => Math.hypot(p[0] - link[0], p[1] - link[1]) < 0.5)).toBe(true);
  const again = await evalDebug<Point[]>(page, 'mids', 4);
  expect(again.length).toBeGreaterThan(0);

  // Black along every line, whether the pen passes once or twice.
  await page.getByText('顯示圓', { exact: true }).click();
  await page.waitForTimeout(200);
  let drawn = 0;
  for (const p of [...inks, ...again]) if (await inkNear(page, p, 3)) drawn++;
  expect(drawn / (inks.length + again.length)).toBeGreaterThan(0.9);
});

test('line2func curves.json: strokes joined, fill hatching left out and said so', async ({ page }) => {
  await open(page);
  await upload(page, 'curves-small.json');
  await expect(page.locator('#toast')).toContainText('略過 1 條填色斜線');
  const d = await debug(page);
  expect(d.state.source).toMatchObject({ type: 'line2func', strokes: 3 });
  expect(d.N).toBeGreaterThanOrEqual(1024);
});

test('the spectrum shows exactly the circles in use, and picking one marks it', async ({ page }) => {
  await open(page, 'gen=star&seed=42&play=0&M=50');
  await page.locator('#spectrum-title').click();
  await page.locator('#advanced-title').click();
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
  // Pick the k of the fifth circle in use by clicking its stem (at 50 circles, a stem is a few
  // pixels apart in the narrow panel; at 300 the arrow keys pick one).
  await page.getByText('依大小', { exact: true }).click();
  await page.locator('#m-number').fill('50');
  await page.locator('#m-number').press('Enter');
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
  await page.locator('#spectrum-title').click();
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
  await expect(page.locator('#view-zoom')).toHaveText('8×');
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
  await page.locator('#export-title').click();
  await upload(page, 'four-shapes.svg');
  await page.locator('#m-number').fill('40');
  await page.locator('#m-number').press('Enter');
  const before = await debug(page);

  await page.locator('#embed-source').check();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#project-save').click()]);
  const embedded = await readFile(await download.path(), 'utf8');
  expect(JSON.parse(embedded).source).toMatchObject({ type: 'svg', name: 'four-shapes.svg' });
  expect(JSON.parse(embedded).source.content).toContain('<svg');

  await page.locator('#clear').click();
  let [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#project-open').click()]);
  await chooser.setFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(embedded) });
  await expect.poll(async () => (await debug(page)).state.source?.type).toBe('svg'); // null while it is cleared
  let after = await debug(page);
  expect(after.M).toBe(40);
  expect(after.metrics).toEqual(before.metrics);

  // Without the content: the project asks for the file, then keeps its own M.
  const bare = JSON.parse(embedded);
  delete bare.source.content;
  await page.locator('#clear').click();
  [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#project-open').click()]);
  await chooser.setFiles({ name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bare)) });
  await expect(page.locator('#toast')).toContainText('four-shapes.svg');
  expect((await debug(page)).empty).toBe(true); // still cleared: the project waits for its file
  await upload(page, 'four-shapes.svg');
  after = await debug(page);
  expect(after.M).toBe(40);
  expect(after.metrics).toEqual(before.metrics);
});

test('Clear while a picture is still being read: it is not shown when it is ready (D51)', async ({ page }) => {
  await open(page, 'play=0');
  // A picture that takes a moment: 144 rings, 1000 px across, made by the page's own canvas.
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 1000; c.height = 1000;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1000, 1000);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) { ctx.beginPath(); ctx.arc(60 + 80 * i, 60 + 80 * j, 30, 0, 2 * Math.PI); ctx.stroke(); }
    const blob = await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const before = (await debug(page)).calls;
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#upload').click()]);
  await chooser.setFiles({ name: 'rings.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await expect(page.locator('#toast')).toContainText('正在讀取線稿');
  await page.locator('#clear').click();
  await expect(page.locator('#toast')).toBeHidden(); // nothing more is said about it
  // Given all the time it needs, the picture stays away: nothing was ever worked out for it.
  await page.waitForTimeout(3000);
  const d = await debug(page);
  expect(d.empty).toBe(true);
  expect(d.calls).toEqual(before);
  await expect(page.locator('#toast')).toBeHidden();
  await expect(page.locator('#empty-hint')).toBeVisible();
});

test('a picture with a solid area: outlined, painted in with the wide pen, and said so (D42)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); // paused, with the whole approximation drawn
  await open(page);
  // A solid disk and a ring drawn as a line, black on white, made by the page's own canvas.
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(120, 150, 50, 0, 2 * Math.PI); ctx.fill();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(300, 150, 60, 0, 2 * Math.PI); ctx.stroke();
    const blob = await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#upload').click()]);
  await chooser.setFiles({ name: 'disk-and-ring.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await expect(page.locator('#toast')).toContainText('1 塊塗黑的區域照原畫塗滿', { timeout: 20_000 });
  const d = await debug(page);
  expect((d as unknown as { fillWidth: number }).fillWidth).toBeGreaterThan(0);

  await page.getByText('顯示圓', { exact: true }).click();
  await page.waitForTimeout(200);
  const paint = await evalDebug<Point[]>(page, 'mids', 3);
  expect(paint.length).toBeGreaterThan(10);
  let drawn = 0;
  for (const p of paint) if (await inkNear(page, p, 2)) drawn++;
  expect(drawn / paint.length).toBeGreaterThan(0.9);
  // Solid, not hatched: black in the middle of the disk too, between the rings.
  const mid: Point = [paint.reduce((a, p) => a + p[0], 0) / paint.length, paint.reduce((a, p) => a + p[1], 0) / paint.length];
  expect(await inkNear(page, mid, 1)).toBe(true);
});
