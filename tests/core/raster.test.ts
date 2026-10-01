// Spec §5.5 on images drawn in the test: rings, crosses, a T, thick lines, specks.
import { describe, expect, it } from 'vitest';
import { binarize, otsu, rasterToStrokes, removeSpecks, toGray, traceSkeleton, zhangSuen } from '../../src/core/raster.ts';

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
const bar = (x0: number, y0: number, x1: number, y1: number) => (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const any = (...fs: ((x: number, y: number) => boolean)[]) => (x: number, y: number) => fs.some(f => f(x, y));

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
    bits[5 * w + 5] = 1; // a one-pixel speck
    for (let x = 10; x < 30; x++) bits[20 * w + x] = 1; // a line of 20
    expect(removeSpecks(bits, w, h, 4)).toBe(1);
    expect(bits.reduce((a, b) => a + b, 0)).toBe(20);
  });
});

describe('thinning and tracing', () => {
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

  it('a plus sign is four arms from one junction; a T is three', () => {
    const plus = rasterToStrokes(image(120, 120, any(bar(20, 57, 100, 63), bar(57, 20, 63, 100))), 120, 120);
    expect(plus.strokes).toHaveLength(4);
    const tee = rasterToStrokes(image(120, 120, any(bar(20, 20, 100, 26), bar(57, 20, 63, 100))), 120, 120);
    expect(tee.strokes).toHaveLength(3);
  });

  it('two separate shapes are separate strokes, and a straight line keeps only its ends', () => {
    const r = rasterToStrokes(image(160, 80, any(ring(40, 40, 25, 4), bar(90, 38, 150, 42))), 160, 80);
    expect(r.strokes).toHaveLength(2);
    const line = r.strokes.find(s => !s.closed)!;
    expect(line.pts).toHaveLength(2);
  });

  it('a skeleton loop with no ends is still traced', () => {
    const w = 20, h = 20, sk = new Uint8Array(w * h);
    for (let i = 5; i <= 14; i++) { sk[5 * w + i] = 1; sk[14 * w + i] = 1; sk[i * w + 5] = 1; sk[i * w + 14] = 1; }
    const lines = traceSkeleton(sk, w, h);
    expect(lines).toHaveLength(1);
    expect(lines[0].closed).toBe(true);
    expect(lines[0].pts).toHaveLength(36);
  });

  it('the same image always gives the same strokes', () => {
    const px = image(100, 100, any(ring(50, 50, 30, 6), bar(10, 48, 90, 52)));
    expect(rasterToStrokes(px, 100, 100)).toEqual(rasterToStrokes(px, 100, 100));
  });

  it('a mostly dark picture is flagged as probably a photo', () => {
    const r = rasterToStrokes(image(60, 60, (x, y) => (x + y) % 7 < 3), 60, 60);
    expect(r.warnings['raster.photo']).toBe(1);
  });
});
