import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { coefficients, resampleClosed, type Pt } from '../../src/core/fourier.ts';
import { GENERATORS, catmullRomClosed, generate, newSeed, subStream } from '../../src/core/generators.ts';
import { strokesBBox } from '../../src/core/path.ts';

/** First 16 hex digits of the SHA-256 of the points as float64s: changes whenever a single bit of the output does. */
const fingerprint = (pts: Pt[]) =>
  createHash('sha256').update(new Uint8Array(new Float64Array(pts.flat()).buffer)).digest('hex').slice(0, 16);

/** Pairs of non-adjacent segments of a closed polyline that properly cross. */
function selfCrossings(p: Pt[]): number {
  const n = p.length;
  const side = (a: Pt, b: Pt, q: Pt) => Math.sign((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]));
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const a = p[i], b = p[(i + 1) % n], c = p[j], d = p[(j + 1) % n];
      if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) count++;
    }
  }
  return count;
}

// Recorded from this implementation (Node 24 / V8). A change here means every saved project
// with that generator would draw differently: bump the project file's engine version with it.
const GOLDEN: Record<string, string> = {
  'creature 1': '0cf400c1cbcb9f97',
  'creature 42': '5e94221ea9c1d124',
  'creature 123456789': 'af6bb6ba044291e3',
  'scribble 1': '78f538591c2c8dd3',
  'scribble 42': '94f7e6b970f9100e',
  'scribble 123456789': 'c7bac8ab120f1749',
  'star 1': '8cfcdb8742f60d2c',
  'star 42': '0ff8e7b8be14a517',
  'star 123456789': '850b5f58539fad17',
};

describe('random drawings (spec §5.1)', () => {
  it('the same seed always gives the same drawing, bit for bit', () => {
    for (const [key, hash] of Object.entries(GOLDEN)) {
      const [name, seed] = key.split(' ');
      expect(fingerprint(generate(name as (typeof GENERATORS)[number], Number(seed)).pts), key).toBe(hash);
    }
  });

  it('different seeds give different drawings', () => {
    for (const name of GENERATORS) {
      expect(fingerprint(generate(name, 1).pts)).not.toBe(fingerprint(generate(name, 2).pts));
    }
  });

  it('every drawing is closed, normalized to [-1, 1]² and long enough to draw', () => {
    for (const name of GENERATORS) {
      for (let seed = 0; seed < 40; seed++) {
        const s = generate(name, seed * 2654435761);
        expect(s.closed).toBe(true);
        expect(s.pts.length).toBeGreaterThanOrEqual(10);
        const b = strokesBBox([s]);
        expect(Math.abs(b.minX + b.maxX)).toBeLessThan(1e-12);
        expect(Math.abs(b.minY + b.maxY)).toBeLessThan(1e-12);
        expect(Math.max(b.maxX - b.minX, b.maxY - b.minY)).toBeCloseTo(2, 12);
      }
    }
  });

  it('the creature is a 720-point outline that never crosses itself', () => {
    for (let seed = 0; seed < 25; seed++) {
      const { pts } = generate('creature', seed * 7919 + 1);
      expect(pts).toHaveLength(720);
      expect(selfCrossings(pts)).toBe(0);
    }
  });

  it('the star is a simple polygon with 5 to 9 points', () => {
    for (let seed = 0; seed < 40; seed++) {
      const { pts } = generate('star', seed * 104729 + 3);
      expect(pts.length % 2).toBe(0);
      expect(pts.length / 2).toBeGreaterThanOrEqual(5);
      expect(pts.length / 2).toBeLessThanOrEqual(9);
      expect(selfCrossings(pts)).toBe(0);
    }
  });

  it('the scribble is a 30-points-per-segment spline whose loops cross the line', () => {
    for (let seed = 0; seed < 25; seed++) {
      const { pts } = generate('scribble', seed * 31337 + 5);
      expect(pts.length % 30).toBe(0);
      expect(selfCrossings(pts)).toBeGreaterThanOrEqual(1);
    }
  });

  it('the star’s corners make |c_k| fall off like 1/k² (spec §1)', () => {
    const N = 4096;
    const c = coefficients(resampleClosed(generate('star', 42).pts, N));
    const envelope = (K: number) => Math.max(...c.filter(t => Math.abs(t.k) >= K && Math.abs(t.k) < 2 * K).map(t => t.amp));
    const slope = Math.log(envelope(256) / envelope(16)) / Math.log(256 / 16);
    expect(slope).toBeGreaterThan(-2.4);
    expect(slope).toBeLessThan(-1.6);
  });
});

describe('random streams', () => {
  it('sub-streams of one seed are independent, and reproducible', () => {
    const a = subStream(5, 1), b = subStream(5, 2), a2 = subStream(5, 1);
    const xs = Array.from({ length: 8 }, () => a()), ys = Array.from({ length: 8 }, () => b());
    expect(Array.from({ length: 8 }, () => a2())).toEqual(xs);
    expect(xs).not.toEqual(ys);
    for (const v of [...xs, ...ys]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('newSeed gives 32-bit unsigned integers', () => {
    for (let i = 0; i < 20; i++) {
      const s = newSeed();
      expect(Number.isInteger(s) && s >= 0 && s < 2 ** 32).toBe(true);
    }
  });
});

describe('centripetal Catmull–Rom', () => {
  it('passes through every control point', () => {
    const ctrl: Pt[] = [[0, 0], [1, 0.2], [1.5, 1], [0.4, 1.3], [-0.5, 0.6]];
    const out = catmullRomClosed(ctrl, 10);
    expect(out).toHaveLength(50);
    ctrl.forEach((p, i) => {
      expect(out[i * 10][0]).toBeCloseTo(p[0], 12);
      expect(out[i * 10][1]).toBeCloseTo(p[1], 12);
    });
  });

  it('survives repeated control points', () => {
    const out = catmullRomClosed([[0, 0], [0, 0], [1, 0], [0, 1]], 5);
    expect(out.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });
});
