// Spec §6: recomputing at N = 1024 under 10 ms; with up to 300 circles, 60 fps on a mid-range laptop
// and 30 fps on a phone. What the page itself spends per frame is measured; the phone is
// approximated by slowing the CPU down 4×.
import { debug, expect, open, test } from './fixtures.ts';

test('recomputing at N = 1024 takes under 10 ms', async ({ page }) => {
  await open(page, 'gen=creature&seed=1&play=0');
  const times: number[] = [];
  for (const gen of ['star', 'scribble', 'creature', 'star', 'scribble']) {
    await page.locator('#generator').selectOption(gen);
    times.push((await debug(page)).timings.recompute);
  }
  times.sort((a, b) => a - b);
  expect(times[Math.floor(times.length / 2)]).toBeLessThan(10);
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
