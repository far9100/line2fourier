// Spec §6: recomputing at N = 1024 under 10 ms; with up to 300 circles, 60 fps on a mid-range laptop
// and 30 fps on a phone. What the page itself spends per frame is measured; the phone is
// approximated by slowing the CPU down 4×.
import { debug, expect, open, test } from './fixtures.ts';

test('recomputing at N = 1024 takes under 10 ms', async ({ page }) => {
  await open(page, 'gen=creature&seed=1&play=0');
  const times: number[] = [];
  await page.locator('#advanced-title').click();
  for (const seed of [2, 3, 4, 5, 6]) {
    await page.locator('#seed').fill(String(seed));
    await page.locator('#seed-apply').click();
    const d = await debug(page);
    expect(d.state.source.seed).toBe(seed);
    times.push(d.timings.recompute);
  }
  times.sort((a, b) => a - b);
  expect(times[Math.floor(times.length / 2)]).toBeLessThan(10);
});

test('a drawing of 400 strokes opens in a few seconds, and changing the circles stays quick with thousands of them', async ({ page }) => {
  await open(page, 'gen=creature&seed=1&play=0');
  // 400 short strokes on a grid: neighbours come within a hair of each other, rows are a little apart.
  const paths: string[] = [];
  for (let row = 0; row < 20; row++) {
    for (let col = 0; col < 20; col++) {
      const x = 10 + 20 * col, y = 10 + 20 * row, lean = ((row * 7 + col * 3) % 5) - 2;
      paths.push(`M${x} ${y} q8 ${lean} 16 0 t${lean} 14`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 420"><path d="${paths.join(' ')}" fill="none" stroke="#000"/></svg>`;
  const started = Date.now();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#upload').click()]);
  await chooser.setFiles({ name: 'grid.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(svg) });
  await expect(page.locator('#toast')).toContainText('grid.svg', { timeout: 15_000 });
  expect(Date.now() - started).toBeLessThan(5_000);
  const opened = await debug(page);
  expect(opened.state.source.strokes).toBe(400);
  expect(opened.pieces).toBeGreaterThan(400); // joined into a walk, with stretches walked again
  expect(opened.lengths[4]).toBeGreaterThan(0);

  // The slider at 3000 circles: summing the series at every span edge would take a good part of a second here.
  const times: number[] = [];
  for (const M of [2999, 3000, 2998, 3000, 2997]) {
    await page.locator('#m-number').fill(String(M));
    await page.locator('#m-number').press('Enter');
    const d = await debug(page);
    expect(d.M).toBe(M);
    times.push(d.timings.recompute + d.timings.scene);
  }
  times.sort((a, b) => a - b);
  expect(times[Math.floor(times.length / 2)]).toBeLessThan(50);
});

for (const [label, slowdown, budget] of [['a laptop', 1, 1000 / 60], ['a phone (CPU 4× slower)', 4, 1000 / 30]] as const) {
  test(`300 circles: a frame costs less than ${budget.toFixed(1)} ms on ${label}`, async ({ page }) => {
    await open(page, 'gen=creature&seed=5&M=300');
    if (slowdown > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: slowdown });
    }
    await page.waitForTimeout(2500); // let the running average settle
    const d = await debug(page);
    expect(d.M).toBe(300);
    expect(d.timings.render).toBeLessThan(budget);
  });
}
