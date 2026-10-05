// Every end-to-end test watches for what spec §6 and §12 forbid: requests to anywhere but the site
// itself, Content-Security-Policy violations, and script errors.
import { test as base, expect, type Page } from '@playwright/test';

export interface Problems {
  external: string[];
  errors: string[];
  csp: () => Promise<string[]>;
}

export const test = base.extend<{ problems: Problems }>({
  // Every test is watched, whether or not it asks for `problems` (to read the CSP violations).
  problems: [async ({ page, baseURL }, use) => {
    const external: string[] = [];
    const errors: string[] = [];
    page.on('request', r => {
      const url = r.url();
      if (!url.startsWith(baseURL!) && !url.startsWith('data:') && !url.startsWith('blob:')) external.push(url);
    });
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = seen;
      document.addEventListener('securitypolicyviolation', e => seen.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    await use({
      external,
      errors,
      csp: () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp ?? []),
    });
    expect(external, 'requests outside the site').toEqual([]);
    expect(errors, 'script errors').toEqual([]);
  }, { auto: true }],
});

export { expect };

export interface Debug {
  state: {
    M: number; N: number; playing: boolean; mode: 'play' | 'draw'; lang: string; speed: number; order: string;
    demo: { step: number; returnM: number } | null; selectedK: number | null;
    view: { showCircles: boolean; showOriginal: boolean; showJumps: boolean; follow: boolean; zoom: number };
    source: { type: string; generator?: string; seed?: number; points?: number; name?: string; strokes?: number };
  };
  t: number;
  firstCycleDone: boolean;
  /** The pen has been round once and stopped where it started (DECISIONS.md D50). */
  finished: boolean;
  M: number;
  N: number;
  size: number;
  metrics: { energy: number; rmsError: number; meanDeviation: number };
  jumpRatio: number;
  used: number[];
  circles: { k: number; r: number; x: number; y: number }[];
  frame: { tip: [number, number]; penUp: boolean; circlesDrawn: number } | null;
  strokes: number;
  /** The pieces the drawing is walked in, and the path's length by kind (0 ink, 1 closure, 2 jump, 3 fill, 4 walked again). */
  pieces: number;
  lengths: number[];
  camera: { s: number; cx: number; cy: number; ox: number; oy: number };
  highlight: { x: number; y: number; r: number; j: number } | null;
  tipScreen: [number, number] | null;
  calls: Record<string, number>;
  timings: { recompute: number; scene: number; render: number };
}

export function debug(page: Page): Promise<Debug> {
  return page.evaluate(() => (window as unknown as { __l2f: { debug(): Debug } }).__l2f.debug());
}

/**
 * Open the page with its time standing still: it moves only when the test says page.clock.runFor(ms),
 * with animation frames exactly 16 ms apart. Clicks and keys work as usual.
 */
export async function openStill(page: Page, query?: string): Promise<void> {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await open(page, query);
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
  await page.clock.runFor(32); // so the last frame before the test does anything is one of those
}

export type Point = [number, number];

/** One field of debug(), or what one of its functions returns for `arg` (they do not survive the trip out of the page). */
export const evalDebug = <T,>(page: Page, fn: string, arg?: unknown) =>
  page.evaluate(([f, a]) => {
    const d = (window as unknown as { __l2f: { debug(): Record<string, unknown> } }).__l2f.debug();
    const v = d[f as string];
    return typeof v === 'function' ? (v as (x: unknown) => unknown)(a) : v;
  }, [fn, arg] as const) as Promise<T>;

/** Is there a pixel of the given colour within r pixels of the point (on the light theme's white)? */
export async function colourNear(page: Page, colour: 'ink' | 'grey', p: Point, r = 2): Promise<boolean> {
  return page.evaluate(([x, y, rad, which]) => {
    const c = document.querySelector('#view') as HTMLCanvasElement;
    const ratio = c.width / c.getBoundingClientRect().width;
    const size = 2 * rad + 1;
    const data = c.getContext('2d')!.getImageData(Math.round((x - rad) * ratio), Math.round((y - rad) * ratio), Math.round(size * ratio), Math.round(size * ratio)).data;
    for (let i = 0; i < data.length; i += 4) {
      const [red, green, blue] = [data[i], data[i + 1], data[i + 2]];
      // ink (the drawing, black): dark; grey (the pen-up moves): neutral and between the drawing's
      // black and the faint full curve's light grey
      const hi = Math.max(red, green, blue), lo = Math.min(red, green, blue);
      if (which === 'ink' ? hi < 110 : hi - lo < 30 && green >= 120 && green <= 215) return true;
    }
    return false;
  }, [p[0], p[1], r, colour] as const);
}
export const inkNear = (page: Page, p: Point, r = 2) => colourNear(page, 'ink', p, r);

/** Open the page with a fixed drawing and wait until it is on screen. */
export async function open(page: Page, query = 'gen=creature&seed=42'): Promise<void> {
  await page.goto(`./?${query}`);
  await expect(page.locator('html')).not.toHaveClass(/i18n-pending/);
  await page.waitForFunction(() => (window as unknown as { __l2f?: { debug(): { frame: unknown } } }).__l2f?.debug().frame != null);
}
