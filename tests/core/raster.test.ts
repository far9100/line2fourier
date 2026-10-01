// Spec §5.5 on images drawn in the test: rings, crosses, a T, thick lines, specks, solid areas.
import { describe, expect, it } from 'vitest';
import {
  binarize, chamfer, eulerTrails, otsu, outlines, pruneSpurs, rasterToStrokes, removeSpecks, skeletonGraph,
  solidAreas, toGray, zhangSuen, type SkeletonGraph,
} from '../../src/core/raster.ts';
import type { Pt } from '../../src/core/fourier.ts';

/** A white RGBA image with black where ink(x, y) is true. */
function image(w: number, h: number, ink: (x: number, y: number) => boolean, invert = false): Uint8ClampedArray {
  const px = new Uint8ClampedArray(4 * w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = ink(x + 0.5, y + 0.5) !== invert ? 0 : 255;
      px.set([v, v, v, 255], 4 * (y * w + x));
    }
  }
  return px;
}

const ring = (cx: number, cy: number, r: number, width: number) => (x: number, y: number) => Math.abs(Math.hypot(x - cx, y - cy) - r) <= width / 2;
const disk = (cx: number, cy: number, r: number) => (x: number, y: number) => Math.hypot(x - cx, y - cy) <= r;
const bar = (x0: number, y0: number, x1: number, y1: number) => (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const any = (...fs: ((x: number, y: number) => boolean)[]) => (x: number, y: number) => fs.some(f => f(x, y));
const lengthOf = (pts: Pt[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

describe('grey levels and threshold', () => {
  it('transparent pixels count as white paper', () => {
    const px = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]);
    expect(Array.from(toGray(px, 2, 1).v)).toEqual([255, 0]);
  });

  it('shrinks with a box filter to the size limit', () => {
    const g = toGray(image(400, 200, bar(0, 0, 200, 200)), 400, 200, 100);
    expect([g.w, g.h]).toEqual([100, 50]);
    expect(g.v[0]).toBe(0);
    expect(g.v[99]).toBe(255);
  });

  it('Otsu separates the two levels of a two-level image; ink is the minority', () => {
    const g = toGray(image(50, 50, bar(10, 10, 20, 40)), 50, 50);
    const t = otsu(g);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThan(255);
    const { bits, inverted } = binarize(g, t);
    expect(inverted).toBe(false);
    expect(bits.reduce((a, b) => a + b, 0)).toBe(10 * 30);
  });

  it('light lines on a dark ground are inverted', () => {
    const g = toGray(image(50, 50, bar(10, 10, 20, 40), true), 50, 50);
    const { bits, inverted } = binarize(g, otsu(g));
    expect(inverted).toBe(true);
    expect(bits.reduce((a, b) => a + b, 0)).toBe(10 * 30);
  });

  it('specks smaller than the limit go, lines stay', () => {
    const w = 40, h = 40;
    const bits = new Uint8Array(w * h);
    bits[5 * w + 5] = 1;
    for (let x = 10; x < 30; x++) bits[20 * w + x] = 1;
    expect(removeSpecks(bits, w, h, 4)).toBe(1);
    expect(bits.reduce((a, b) => a + b, 0)).toBe(20);
  });
});

describe('solid areas are outlined and painted, not thinned (DECISIONS.md D40, D42)', () => {
  it('the chamfer distance to the paper is 1 on a line one pixel wide, and grows inside a block', () => {
    const w = 9, h = 9, bits = new Uint8Array(w * h);
    for (let y = 1; y < 8; y++) for (let x = 1; x < 8; x++) bits[y * w + x] = 1;
    const d = chamfer(bits, w, h);
    expect(d[1 * w + 1]).toBe(1);
    expect(d[4 * w + 4]).toBe(4);
    expect(d[0]).toBe(0);
  });

  it('marching squares: a block is one loop, a block with a hole two, pixels meeting at a corner stay apart', () => {
    const w = 7, h = 7;
    const block = new Uint8Array(w * h);
    for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) block[y * w + x] = 1;
    expect(outlines(block, w, h)).toHaveLength(1);
    block[3 * w + 3] = 0;
    expect(outlines(block, w, h)).toHaveLength(2);
    const diagonal = new Uint8Array(w * h);
    diagonal[1 * w + 1] = diagonal[2 * w + 2] = 1;
    expect(outlines(diagonal, w, h)).toHaveLength(2);
  });

  it('a solid disk among thin lines becomes its outline, painted in; the thin lines stay lines', () => {
    const w = 200, h = 140;
    const ink = any(disk(60, 70, 22), bar(110, 20, 190, 21), bar(110, 60, 190, 61), bar(110, 100, 190, 101), bar(82, 69, 110, 70));
    const g = toGray(image(w, h, ink), w, h);
    const { bits } = binarize(g, otsu(g));
    const fill = solidAreas(bits, w, h);
    expect(fill.regions).toBe(1);
    expect(fill.halfWidth).toBeLessThan(1.5);
    const r = rasterToStrokes(image(w, h, ink), w, h);
    expect(r.filled).toBe(1);
    expect(r.warnings['import.filled']).toBe(1);
    const outline = r.strokes.filter(s => s.closed && !s.fill);
    expect(outline).toHaveLength(1);
    for (const [x, y] of outline[0].pts) expect(Math.abs(Math.hypot(x - 60, y - 70) - 22)).toBeLessThan(2.5);
    // Nothing is traced inside the disk; it is painted, by one walk that stays in it.
    for (const s of r.strokes.filter(t => !t.closed)) for (const [x, y] of s.pts) expect(Math.hypot(x - 60, y - 70)).toBeGreaterThan(18);
    const paint = r.strokes.filter(s => s.fill);
    expect(paint).toHaveLength(1);
    expect(paint[0].closed).toBe(true);
    for (const [x, y] of paint[0].pts) expect(Math.hypot(x - 60, y - 70)).toBeLessThan(22.5 - paint[0].fill! / 3 + 0.5); // a spacing in from the edge
  });

  it('a drawing of thick lines only has no solid areas: thickness is judged against its own lines', () => {
    const r = rasterToStrokes(image(120, 120, ring(60, 60, 40, 9)), 120, 120);
    expect(r.filled).toBe(0);
    expect(r.strokes).toHaveLength(1);
    expect(r.strokes[0].closed).toBe(true);
  });
});

