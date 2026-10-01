// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { IDENTITY, applyPt, mul, parseTransform } from '../../src/core/affine.ts';
import type { Pt } from '../../src/core/fourier.ts';
import { readSvg, svgItemsToStrokes } from '../../src/core/svgImport.ts';
import { arcToCubics, flattenSubpath, parsePathData, shapeToSubpaths, subpathCubics } from '../../src/core/svgPathData.ts';

const close = (a: Pt, b: Pt, eps = 1e-9) => Math.hypot(a[0] - b[0], a[1] - b[1]) < eps;

describe('transforms', () => {
  it('reads every transform function and composes them right to left', () => {
    expect(parseTransform('translate(10 20)')).toEqual([1, 0, 0, 1, 10, 20]);
    expect(parseTransform('scale(2)')).toEqual([2, 0, 0, 2, 0, 0]);
    expect(parseTransform('matrix(1,2,3,4,5,6)')).toEqual([1, 2, 3, 4, 5, 6]);
    const m = parseTransform('translate(10,0) scale(2)')!;
    expect(applyPt(m, 1, 1)).toEqual([12, 2]); // scaled first, then moved
    const r = parseTransform('rotate(90 1 1)')!;
    expect(close(applyPt(r, 2, 1), [1, 2])).toBe(true);
    expect(close(applyPt(parseTransform('skewX(45)')!, 0, 1), [1, 1])).toBe(true);
    expect(parseTransform('')).toBe(IDENTITY);
  });

  it('refuses what it cannot read', () => {
    expect(parseTransform('rotate(1,2)')).toBeNull();
    expect(parseTransform('perspective(3)')).toBeNull();
    expect(parseTransform('translate(1) garbage')).toBeNull();
  });

  it('mul applies the right-hand transform first', () => {
    const t = mul([1, 0, 0, 1, 5, 0], [2, 0, 0, 2, 0, 0]);
    expect(applyPt(t, 1, 0)).toEqual([7, 0]);
  });
});

describe('path data', () => {
  it('makes every command absolute and splits subpaths', () => {
    const { subpaths, errorAt } = parsePathData('M10 10 h 5 v5 H 10 z m 20 0 l 5 5 L 40 40');
    expect(errorAt).toBeNull();
    expect(subpaths).toHaveLength(2);
    expect(subpaths[0]).toMatchObject({ x0: 10, y0: 10, closed: true });
    expect(subpaths[0].segs).toEqual([{ c: 'L', x: 15, y: 10 }, { c: 'L', x: 15, y: 15 }, { c: 'L', x: 10, y: 15 }]);
    // After z the current point is the subpath's start, so the relative m is from (10, 10).
    expect(subpaths[1]).toMatchObject({ x0: 30, y0: 10, closed: false });
    expect(subpaths[1].segs).toEqual([{ c: 'L', x: 35, y: 15 }, { c: 'L', x: 40, y: 40 }]);
  });

  it('pairs after a moveto are linetos; numbers can run together', () => {
    const { subpaths } = parsePathData('m1.5.5 2-1e1 .5.5');
    expect(subpaths[0].x0).toBe(1.5);
    expect(subpaths[0].y0).toBe(0.5);
    expect(subpaths[0].segs).toEqual([{ c: 'L', x: 3.5, y: -9.5 }, { c: 'L', x: 4, y: -9 }]);
  });

  it('reflects control points for S and T', () => {
    const { subpaths } = parsePathData('M0 0 C 0 10 10 10 10 0 S 20 -10 20 0 Q 25 5 30 0 T 40 0');
    const [c, s, q, t] = subpaths[0].segs;
    expect(c).toMatchObject({ c: 'C', x2: 10, y2: 10 });
    expect(s).toMatchObject({ c: 'C', x1: 10, y1: -10, x2: 20, y2: -10, x: 20, y: 0 });
    expect(q).toMatchObject({ c: 'Q', x1: 25, y1: 5 });
    expect(t).toMatchObject({ c: 'Q', x1: 35, y1: -5, x: 40, y: 0 });
  });

  it('reads arc flags written without separators', () => {
    const { subpaths, errorAt } = parsePathData('M0 0a1 1 0 00.5.5');
    expect(errorAt).toBeNull();
    expect(subpaths[0].segs[0]).toEqual({ c: 'A', rx: 1, ry: 1, phi: 0, large: false, sweep: false, x: 0.5, y: 0.5 });
  });

  it('keeps everything before an error, like a browser', () => {
    const { subpaths, errorAt } = parsePathData('M0 0 L 10 0 L 10 x 20 20');
    expect(errorAt).not.toBeNull();
    expect(subpaths[0].segs).toEqual([{ c: 'L', x: 10, y: 0 }]);
    expect(parsePathData('L 1 1').subpaths).toHaveLength(0);
  });
});

