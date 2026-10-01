// DECISIONS.md D42: painting an area with rings s apart and a pen 3s wide.
import { describe, expect, it } from 'vitest';
import { FILL_BUDGET, edt, fillSpacing, isolines, paintAreas, rasterizeLoops, regionsOf } from '../../src/core/fill.ts';
import { mulberry32, type Pt } from '../../src/core/fourier.ts';

/** A w × h mask with the pixels whose centres pass the test. */
function mask(w: number, h: number, inside: (x: number, y: number) => boolean): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = inside(x + 0.5, y + 0.5) ? 1 : 0;
  return m;
}

/** Distance from p to the polyline (closed when the walk comes back to its start). */
function distanceToWalk(p: Pt, walk: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < walk.length; i++) {
    const a = walk[i], b = walk[(i + 1) % walk.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

/** Every pixel centre of the mask with at least `margin` of ink around it is under the pen. */
function expectCovered(m: Uint8Array, w: number, h: number, walks: Pt[][], radius: number, margin = 0) {
  const d = edt(m, w, h);
  let bare = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x] || d[y * w + x] - 0.5 < margin) continue;
      const p: Pt = [x + 0.5, y + 0.5];
      if (Math.min(...walks.map(walk => distanceToWalk(p, walk))) > radius) bare++;
    }
  }
  expect(bare).toBe(0);
}

/** Every vertex of the walks is at least `inset` in from the area's edge, and every segment's midpoint is inside. */
function expectInside(m: Uint8Array, w: number, h: number, walks: Pt[][], inset: number) {
  const d = edt(m, w, h);
  const at = ([x, y]: Pt) => {
    const X = Math.floor(x), Y = Math.floor(y);
    return X < 0 || Y < 0 || X >= w || Y >= h ? 0 : d[Y * w + X] - 0.5;
  };
  for (const walk of walks) {
    for (let i = 0; i < walk.length; i++) {
      const a = walk[i], b = walk[(i + 1) % walk.length];
      expect(at(a), `vertex ${a}`).toBeGreaterThan(inset);
      expect(at([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]), `between ${a} and ${b}`).toBeGreaterThan(0);
    }
  }
}

describe('the Euclidean distance transform', () => {
  it('is the exact distance to the nearest pixel centre outside the mask (the image is surrounded by paper)', () => {
    const rand = mulberry32(7);
    for (let trial = 0; trial < 5; trial++) {
      const w = 13 + trial, h = 9 + 2 * trial;
      const m = mask(w, h, () => rand() < 0.75);
      const d = edt(m, w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!m[y * w + x]) { expect(d[y * w + x]).toBe(0); continue; }
          let best = Infinity;
          for (let v = -1; v <= h; v++) {
            for (let u = -1; u <= w; u++) {
              const paper = u < 0 || v < 0 || u >= w || v >= h || !m[v * w + u];
              if (paper) best = Math.min(best, Math.hypot(u - x, v - y));
            }
          }
          expect(d[y * w + x]).toBeCloseTo(best, 12);
        }
      }
    }
  });
});

describe('contours', () => {
  it('the contour of a cone at a level is a circle of the right radius', () => {
    const w = 61, h = 61, field = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) field[y * w + x] = Math.max(0, 25 - Math.hypot(x - 30, y - 30));
    const loops = isolines(field, w, h, 7);
    expect(loops).toHaveLength(1);
    for (const [x, y] of loops[0]) expect(Math.hypot(x - 30.5, y - 30.5)).toBeCloseTo(18, 1);
  });

  it('opposite corners above the level stay apart unless the middle of the cell is above it too', () => {
    expect(isolines([1, 0, 0, 1], 2, 2, 0.5)).toHaveLength(2);
    expect(isolines([1, 0.2, 0.2, 1], 2, 2, 0.5)).toHaveLength(1);
  });

  it('even-odd rasterizing: a square with a square hole', () => {
    const outer: Pt[] = [[10, 10], [70, 10], [70, 70], [10, 70]], hole: Pt[] = [[30, 30], [50, 30], [50, 50], [30, 50]];
    const m = rasterizeLoops([outer, hole], 80, 80);
    expect(m.reduce((a, b) => a + b, 0)).toBe(60 * 60 - 20 * 20);
    expect(m[40 * 80 + 40]).toBe(0);
    expect(m[20 * 80 + 20]).toBe(1);
    expect(regionsOf(m, 80, 80)).toHaveLength(1);
  });
});

