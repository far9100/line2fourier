import { describe, expect, it } from 'vitest';
import { resampleClosed, type Pt } from '../../src/core/fourier.ts';
import {
  CLOSURE, INK, JUMP, PathError, buildPath, cleanStroke, kindSpans, normalizeToUnit, orientedPoints,
  prepareStrokes, samplePath, strokesBBox, type Stroke,
} from '../../src/core/path.ts';

const square: Stroke = { pts: [[0, 0], [1, 0], [1, 1], [0, 1]], closed: true };
const vee: Stroke = { pts: [[0, 0], [1, 2], [2, 0]], closed: false };

function rejects(strokes: Stroke[], code: string) {
  try {
    prepareStrokes(strokes);
  } catch (e) {
    expect(e).toBeInstanceOf(PathError);
    expect((e as PathError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ${code} rejection`);
}

describe('cleaning and rejecting (spec §13)', () => {
  it('drops repeated points, non-numbers, and a closed stroke’s copy of its first point', () => {
    const s = cleanStroke({ pts: [[0, 0], [0, 0], [1, 0], [NaN, 1], [1, 1], [1, 1], [0, 0]], closed: true });
    expect(s).toEqual({ pts: [[0, 0], [1, 0], [1, 1]], closed: true });
  });

  it('rejects an empty drawing, a zero-length one, and fewer than 3 distinct points', () => {
    rejects([], 'empty');
    rejects([{ pts: [], closed: false }], 'empty');
    rejects([{ pts: [[1, 1], [1, 1], [1, 1]], closed: false }], 'zero-length');
    rejects([{ pts: [[0, 0], [1, 1]], closed: false }], 'too-few-points');
    rejects([{ pts: [[0, 0], [1, 1]], closed: false }, { pts: [[1, 1], [0, 0]], closed: false }], 'too-few-points');
  });

  it('keeps drawings with 3 distinct points, dropping strokes that are single dots', () => {
    const out = prepareStrokes([{ pts: [[5, 5]], closed: false }, { pts: [[0, 0], [1, 0], [1, 1]], closed: false }]);
    expect(out).toHaveLength(1);
  });
});

describe('normalizing (spec §3)', () => {
  it('centres the bounding box on the origin with the long side from -1 to 1', () => {
    const [s] = normalizeToUnit([{ pts: [[10, 20], [14, 20], [14, 22]], closed: false }]);
    const b = strokesBBox([s]);
    expect([b.minX, b.maxX, b.minY, b.maxY]).toEqual([-1, 1, -0.5, 0.5]);
  });
});

describe('building the closed path (spec §4.6)', () => {
  it('a single closed stroke is all ink', () => {
    const p = buildPath([square]);
    expect(p.poly).toEqual(square.pts);
    expect(Array.from(p.kinds)).toEqual([INK, INK, INK, INK]);
    expect(p.total).toBe(4);
    expect(p.lengths).toEqual([4, 0, 0]);
  });

  it('a single open stroke is closed by a straight closure segment', () => {
    const p = buildPath([vee]);
    expect(p.poly).toEqual(vee.pts);
    expect(Array.from(p.kinds)).toEqual([INK, INK, CLOSURE]);
    expect(p.lengths[CLOSURE]).toBe(2);
  });

  it('several strokes are joined by jumps, including the jump back to the start', () => {
    const second: Stroke = { pts: [[5, 0], [6, 0]], closed: false };
    const p = buildPath([vee, second]);
    expect(p.poly).toEqual([[0, 0], [1, 2], [2, 0], [5, 0], [6, 0]]);
    expect(Array.from(p.kinds)).toEqual([INK, INK, JUMP, INK, JUMP]);
    expect(p.lengths[JUMP]).toBe(3 + 6);
    expect(p.total).toBeCloseTo(2 * Math.hypot(1, 2) + 3 + 1 + 6, 12);
  });

  it('strokes that touch are joined without a jump', () => {
    const p = buildPath([{ pts: [[0, 0], [1, 0]], closed: false }, { pts: [[1, 0], [1, 1]], closed: false }]);
    expect(p.poly).toEqual([[0, 0], [1, 0], [1, 1]]);
    expect(Array.from(p.kinds)).toEqual([INK, INK, JUMP]);
  });

  it('a closed stroke inside a tour is walked all the way round, from its start vertex, in either direction', () => {
    expect(orientedPoints(square, { index: 0, reversed: false, start: 2 })).toEqual([[1, 1], [0, 1], [0, 0], [1, 0], [1, 1]]);
    expect(orientedPoints(square, { index: 0, reversed: true, start: 2 })).toEqual([[1, 1], [1, 0], [0, 0], [0, 1], [1, 1]]);
    const p = buildPath([vee, square], [{ index: 0, reversed: false, start: 0 }, { index: 1, reversed: false, start: 1 }]);
    expect(p.poly).toEqual([[0, 0], [1, 2], [2, 0], [1, 0], [1, 1], [0, 1], [0, 0], [1, 0]]);
    expect(Array.from(p.kinds)).toEqual([INK, INK, JUMP, INK, INK, INK, INK, JUMP]);
    expect(p.lengths[INK]).toBeCloseTo(2 * Math.hypot(1, 2) + 4, 12);
  });

  it('cum holds the arc length at every vertex', () => {
    const p = buildPath([vee]);
    expect(Array.from(p.cum)).toEqual([0, Math.hypot(1, 2), 2 * Math.hypot(1, 2), 2 * Math.hypot(1, 2) + 2]);
  });
});

describe('kind spans and samples', () => {
  const second: Stroke = { pts: [[5, 0], [6, 0]], closed: false };
  const p = buildPath([vee, second]);

  it('kindSpans gives the parameter intervals of each kind, merged', () => {
    const t = (s: number) => s / p.total, a = Math.hypot(1, 2);
    const close = (got: [number, number][], want: [number, number][]) => {
      expect(got).toHaveLength(want.length);
      got.flat().forEach((v, i) => expect(v).toBeCloseTo(want.flat()[i], 12));
    };
    close(kindSpans(p, INK), [[0, t(2 * a)], [t(2 * a + 3), t(2 * a + 4)]]);
    close(kindSpans(p, JUMP), [[t(2 * a), t(2 * a + 3)], [t(2 * a + 4), 1]]);
    expect(kindSpans(p, JUMP)[1][1]).toBe(1);
  });

  it('samplePath gives resampleClosed’s points and the kind under each one', () => {
    const N = 512;
    const s = samplePath(p, N);
    expect(s.pts).toEqual(resampleClosed(p.poly, N));
    const jumps = kindSpans(p, JUMP);
    s.kind.forEach((k, n) => {
      const t = n / N;
      const inJump = jumps.some(([a, b]) => t > a && t < b);
      const onEdge = jumps.some(([a, b]) => Math.abs(t - a) < 1e-12 || Math.abs(t - b) < 1e-12);
      if (!onEdge) expect(k === JUMP).toBe(inJump);
    });
  });

  it('a drawing without jumps has no pen-up samples', () => {
    const s = samplePath(buildPath([square]), 256);
    expect(s.kind.every(k => k === INK)).toBe(true);
  });

  it('a single open stroke has closure samples only on its closing line', () => {
    const q = buildPath([vee]);
    const s = samplePath(q, 300);
    const [[a, b]] = kindSpans(q, CLOSURE);
    s.kind.forEach((k, n) => {
      const t = n / 300;
      if (t > a + 1e-12) expect(k).toBe(CLOSURE);
      if (t < a - 1e-12) expect(k).toBe(INK);
    });
    expect(b).toBe(1);
  });

  it('the first sample is the first point of the path', () => {
    const pts: Pt[] = samplePath(p, 64).pts;
    expect(pts[0]).toEqual([0, 0]);
  });
});
