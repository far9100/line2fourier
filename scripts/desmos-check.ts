// M1 acceptance (spec §8, §12): paste both kinds of exported Desmos text into the real Desmos
// calculator and keep screenshots next to the page's own drawing of the same M.
// This script visits desmos.com; the app itself never does. Run with the preview server up:
//   npx vite preview --port 4173 &  node scripts/desmos-check.ts
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { coefficients, orderTerms, resampleClosed } from '../src/core/fourier.ts';
import { generate } from '../src/core/generators.ts';
import { toDesmos, toDesmosSlider } from '../src/export/desmos.ts';

const OUT = new URL('../docs/acceptance/', import.meta.url);
const out = (name: string) => fileURLToPath(new URL(name, OUT));
const M = 20, N = 1024, SEED = 42;
const { c0, terms } = orderTerms(coefficients(resampleClosed(generate('creature', SEED).pts, N)));

async function pasteIntoDesmos(page: Page, text: string, file: string) {
  await page.goto('https://www.desmos.com/calculator');
  const input = page.locator('.dcg-expressionlist .dcg-mq-editable-field').first();
  await input.waitFor({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  await input.click();
  await page.evaluate(t => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('Control+V');
  await page.waitForTimeout(4000);
  // Zoom to the drawing (the page shows [-1.35, 1.35] on its short side) when the calculator object is reachable.
  await page.evaluate(() => {
    const calc = (window as unknown as { Calc?: { setMathBounds(b: object): void } }).Calc;
    const graph = document.querySelector('.dcg-graph-outer')?.getBoundingClientRect();
    if (!calc || !graph) return;
    const half = (1.35 * graph.width) / graph.height; // same scale on both axes, 1.35 to the top
    calc.setMathBounds({ left: -half, right: half, bottom: -1.35, top: 1.35 });
  });
  await page.waitForTimeout(1500);
  const rows = await page.locator('.dcg-expressionitem.dcg-mathitem').count();
  const errors = await page.locator('.dcg-expressionitem .dcg-error').count();
  await page.screenshot({ path: out(file) });
  return { rows, errors };
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();

const plain = toDesmos(c0, terms, M);
const slider = toDesmosSlider(c0, terms, M);
const results = {
  plain: await pasteIntoDesmos(page, plain, 'desmos-plain.png'),
  slider: await pasteIntoDesmos(page, slider, 'desmos-slider.png'),
};

// The page's own drawing of the same M (reduced motion shows the whole approximation at once).
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto(`http://127.0.0.1:4173/?gen=creature&seed=${SEED}&N=${N}&M=${M}`);
await page.waitForTimeout(1500);
await page.locator('#view').screenshot({ path: out('app-creature-42-M20.png') });

await writeFile(new URL('desmos-check.json', OUT), `${JSON.stringify({ date: new Date().toISOString().slice(0, 10), M, N, seed: SEED, ...results, plainText: plain, sliderText: slider }, null, 1)}\n`);
console.log(JSON.stringify(results));
await browser.close();
