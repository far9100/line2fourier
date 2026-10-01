// The Fourier core: spec §11, taken over as written. The changes, all covered by the M0 tests:
// - the doc comments are in English;
// - resampleClosed's loop lives in resampleClosedIndexed, which also reports the segment each
//   sample falls on (path.ts needs it for pen-up); resampleClosed returns the same points;
// - metrics() sums the dropped energy directly instead of total - used (DECISIONS.md);
// - chainInto() and energyTable() are allocation-free / O(1)-per-M helpers for the page.

export type Pt = [number, number];
export interface Term { k: number; re: number; im: number; amp: number; phase: number; }
export type Order = 'magnitude' | 'frequency';

export interface Metrics {
  /** Σ_used |c_k|² / Σ_{k≠0} |c_k|² (Parseval). */
  energy: number;
  /** sqrt(Σ_dropped |c_k|²): the RMS distance between the samples and the approximation. */
  rmsError: number;
  /** (1/N) Σ_n |z_n − z_M(n)|. */
  meanDeviation: number;
}

/** resampleClosed, plus seg[n]: the index of the polyline segment sample n lies on (segment i runs from poly[i] to poly[i + 1], the last one back to poly[0]). */
export function resampleClosedIndexed(poly: Pt[], N: number): { pts: Pt[]; seg: Int32Array } {
  const P = poly.concat([poly[0]]);
  const seg: number[] = [];
  let L = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const d = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
    seg.push(d);
    L += d;
  }
  if (L === 0) throw new Error('path has zero length');
  const out: Pt[] = [];
  const index = new Int32Array(N);
  let j = 0, acc = 0;
  for (let n = 0; n < N; n++) {
    const s = (n * L) / N;
    while (j < seg.length - 1 && acc + seg[j] < s) { acc += seg[j]; j++; }
    const u = seg[j] > 0 ? (s - acc) / seg[j] : 0;
    out.push([P[j][0] + u * (P[j + 1][0] - P[j][0]), P[j][1] + u * (P[j + 1][1] - P[j][1])]);
    index[n] = j;
  }
  return { pts: out, seg: index };
}

/** Take N points at equal arc length along a closed polyline (the segment from the last point back to the first is added). */
export function resampleClosed(poly: Pt[], N: number): Pt[] {
  return resampleClosedIndexed(poly, N).pts;
}

/** In-place radix-2 FFT. inverse=false: X_m = Σ z_n e^{-2πimn/N}; inverse=true: Σ X_m e^{+2πimn/N} (not divided by N). */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error('length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + half;
        const br = re[b] * wr - im[b] * wi;
        const bi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - br; im[b] = im[a] - bi;
        re[a] += br; im[a] += bi;
      }
    }
  }
}

/** c_k = (1/N) Σ z_n e^{-2πikn/N}, k ∈ [-N/2, N/2). */
export function coefficients(samples: Pt[]): Term[] {
  const N = samples.length;
  const re = new Float64Array(N), im = new Float64Array(N);
  samples.forEach(([x, y], n) => { re[n] = x; im[n] = y; });
  fft(re, im);
  const out: Term[] = [];
  for (let m = 0; m < N; m++) {
    const k = m < N / 2 ? m : m - N;
    const cr = re[m] / N, ci = im[m] / N;
    out.push({ k, re: cr, im: ci, amp: Math.hypot(cr, ci), phase: Math.atan2(ci, cr) });
  }
  return out;
}

/** magnitude: |c_k| largest first (L²-optimal); frequency: |k| smallest first, positive before negative for equal |k|. */
export function orderTerms(all: Term[], by: Order = 'magnitude'): { c0: Term; terms: Term[] } {
  const c0 = all.find(c => c.k === 0)!;
  const terms = all.filter(c => c.k !== 0);
  if (by === 'magnitude') terms.sort((a, b) => b.amp - a.amp);
  else terms.sort((a, b) => Math.abs(a.k) - Math.abs(b.k) || b.k - a.k);
  return { c0, terms };
}

