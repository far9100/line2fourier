// Spec §8 (M1 formats) and §10, from the page: what the buttons copy and download.
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { parseDesmos } from '../helpers/parseDesmos.ts';
import { debug, expect, open, test } from './fixtures.ts';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

/** The formula and the file buttons are folded away until asked for (DECISIONS.md D45). */
const openExports = (page: Page) => page.locator('#export-title').click();

/** The clipboard's text, with Windows' CRLF line ends turned back into LF. */
const clipboard = async (page: Page) => (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');

async function downloadOf(page: Page, button: string): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator(button).click()]);
  return readFile(await download.path(), 'utf8');
}

test('Desmos text draws what the page draws, plain and with a slider', async ({ page }) => {
  await open(page, 'gen=creature&seed=42&play=0&M=20');
  const d = await debug(page);
  await openExports(page);
  await page.locator('#copy-desmos').click();
  await expect(page.locator('#toast')).toHaveText('已複製，可以直接貼上。');
  const plain = await clipboard(page);
  expect(plain.split('\n')).toHaveLength(4);
  await page.locator('#copy-desmos-slider').click();
  const slider = await clipboard(page);
  expect(slider.split('\n')[0]).toBe('M=20');
  // The pen is drawn at t = 0 while paused: both texts put it there too.
  for (const text of [plain, slider]) {
    const p = parseDesmos(text)(d.t);
    expect(Math.hypot(p[0] - d.frame!.tip[0], p[1] - d.frame!.tip[1])).toBeLessThan(1e-3);
  }
});

test('LaTeX lists c_0 and M terms', async ({ page }) => {
  await open(page, 'gen=star&seed=3&play=0&M=12');
  await openExports(page);
  await page.locator('#copy-latex').click();
  const latex = await clipboard(page);
  expect(latex.startsWith('z(t)=(')).toBe(true);
  expect(latex.match(/e\^\{i\(/g)).toHaveLength(12);
  await expect(page.locator('#formula .katex')).toBeVisible();
  await expect(page.locator('#formula-count')).toHaveText('共 12 項');
});

test('coefficients JSON has all N terms and the ones in use', async ({ page }) => {
  await open(page, 'gen=scribble&seed=9&play=0&M=30');
  await openExports(page);
  const file = JSON.parse(await downloadOf(page, '#download-json'));
  const d = await debug(page);
  expect(file.N).toBe(1024);
  expect(file.coefficients).toHaveLength(1024);
  expect(file.used).toEqual(d.used);
  expect(file.source).toEqual({ type: 'random', generator: 'scribble', seed: 9 });
});

test('SVG is one path, sized in millimetres', async ({ page }) => {
  await open(page, 'gen=star&seed=11&play=0');
  await openExports(page);
  await page.locator('#svg-width').fill('80');
  const svg = await downloadOf(page, '#download-svg');
  expect(svg).toMatch(/width="80\.0000mm"/);
  expect(svg.match(/<path /g)).toHaveLength(1);
  const valid = await page.evaluate(text => new DOMParser().parseFromString(text, 'image/svg+xml').querySelector('parsererror') === null, svg);
  expect(valid).toBe(true);
});

test('a saved project opens again exactly as it was', async ({ page }) => {
  await open(page, 'gen=scribble&seed=12345&play=0');
  await page.locator('#m-number').fill('77');
  await page.locator('#m-number').press('Enter');
  await page.locator('#advanced-title').click();
  await page.getByText('依頻率', { exact: true }).click();
  await openExports(page);
  const before = await debug(page);
  const text = await downloadOf(page, '#project-save');
  const project = JSON.parse(text);
  expect(project).toMatchObject({ format: 'line2fourier.project', version: 1, M: 77, order: 'frequency' });

  await page.locator('#new-drawing').click();
  expect((await debug(page)).state.source.seed).not.toBe(12345);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#project-open').click()]);
  await chooser.setFiles({ name: 'line2fourier-project.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.locator('#toast')).toContainText('已開啟專案');
  const after = await debug(page);
  expect(after.state.source).toEqual(before.state.source);
  expect(after.metrics).toEqual(before.metrics);
  expect(after.used).toEqual(before.used);
});

test('files that cannot be used are refused with a reason', async ({ page }) => {
  await open(page);
  await openExports(page);
  const offer = async (name: string, text: string) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#project-open').click()]);
    await chooser.setFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
  };
  await offer('x.json', '{"format":"something-else","version":1}');
  await expect(page.locator('#toast')).toHaveText('不支援這種檔案。請開啟 SVG、line2func 的 curves.json 或 line2fourier 專案檔。');
  await offer('p.json', '{"format":"line2fourier.project","version":2,"source":{}}');
  await expect(page.locator('#toast')).toHaveText('不支援這個版本的專案檔。');
  await offer('c.json', '{"format":"line2func.curves","version":1}');
  await expect(page.locator('#toast')).toHaveText('curves.json 的曲線資料不完整。');
  expect((await debug(page)).state.source.type).toBe('random');
});