describe('painting an area', () => {
  it('the spacing: at least a pixel, a quarter of a percent of the picture, and wider when there is a lot to paint', () => {
    expect(fillSpacing(100, 100)).toBe(1);
    expect(fillSpacing(100, 2000)).toBe(5);
    expect(fillSpacing(FILL_BUDGET * 1000 * 1000, 1000)).toBe(1000);
  });

  it('a disk: one closed walk with a pen three spacings wide, covering all of it and never leaving it', () => {
    const w = 80, h = 80, m = mask(w, h, (x, y) => Math.hypot(x - 40, y - 40) <= 30);
    const p = paintAreas(m, w, h, 2);
    expect(p.areas).toBe(1);
    expect(p.strokes).toHaveLength(1);
    expect(p.strokes[0]).toMatchObject({ closed: true, fill: 6 });
    const walk = p.strokes[0].pts;
    expect(walk[walk.length - 1]).toEqual(walk[0]); // it comes back to where it started
    expectCovered(m, w, h, [walk], 2 + 0.75);
    expectInside(m, w, h, [walk], 2 - 1);
  });

  it('an annulus: the hole stays bare, and the rings from both edges are still one walk', () => {
    const w = 90, h = 90, m = mask(w, h, (x, y) => { const r = Math.hypot(x - 45, y - 45); return r >= 12 && r <= 40; });
    const p = paintAreas(m, w, h, 1.5);
    expect(p.strokes).toHaveLength(1);
    const walk = p.strokes[0].pts;
    for (const [x, y] of walk) expect(Math.hypot(x - 45, y - 45)).toBeGreaterThan(12 + 1.5 - 1);
    expectCovered(m, w, h, [walk], 1.5 + 0.75);
    expectInside(m, w, h, [walk], 1.5 - 1);
  });

  it('a blob of overlapping disks: painted everywhere at least a spacing in from the edge, never outside', () => {
    const rand = mulberry32(3);
    const disks = Array.from({ length: 6 }, () => [30 + 60 * rand(), 30 + 40 * rand(), 9 + 10 * rand()]);
    const w = 120, h = 100, m = mask(w, h, (x, y) => disks.some(([cx, cy, r]) => Math.hypot(x - cx, y - cy) <= r));
    const s = 1.5, p = paintAreas(m, w, h, s);
    const walks = p.strokes.map(st => st.pts);
    expect(p.areas).toBe(regionsOf(m, w, h).length);
    expectCovered(m, w, h, walks, s + 0.75, s);
    expectInside(m, w, h, walks, s - 1);
    expect(paintAreas(m, w, h, s)).toEqual(p); // the same every time
  });

  it('separate areas are separate walks; an area thinner than the spacing is not painted', () => {
    const w = 100, h = 60;
    const two = mask(w, h, (x, y) => Math.hypot(x - 25, y - 30) <= 15 || Math.hypot(x - 75, y - 30) <= 15);
    expect(paintAreas(two, w, h, 2)).toMatchObject({ areas: 2 });
    expect(paintAreas(two, w, h, 2).strokes).toHaveLength(2);
    const line = mask(w, h, (x, y) => y >= 29 && y <= 31 && x > 10 && x < 90);
    expect(paintAreas(line, w, h, 2)).toMatchObject({ areas: 0, strokes: [] });
  });
});