describe('the skeleton walked as Euler trails (DECISIONS.md D39)', () => {
  it('a 7-pixel-wide bar thins to a one-pixel line', () => {
    const w = 60, h = 30;
    const g = toGray(image(w, h, bar(10, 12, 50, 18)), w, h);
    const sk = zhangSuen(binarize(g, otsu(g)).bits, w, h);
    for (let x = 14; x < 46; x++) {
      let column = 0;
      for (let y = 0; y < h; y++) column += sk[y * w + x];
      expect(column, `column ${x}`).toBe(1);
    }
  });

  it('a ring is one closed stroke', () => {
    const r = rasterToStrokes(image(120, 120, ring(60, 60, 40, 5)), 120, 120);
    expect(r.strokes).toHaveLength(1);
    expect(r.strokes[0].closed).toBe(true);
    for (const [x, y] of r.strokes[0].pts) expect(Math.abs(Math.hypot(x - 60, y - 60) - 40)).toBeLessThan(2.5);
  });

  it('a plus sign is two strokes, a T is two: lines go on through a junction', () => {
    // + : four end points (odd), the crossing has four lines (even) → 4 / 2 = 2 strokes
    const plus = rasterToStrokes(image(120, 120, any(bar(20, 57, 100, 63), bar(57, 20, 63, 100))), 120, 120);
    expect(plus.strokes).toHaveLength(2);
    // T : three end points and a junction of three → 4 odd vertices → 2 strokes
    const tee = rasterToStrokes(image(120, 120, any(bar(20, 20, 100, 26), bar(57, 20, 63, 100))), 120, 120);
    expect(tee.strokes).toHaveLength(2);
  });

  it('the trails cover every line of the graph exactly once', () => {
    const w = 160, h = 160;
    const g = toGray(image(w, h, any(bar(20, 77, 140, 82), bar(77, 20, 82, 140), ring(80, 80, 45, 4))), w, h);
    const graph = pruneSpurs(skeletonGraph(zhangSuen(binarize(g, otsu(g)).bits, w, h), w, h), 3);
    const inGraph = graph.edges.reduce((s, e) => s + e.len, 0);
    const inTrails = eulerTrails(graph).reduce((s, t) => s + lengthOf(t.closed ? [...t.pts, t.pts[0]] : t.pts), 0);
    // Trails may also cross a junction between neighbouring pixels of it (at most ~1.5 px per crossing).
    expect(inTrails).toBeGreaterThanOrEqual(inGraph - 1e-9);
    expect(inTrails - inGraph).toBeLessThan(0.02 * inGraph);
  });

  it('Euler trails on small graphs: a path is one stroke, a figure eight one closed stroke, a star of three two', () => {
    const P = (x: number, y: number): Pt => [x, y];
    const edge = (a: number, b: number, pts: Pt[]) => ({ a, b, pts, len: lengthOf(pts) });
    const path: SkeletonGraph = { nodes: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], edges: [edge(0, 1, [P(0, 0), P(1, 0)]), edge(1, 2, [P(1, 0), P(2, 0)])] };
    const one = eulerTrails(path);
    expect(one).toHaveLength(1);
    expect(one[0].closed).toBe(false);
    const eight: SkeletonGraph = { nodes: [{ x: 0, y: 0 }], edges: [edge(0, 0, [P(0, 0), P(1, 1), P(2, 0), P(0, 0)]), edge(0, 0, [P(0, 0), P(-1, 1), P(-2, 0), P(0, 0)])] };
    const loop = eulerTrails(eight);
    expect(loop).toHaveLength(1);
    expect(loop[0].closed).toBe(true);
    const star: SkeletonGraph = {
      nodes: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }, { x: -5, y: 0 }],
      edges: [edge(0, 1, [P(0, 0), P(5, 0)]), edge(0, 2, [P(0, 0), P(0, 5)]), edge(0, 3, [P(0, 0), P(-5, 0)])],
    };
    const trails = eulerTrails(star);
    expect(trails).toHaveLength(2);
    expect(trails.reduce((s, t) => s + lengthOf(t.pts), 0)).toBeCloseTo(15, 9);
  });

  it('a skeleton loop with no ends is still traced, as one closed stroke', () => {
    const w = 20, h = 20, sk = new Uint8Array(w * h);
    for (let i = 5; i <= 14; i++) { sk[5 * w + i] = 1; sk[14 * w + i] = 1; sk[i * w + 5] = 1; sk[i * w + 14] = 1; }
    const graph = skeletonGraph(sk, w, h);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].a).toBe(graph.edges[0].b);
    const trails = eulerTrails(graph);
    expect(trails).toHaveLength(1);
    expect(trails[0].closed).toBe(true);
  });

  it('short spurs from a junction are dropped, and only those', () => {
    const P = (x: number, y: number): Pt => [x, y];
    const edge = (a: number, b: number, pts: Pt[]) => ({ a, b, pts, len: lengthOf(pts) });
    const g: SkeletonGraph = {
      nodes: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: -30, y: 0 }, { x: 0, y: 2 }],
      edges: [edge(0, 1, [P(0, 0), P(30, 0)]), edge(0, 2, [P(0, 0), P(-30, 0)]), edge(0, 3, [P(0, 0), P(0, 2)])],
    };
    expect(pruneSpurs(g, 3).edges).toHaveLength(2);
  });

  it('two separate shapes are separate strokes, and a straight line keeps only its ends', () => {
    const r = rasterToStrokes(image(160, 80, any(ring(40, 40, 25, 4), bar(90, 38, 150, 42))), 160, 80);
    expect(r.strokes).toHaveLength(2);
    const line = r.strokes.find(s => !s.closed)!;
    expect(line.pts).toHaveLength(2);
  });

  it('the same image always gives the same strokes', () => {
    const px = image(100, 100, any(ring(50, 50, 30, 6), bar(10, 48, 90, 52), disk(80, 80, 9)));
    expect(rasterToStrokes(px, 100, 100)).toEqual(rasterToStrokes(px, 100, 100));
  });

  it('a mostly dark picture is flagged as probably a photo', () => {
    const r = rasterToStrokes(image(60, 60, (x, y) => (x + y) % 7 < 3), 60, 60);
    expect(r.warnings['raster.photo']).toBe(1);
  });
});
