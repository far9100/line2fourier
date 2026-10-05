// The page as GitHub Pages serves it: plain files in a folder of the site (/line2fourier/), not at
// its root. The build's URLs are relative (vite.config.ts), so the same dist/ has to work from
// there: the script and its chunks, the styles, the worker and KaTeX's fonts. A request that left
// the folder would be answered with 404 here and counted as a request outside the site.
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debug, expect, open, test } from './fixtures.ts';

const PORT = 4174;
const FOLDER = '/line2fourier/';
const BASE = `http://127.0.0.1:${PORT}${FOLDER}`;
const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

test.use({ baseURL: BASE });

let server: Server;

test.beforeAll(async () => {
  // dist/ is there already: the web server of playwright.config.ts builds it before any test runs.
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', BASE).pathname);
    if (!path.startsWith(FOLDER) || path.includes('..')) {
      res.writeHead(404).end();
      return;
    }
    const file = path.slice(FOLDER.length) || 'index.html';
    readFile(join(DIST, file)).then(
      body => res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body),
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>(resolve => server.listen(PORT, '127.0.0.1', resolve));
});

test.afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('the built page works from a folder of the site, as GitHub Pages serves it', async ({ page, problems }) => {
  const failed: string[] = [];
  const fetched: string[] = [];
  page.on('response', r => {
    fetched.push(r.url());
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  await open(page, 'gen=star&seed=42');
  expect(new URL(page.url()).pathname).toBe(FOLDER);

  // Opening a file starts the worker, which is a file of its own next to the scripts.
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#upload').click()]);
  await chooser.setFiles(fileURLToPath(new URL('../fixtures/four-shapes.svg', import.meta.url)));
  await expect(page.locator('#toast')).toContainText('four-shapes.svg', { timeout: 15_000 });
  expect((await debug(page)).state.source.type).toBe('svg');
  expect(page.workers().map(w => w.url()).filter(url => url.startsWith(BASE))).toHaveLength(1);

  // KaTeX is a chunk loaded after the first frame; its fonts are files beside the styles.
  await page.locator('#export-title').click();
  await expect(page.locator('#formula .katex').first()).toBeVisible();
  await expect.poll(() => fetched.some(url => /\.woff2?$/.test(url))).toBe(true);

  expect(failed).toEqual([]);
  expect(fetched.every(url => url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:'))).toBe(true);
  expect(await problems.csp()).toEqual([]);
});