describe('arcs and shapes', () => {
  it('a half circle as cubics stays on the circle', () => {
    const cubics = arcToCubics(1, 0, { c: 'A', rx: 1, ry: 1, phi: 0, large: false, sweep: true, x: -1, y: 0 });
    expect(cubics).toHaveLength(2);
    for (const c of cubics) {
      for (let t = 0; t <= 1; t += 0.125) {
        const u = 1 - t;
        const x = u ** 3 * c[0] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t ** 3 * c[6];
        const y = u ** 3 * c[1] + 3 * u * u * t * c[3] + 3 * u * t * t * c[5] + t ** 3 * c[7];
        expect(Math.abs(Math.hypot(x, y) - 1)).toBeLessThan(3e-4);
        expect(y).toBeGreaterThanOrEqual(-1e-12); // sweep: through positive y
      }
    }
  });

  it('radii too small for the end point are scaled up (SVG 2 B.2.5)', () => {
    const cubics = arcToCubics(0, 0, { c: 'A', rx: 1, ry: 1, phi: 0, large: false, sweep: true, x: 10, y: 0 });
    const last = cubics[cubics.length - 1];
    expect([last[6], last[7]]).toEqual([10, 0]);
  });

  it('turns rect, circle, ellipse, line, polyline and polygon into subpaths', () => {
    const attrs = (o: Record<string, string>) => (name: string) => o[name] ?? null;
    expect(shapeToSubpaths('rect', attrs({ x: '1', y: '2', width: '3', height: '4' }))[0]).toMatchObject({ x0: 1, y0: 2, closed: true });
    expect(shapeToSubpaths('rect', attrs({ width: '10', height: '4', rx: '1' }))[0].segs.filter(s => s.c === 'A')).toHaveLength(4);
    expect(shapeToSubpaths('circle', attrs({ cx: '0', cy: '0', r: '2' }))[0].segs).toHaveLength(4);
    expect(shapeToSubpaths('ellipse', attrs({ rx: '2', ry: '1' }))[0]).toMatchObject({ x0: 2, y0: 0 });
    expect(shapeToSubpaths('line', attrs({ x1: '0', y1: '0', x2: '1', y2: '1' }))[0].closed).toBe(false);
    expect(shapeToSubpaths('polygon', attrs({ points: '0,0 1,0 1,1' }))[0].closed).toBe(true);
    expect(shapeToSubpaths('polyline', attrs({ points: '0 0 1 0 1 1' }))[0].closed).toBe(false);
    expect(shapeToSubpaths('circle', attrs({ r: '0' }))).toEqual([]);
    expect(shapeToSubpaths('rect', attrs({ width: '-1', height: '2' }))).toEqual([]);
  });

  it('flattening follows the curve to the tolerance, after the transform', () => {
    const [circle] = shapeToSubpaths('circle', name => ({ cx: '0', cy: '0', r: '10' })[name] ?? null);
    const stroke = flattenSubpath(circle, [2, 0, 0, 2, 100, 0], 0.01)!;
    expect(stroke.closed).toBe(true);
    for (const [x, y] of stroke.pts) expect(Math.abs(Math.hypot(x - 100, y) - 20)).toBeLessThan(0.02);
    expect(stroke.pts.length).toBeGreaterThan(40);
    expect(subpathCubics(circle)).toHaveLength(4);
  });
});

describe('reading an SVG file (spec §5.3)', () => {
  const file = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs><circle id="c" r="5"/></defs>
  <g transform="translate(10 0)">
    <path d="M0 0 L10 0 L10 10 Z M20 0 L30 0 M40 0 L50 10" />
    <rect x="0" y="50" width="10" height="10" transform="scale(2)" />
  </g>
  <use href="#c" x="5" y="5"/>
  <text x="0" y="90">hi</text>
  <circle cx="80" cy="80" r="5" style="display:none"/>
  <script>alert(1)</script>
</svg>`;

  it('takes the geometry with its transforms and skips what is not drawn', () => {
    const read = readSvg(file);
    if ('error' in read) throw new Error(read.error);
    expect(read.items).toHaveLength(2);
    expect(read.items[0].subpaths).toHaveLength(3);
    expect(applyPt(read.items[0].m, 0, 0)).toEqual([10, 0]);
    expect(applyPt(read.items[1].m, 0, 50)).toEqual([10, 100]);
    expect(read.warnings).toEqual({ 'svg.skippedUse': 1, 'svg.skippedText': 1 });
  });

  it('every subpath becomes a stroke, with y turned up', () => {
    const read = readSvg(file);
    if ('error' in read) throw new Error(read.error);
    const strokes = svgItemsToStrokes(read.items);
    expect(strokes).toHaveLength(4);
    expect(strokes.map(s => s.closed)).toEqual([true, false, false, true]);
    expect(strokes[0].pts[1]).toEqual([20, -0]);
    expect(strokes[0].pts[2]).toEqual([20, -10]);
  });

  it('refuses a file that is not SVG', () => {
    expect(readSvg('<html><body/></html>')).toEqual({ error: 'svg' });
    expect(readSvg('<svg')).toEqual({ error: 'svg' });
  });
});
