// DECISIONS.md D25: SVG geometry is flattened in TypeScript instead of with getPointAtLength (spec
// §5.3). Here the browser's own path measuring is the referee: the lengths must agree.
import { IDENTITY } from '../../src/core/affine.ts';
import { flattenSubpath, parsePathData } from '../../src/core/svgPathData.ts';
import { expect, open, test } from './fixtures.ts';

const PATHS = [
  'M10 80 C 40 10, 65 10, 95 80 S 150 150, 180 80',
  'M10 315 L 110 215 A 30 50 0 0 1 162.55 162.45 L 172.55 152.45 A 30 50 -45 0 1 215.1 109.9 L 315 10',
  'M 100 100 a 50 25 30 1 0 80 40 q 20 -60 60 0 t 60 0 z',
  'M0 0 h 50 v 50 h -50 z m 70 0 c 10 -20 30 -20 40 0 s 30 20 40 0',
  'M 50 50 A 40 40 0 1 1 49.99 50.01',
];

test('flattened SVG paths have the length the browser measures', async ({ page }) => {
  await open(page, 'play=0');
  const browserLengths = await page.evaluate(paths => paths.map(d => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
    document.body.append(svg);
    const length = path.getTotalLength();
    svg.remove();
    return length;
  }), PATHS);
  PATHS.forEach((d, i) => {
    const { subpaths } = parsePathData(d);
    let ours = 0;
    for (const sp of subpaths) {
      const s = flattenSubpath(sp, IDENTITY, 0.01)!;
      const pts = s.closed ? [...s.pts, s.pts[0]] : s.pts;
      for (let k = 1; k < pts.length; k++) ours += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    }
    expect(Math.abs(ours - browserLengths[i]) / browserLengths[i], d).toBeLessThan(1e-3);
  });
});