/** The epicycle chain at t ∈ [0, 1): every circle's centre, then the pen tip. O(M) per call. */
export function chainAt(c0: Term, terms: Term[], M: number, t: number): Pt[] {
  let x = c0.re, y = c0.im;
  const joints: Pt[] = [[x, y]];
  for (let j = 0; j < M; j++) {
    const c = terms[j], a = 2 * Math.PI * c.k * t + c.phase;
    x += c.amp * Math.cos(a);
    y += c.amp * Math.sin(a);
    joints.push([x, y]);
  }
  return joints;
}

/**
 * chainAt without allocating: writes the M + 1 joints as x0, y0, x1, y1, … into `out`
 * (length ≥ 2M + 2), with the same operations in the same order, so the numbers are identical.
 */
export function chainInto(c0: Term, terms: Term[], M: number, t: number, out: Float64Array): void {
  let x = c0.re, y = c0.im;
  out[0] = x; out[1] = y;
  for (let j = 0; j < M; j++) {
    const c = terms[j], a = 2 * Math.PI * c.k * t + c.phase;
    x += c.amp * Math.cos(a);
    y += c.amp * Math.sin(a);
    out[2 * j + 2] = x; out[2 * j + 3] = y;
  }
}

export interface EnergyTable {
  /** Σ |c_k|² over all terms (c_0 excluded). */
  total: number;
  /** dropped[M] = Σ_{j ≥ M} |c_{k_j}|², summed from the far end; dropped[terms.length] = 0. */
  dropped: Float64Array;
}

/** Suffix sums of the ordered terms' energy: the RMS error for any M is sqrt(dropped[M]), in O(1). */
export function energyTable(terms: Term[]): EnergyTable {
  const dropped = new Float64Array(terms.length + 1);
  for (let j = terms.length - 1; j >= 0; j--) dropped[j] = dropped[j + 1] + terms[j].amp * terms[j].amp;
  let total = 0;
  for (const c of terms) total += c.amp * c.amp;
  return { total, dropped };
}

/** Keep c_0 and the first M terms and inverse-FFT them: the approximation at the N sample times. O(N log N). */
export function partialCurve(c0: Term, terms: Term[], M: number, N: number): Pt[] {
  const re = new Float64Array(N), im = new Float64Array(N);
  const put = (c: Term) => { const m = (c.k + N) % N; re[m] = c.re; im[m] = c.im; };
  put(c0);
  for (let j = 0; j < M; j++) put(terms[j]);
  fft(re, im, true);
  return Array.from({ length: N }, (_, n) => [re[n], im[n]] as Pt);
}

/** Energy ratio (Parseval), RMS error (= root of the dropped terms' energy) and mean deviation. */
export function metrics(samples: Pt[], approx: Pt[], terms: Term[], M: number): Metrics {
  let total = 0, used = 0;
  terms.forEach((c, j) => { const e = c.amp * c.amp; total += e; if (j < M) used += e; });
  // The dropped energy gets its own sum, from the far end of the list: total - used would lose
  // everything below about 1e-16 * total to cancellation.
  let dropped = 0;
  for (let j = terms.length - 1; j >= M; j--) dropped += terms[j].amp * terms[j].amp;
  let mean = 0;
  for (let n = 0; n < samples.length; n++) {
    mean += Math.hypot(samples[n][0] - approx[n][0], samples[n][1] - approx[n][1]);
  }
  return {
    energy: total > 0 ? used / total : 1,
    rmsError: Math.sqrt(dropped),
    meanDeviation: mean / samples.length,
  };
}

/** Text to paste into Desmos as a whole: the lists R, K, P and one parametric curve (t runs from 0 to 1 by default). */
export function toDesmos(c0: Term, terms: Term[], M: number, digits = 5): string {
  const f = (v: number) => (Math.abs(v) < 10 ** -digits ? '0' : v.toFixed(digits));
  const use = terms.slice(0, M);
  return [
    `R=[${use.map(c => f(c.amp)).join(',')}]`,
    `K=[${use.map(c => c.k).join(',')}]`,
    `P=[${use.map(c => f(c.phase)).join(',')}]`,
    `(${f(c0.re)}+\\operatorname{total}(R\\cos(2\\pi Kt+P)),${f(c0.im)}+\\operatorname{total}(R\\sin(2\\pi Kt+P)))`,
  ].join('\n');
}

/** A seedable random number generator returning numbers in [0, 1). */
export function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
