// Spec §12 M0: the eleven checks of the Fourier core, numbered as in the spec, then the checks for
// what src/core/fourier.ts adds or changes relative to the §11 reference.
import { describe, expect, it } from 'vitest';
import {
  chainAt, chainInto, coefficients, energyTable, fft, metrics, mulberry32, orderTerms, partialCurve,
  resampleClosed, resampleClosedIndexed, toDesmos, type Pt, type Term,
} from '../../src/core/fourier.ts';
import { loadSpecReference } from '../helpers/spec11.ts';
import { parseDesmos } from '../helpers/parseDesmos.ts';

const spec = loadSpecReference();
const N = 1024;

/** A closed polygon with 37 jittered vertices: corners, so every coefficient is non-zero. */
function randomPolygon(seed: number, n = 37): Pt[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => {
    const th = (2 * Math.PI * i) / n + (rnd() - 0.5) * 0.2, r = 0.4 + 0.6 * rnd();
    return [r * Math.cos(th), r * Math.sin(th)] as Pt;
  });
}

const maxDist = (a: Pt[], b: Pt[]) => a.reduce((m, p, i) => Math.max(m, Math.hypot(p[0] - b[i][0], p[1] - b[i][1])), 0);
const byK = (terms: Term[]) => new Map(terms.map(c => [c.k, c]));
const directRms = (a: Pt[], b: Pt[]) => Math.sqrt(a.reduce((s, p, i) => s + (p[0] - b[i][0]) ** 2 + (p[1] - b[i][1]) ** 2, 0) / a.length);

const samples = resampleClosed(randomPolygon(12345), N);
const all = coefficients(samples);

