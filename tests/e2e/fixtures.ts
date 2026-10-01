// Every end-to-end test watches for what spec §6 and §12 forbid: requests to anywhere but the site
// itself, Content-Security-Policy violations, and script errors.
import { test as base, expect, type Page } from '@playwright/test';

export interface Problems {
  external: string[];
  errors: string[];
  csp: () => Promise<string[]>;
}

export const test = base.extend<{ problems: Problems }>({
  problems: async ({ page, baseURL }, use) => {
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
  },
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
  M: number;
  N: number;
  size: number;
  metrics: { energy: number; rmsError: number; meanDeviation: number };
  jumpRatio: number;
  used: number[];
  circles: { k: number; r: number; x: number; y: number }[];
  frame: { tip: [number, number]; penUp: boolean; circlesDrawn: number } | null;
  strokes: number;
  highlight: { x: number; y: number; r: number; j: number } | null;
  tipScreen: [number, number] | null;
  calls: Record<string, number>;
  timings: { recompute: number; render: number };
}

export function debug(page: Page): Promise<Debug> {
  return page.evaluate(() => (window as unknown as { __l2f: { debug(): Debug } }).__l2f.debug());
}

/** Open the page with a fixed drawing and wait until it is on screen. */
export async function open(page: Page, query = 'gen=creature&seed=42'): Promise<void> {
  await page.goto(`./?${query}`);
  await expect(page.locator('html')).not.toHaveClass(/i18n-pending/);
  await page.waitForFunction(() => (window as unknown as { __l2f?: { debug(): { frame: unknown } } }).__l2f?.debug().frame != null);
}
