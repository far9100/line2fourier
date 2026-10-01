// Spec §12 M3: a video exactly one cycle long that plays; oscilloscope audio with nothing at or
// above fs/2 and a peak of at most 0.9, played with an XY preview; a flipbook PDF; an image opened.
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { debug, expect, open, test } from './fixtures.ts';

async function download(page: Page, button: string, timeout = 60_000): Promise<{ name: string; bytes: Buffer }> {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout }), page.locator(button).click()]);
  return { name: d.suggestedFilename(), bytes: await readFile(await d.path()) };
}

test('the video is one cycle long and plays', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page, 'gen=star&seed=3&play=0&M=30');
  await page.locator('#outputs-title').click(); // folded away until asked for
  const { name, bytes } = await download(page, '#video-export', 110_000);
  expect(name).toMatch(/^line2fourier\.(mp4|webm)$/);
  await expect(page.locator('#toast')).toContainText('長度剛好一輪');

  // Read back without a browser: 8 s at 1×, give or take a frame.
  const input = new Input({ source: new BufferSource(new Uint8Array(bytes)), formats: ALL_FORMATS });
  const seconds = await input.computeDuration();
  expect(Math.abs(seconds - 8)).toBeLessThanOrEqual(1 / 30 + 1e-6);
  const track = await input.getPrimaryVideoTrack();
  expect(track!.displayWidth).toBe(1080);

  // And in the browser: it loads with that duration and plays.
  const played = await page.evaluate(async ({ b64, type }) => {
    const bin = atob(b64);
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    const video = document.createElement('video');
    video.muted = true;
    video.src = URL.createObjectURL(new Blob([data], { type }));
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('cannot load')); });
    const duration = video.duration;
    await video.play();
    await new Promise(r => setTimeout(r, 300));
    const time = video.currentTime;
    video.pause();
    return { duration, time };
  }, { b64: bytes.toString('base64'), type: name.endsWith('.mp4') ? 'video/mp4' : 'video/webm' });
  expect(Math.abs(played.duration - 8)).toBeLessThanOrEqual(1 / 30 + 1e-3);
  expect(played.time).toBeGreaterThan(0);
});

test('the WAV leaves out what cannot be played and peaks at 0.9; playing draws the XY figure', async ({ page }) => {
  await open(page, 'gen=creature&seed=8&play=0&M=1000');
  await page.locator('#outputs-title').click(); // folded away until asked for
  await expect(page.locator('#scope-note')).toContainText('已捨棄');
  const { name, bytes } = await download(page, '#wav-export');
  expect(name).toBe('line2fourier-100Hz.wav');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(bytes.toString('latin1', 0, 4)).toBe('RIFF');
  expect(v.getUint16(22, true)).toBe(2);
  expect(v.getUint32(24, true)).toBe(48000);
  expect(v.getUint32(40, true)).toBe(10 * 48000 * 4); // 10 seconds
  let peak = 0;
  for (let i = 44; i < bytes.length; i += 2) peak = Math.max(peak, Math.abs(v.getInt16(i, true)));
  expect(peak).toBeLessThanOrEqual(Math.round(0.9 * 32767));
  expect(peak).toBeGreaterThan(0.85 * 32767);

  await page.locator('#audio-toggle').click();
  await expect(page.locator('#audio-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(400);
  const traced = await page.evaluate(() => {
    const c = document.querySelector('#xy') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) < 110) n++; // the black trace
    return n;
  });
  expect(traced).toBeGreaterThan(100);
  await page.locator('#audio-toggle').click();
  await expect(page.locator('#audio-toggle')).toHaveAttribute('aria-pressed', 'false');
});

test('the flipbook is a 4-page A4 PDF', async ({ page }) => {
  await open(page, 'gen=scribble&seed=5&play=0&M=40');
  await page.locator('#outputs-title').click(); // folded away until asked for
  const { name, bytes } = await download(page, '#flipbook-export');
  expect(name).toBe('line2fourier-flipbook.pdf');
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(4);
  expect(doc.getPage(0).getWidth()).toBeCloseTo((210 * 72) / 25.4, 3);
  await expect(page.locator('#toast')).toContainText('32 格');
});

test('a line-art image is traced into strokes', async ({ page }) => {
  await open(page);
  // Draw the test image with the page's own canvas: a ring and a cross, black on white.
  const png = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 300);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(120, 150, 80, 0, 2 * Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(250, 150); ctx.lineTo(370, 150); ctx.moveTo(310, 90); ctx.lineTo(310, 210); ctx.stroke();
    const blob = await new Promise<Blob>(r => c.toBlob(b => r(b!), 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#upload').click()]);
  await chooser.setFiles({ name: 'ring-and-cross.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await expect(page.locator('#toast')).toContainText('已匯入 ring-and-cross.png', { timeout: 20_000 });
  const d = await debug(page);
  expect(d.state.source).toMatchObject({ type: 'image', name: 'ring-and-cross.png' });
  expect(d.strokes).toBe(3); // the ring, and the cross as two lines through its middle (D39)
  expect(d.jumpRatio).toBeGreaterThan(0);
  await expect(page.locator('#metric-jumps')).toContainText('原始順序');
});