describe('spec §12 M0', () => {
  it('1. FFT agrees with the direct DFT (N = 256, random data)', () => {
    const n = 256, rnd = mulberry32(1);
    const re = new Float64Array(n).map(() => rnd() * 2 - 1), im = new Float64Array(n).map(() => rnd() * 2 - 1);
    const fr = re.slice(), fi = im.slice();
    fft(fr, fi);
    let err = 0;
    for (let m = 0; m < n; m++) {
      let sr = 0, si = 0;
      for (let k = 0; k < n; k++) {
        const a = (-2 * Math.PI * m * k) / n;
        sr += re[k] * Math.cos(a) - im[k] * Math.sin(a);
        si += re[k] * Math.sin(a) + im[k] * Math.cos(a);
      }
      err = Math.max(err, Math.hypot(sr - fr[m], si - fi[m]));
    }
    expect(err).toBeLessThan(1e-9);
  });

  it('2. the inverse FFT divided by N gives the data back', () => {
    const n = 256, rnd = mulberry32(2);
    const re = new Float64Array(n).map(() => rnd() * 2 - 1), im = new Float64Array(n).map(() => rnd() * 2 - 1);
    const r2 = re.slice(), i2 = im.slice();
    fft(r2, i2);
    fft(r2, i2, true);
    let err = 0;
    for (let k = 0; k < n; k++) err = Math.max(err, Math.hypot(r2[k] / n - re[k], i2[k] / n - im[k]));
    expect(err).toBeLessThan(1e-9);
  });

  it('3. the circle e^{2πin/N} has c_1 = 1 and nothing else', () => {
    const circle = Array.from({ length: N }, (_, n) => [Math.cos((2 * Math.PI * n) / N), Math.sin((2 * Math.PI * n) / N)] as Pt);
    for (const c of coefficients(circle)) {
      if (c.k === 1) expect(Math.hypot(c.re - 1, c.im)).toBeLessThan(1e-12);
      else expect(c.amp).toBeLessThan(1e-12);
    }
  });

  it('4. the ellipse a·cos + i·b·sin has c_1 = (a + b)/2 and c_-1 = (a − b)/2', () => {
    const a = 1.7, b = 0.6;
    const ellipse = Array.from({ length: N }, (_, n) => [a * Math.cos((2 * Math.PI * n) / N), b * Math.sin((2 * Math.PI * n) / N)] as Pt);
    const c = byK(coefficients(ellipse));
    expect(Math.hypot(c.get(1)!.re - (a + b) / 2, c.get(1)!.im)).toBeLessThan(1e-12);
    expect(Math.hypot(c.get(-1)!.re - (a - b) / 2, c.get(-1)!.im)).toBeLessThan(1e-12);
  });

  it('5. Parseval: (1/N)·Σ|z_n|² = Σ|c_k|²', () => {
    const lhs = samples.reduce((s, [x, y]) => s + x * x + y * y, 0) / N;
    const rhs = all.reduce((s, c) => s + c.amp * c.amp, 0);
    expect(Math.abs(lhs - rhs)).toBeLessThan(1e-12);
  });

  it('6. all N − 1 circles give the samples back', () => {
    const { c0, terms } = orderTerms(all);
    expect(maxDist(partialCurve(c0, terms, N - 1, N), samples)).toBeLessThan(1e-9);
  });

  it('7. rmsError is the RMS distance, and the chain tip lies on partialCurve', () => {
    const { c0, terms } = orderTerms(all);
    for (const M of [1, 5, 20, 100, 500, 1000, N - 2, N - 1]) {
      const approx = partialCurve(c0, terms, M, N);
      expect(Math.abs(metrics(samples, approx, terms, M).rmsError - directRms(samples, approx))).toBeLessThan(1e-9);
      for (const n of [0, 1, 77, 511, N - 1]) {
        const joints = chainAt(c0, terms, M, n / N);
        const tip = joints[joints.length - 1];
        expect(Math.hypot(tip[0] - approx[n][0], tip[1] - approx[n][1])).toBeLessThan(1e-9);
      }
    }
  });

  it('8. for the same M, ordering by size never leaves a larger RMS error than ordering by frequency', () => {
    const bySize = energyTable(orderTerms(all, 'magnitude').terms);
    const byFreq = energyTable(orderTerms(all, 'frequency').terms);
    for (let M = 1; M < N; M++) {
      // Both sides are sums of the same kind of numbers in different orders: allow their rounding.
      expect(bySize.dropped[M]).toBeLessThanOrEqual(byFreq.dropped[M] * (1 + 1e-12));
    }
  });

  it('9. shifting the start keeps |c_k|; reversing the direction swaps c_k and c_-k', () => {
    const shifted = coefficients(samples.map((_, n) => samples[(n + 137) % N]));
    shifted.forEach((c, m) => expect(Math.abs(c.amp - all[m].amp)).toBeLessThan(1e-12));
    const original = byK(all);
    for (const c of coefficients(samples.map((_, n) => samples[(N - n) % N]))) {
      if (c.k === -N / 2) continue; // its partner +N/2 is outside k ∈ [-N/2, N/2)
      const o = original.get(-c.k)!;
      expect(Math.hypot(c.re - o.re, c.im - o.im)).toBeLessThan(1e-12);
    }
  });

  it('10. 400 equal-arc-length samples of a square put the same number of points on each side, ±1', () => {
    const counts = [0, 0, 0, 0];
    for (const [x, y] of resampleClosed([[0, 0], [1, 0], [1, 1], [0, 1]], 400)) {
      if (y === 0 && x < 1) counts[0]++;
      else if (x === 1 && y < 1) counts[1]++;
      else if (y === 1 && x > 0) counts[2]++;
      else counts[3]++;
    }
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('11. the Desmos text (M = 20, 5 decimals), parsed and evaluated, follows chainAt to 1e-3', () => {
    const { c0, terms } = orderTerms(all);
    const curve = parseDesmos(toDesmos(c0, terms, 20, 5));
    for (let i = 0; i <= 1000; i++) {
      const t = i / 1000, tip = chainAt(c0, terms, 20, t)[20], p = curve(t);
      expect(Math.hypot(p[0] - tip[0], p[1] - tip[1])).toBeLessThan(1e-3); // the drawing's half-width is ~1
    }
  });
});

describe('fourier.ts against the §11 reference', () => {
  const polygons: Pt[][] = [
    randomPolygon(7),
    [[0, 0], [1, 0], [1, 0], [1, 1], [0, 1], [0, 1]], // repeated points: zero-length segments
    [[0, 0], [3, 0], [3, 2]],
  ];

  it('resampleClosed gives the reference points bit for bit, and the index of each sample is right', () => {
    for (const poly of polygons) {
      for (const n of [3, 64, 1000]) {
        const { pts, seg } = resampleClosedIndexed(poly, n);
        expect(pts).toEqual(spec.resampleClosed(poly, n));
        expect(resampleClosed(poly, n)).toEqual(pts);
        pts.forEach((p, i) => {
          const a = poly[seg[i]], b = poly[(seg[i] + 1) % poly.length];
          const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
          expect(Math.abs(cross)).toBeLessThan(1e-12); // p lies on the segment it was assigned to
        });
      }
    }
  });

  it('zero-length segments do not change the samples', () => {
    expect(resampleClosed(polygons[1], 400)).toEqual(resampleClosed([[0, 0], [1, 0], [1, 1], [0, 1]], 400));
  });

  it('coefficients, ordering, chain and partial curve are the reference ones', () => {
    expect(coefficients(samples)).toEqual(spec.coefficients(samples));
    for (const by of ['magnitude', 'frequency'] as const) {
      const ours = orderTerms(all, by), theirs = spec.orderTerms(all, by);
      expect(ours).toEqual(theirs);
      expect(chainAt(ours.c0, ours.terms, 300, 0.37)).toEqual(spec.chainAt(theirs.c0, theirs.terms, 300, 0.37));
      expect(partialCurve(ours.c0, ours.terms, 300, N)).toEqual(spec.partialCurve(ours.c0, ours.terms, 300, N));
      expect(toDesmos(ours.c0, ours.terms, 50)).toBe(spec.toDesmos(ours.c0, ours.terms, 50));
    }
  });

  it('metrics: the same energy and mean deviation, and a more accurate RMS error', () => {
    const { c0, terms } = orderTerms(all);
    let worstOurs = 0, worstSpec = 0;
    for (let M = 1; M < N; M += M < 1000 ? 7 : 1) {
      const approx = partialCurve(c0, terms, M, N);
      const ours = metrics(samples, approx, terms, M), theirs = spec.metrics(samples, approx, terms, M);
      expect(ours.energy).toBe(theirs.energy);
      expect(ours.meanDeviation).toBe(theirs.meanDeviation);
      const direct = directRms(samples, approx);
      worstOurs = Math.max(worstOurs, Math.abs(ours.rmsError - direct));
      worstSpec = Math.max(worstSpec, Math.abs(theirs.rmsError - direct));
    }
    expect(worstOurs).toBeLessThan(1e-14);
    expect(worstOurs).toBeLessThanOrEqual(worstSpec);
  });

  it('chainInto writes chainAt’s joints exactly', () => {
    const { c0, terms } = orderTerms(all);
    const out = new Float64Array(2 * 300 + 2);
    for (const t of [0, 0.123, 0.5, 0.999]) {
      chainInto(c0, terms, 300, t, out);
      expect(Array.from(out)).toEqual(chainAt(c0, terms, 300, t).flat());
    }
  });

  it('energyTable gives metrics’ RMS error for every M', () => {
    const { c0, terms } = orderTerms(all);
    const table = energyTable(terms);
    expect(table.dropped[terms.length]).toBe(0);
    for (const M of [1, 2, 50, 700, N - 1]) {
      expect(Math.sqrt(table.dropped[M])).toBe(metrics(samples, partialCurve(c0, terms, M, N), terms, M).rmsError);
    }
  });

  it('the reference itself still passes: the same samples give the same spectrum', () => {
    expect(spec.coefficients(spec.resampleClosed(randomPolygon(12345), N))).toEqual(all);
  });
});

describe('spec §4.7 invariants', () => {
  it('translation changes only c_0; scaling by s multiplies every c_k by s', () => {
    const moved = coefficients(samples.map(([x, y]) => [x + 3.5, y - 1.25] as Pt));
    const scaled = coefficients(samples.map(([x, y]) => [2.5 * x, 2.5 * y] as Pt));
    all.forEach((c, m) => {
      if (c.k === 0) {
        expect(Math.hypot(moved[m].re - c.re - 3.5, moved[m].im - c.im + 1.25)).toBeLessThan(1e-12);
      } else {
        expect(Math.hypot(moved[m].re - c.re, moved[m].im - c.im)).toBeLessThan(1e-12);
      }
      expect(Math.hypot(scaled[m].re - 2.5 * c.re, scaled[m].im - 2.5 * c.im)).toBeLessThan(1e-12);
    });
  });
});
