// The three random line drawings of spec §5.1. Everything comes from mulberry32, one independent
// stream per feature (ears, legs, tail, ...), so the same seed always gives the same drawing and
// changing how one feature draws its numbers never moves another. Parameters the spec leaves
// open are in DECISIONS.md ("Generator parameters").
import { mulberry32, type Pt } from './fourier.ts';
import { normalizeToUnit, type Stroke } from './path.ts';

export type GeneratorName = 'creature' | 'scribble' | 'star';
export const GENERATORS: readonly GeneratorName[] = ['creature', 'scribble', 'star'];

/** murmur3's 32-bit finalizer: neighbouring seeds and tags end up far apart. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The random stream for one feature of one drawing. */
export function subStream(seed: number, tag: number): () => number {
  return mulberry32(fmix32((seed ^ Math.imul(tag, 0x9e3779b9)) >>> 0));
}

/** A fresh seed for "換一張線稿": a uniform 32-bit unsigned integer. */
export function newSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}

export function generate(name: GeneratorName, seed: number): Stroke {
  const pts = name === 'creature' ? creature(seed) : name === 'scribble' ? scribble(seed) : star(seed);
  return normalizeToUnit([{ pts, closed: true }])[0];
}

const TAU = 2 * Math.PI;
const uniform = (rnd: () => number) => (a: number, b: number) => a + (b - a) * rnd();
/** Signed angle difference, in (-π, π]. */
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** The spec's triangular bump. */
const tri = (u: number) => Math.max(0, 1 - Math.abs(u));
/** The spec's flat-topped bump: 1 for |u| < 0.6, then a cosine down to 0 at |u| = 1. */
const flat = (u: number) => {
  const a = Math.abs(u);
  return a < 0.6 ? 1 : a >= 1 ? 0 : 0.5 * (1 + Math.cos((Math.PI * (a - 0.6)) / 0.4));
};

interface Bump { at: number; halfWidth: number; height: number; shape: (u: number) => number }

/**
 * The little monster: a polar outline r(θ) = 0.55·(1 + 0.08 sin(2θ + a₁) + 0.05 sin(3θ + a₂)) + bumps,
 * with two triangular ears on top, 2 or 4 flat-topped legs below, one thin tail on one side and
 * 0–3 small spikes along the back between the tail and the ear on its side; 720 points, then
 * stretched 1–1.35× along x. The bumps only ever add to r, so the outline never crosses itself.
 */
function creature(seed: number): Pt[] {
  const base = uniform(subStream(seed, 1));
  const a1 = base(0, TAU), a2 = base(0, TAU), stretch = base(1, 1.35);
  const bumps: Bump[] = [];

  const ear = uniform(subStream(seed, 2));
  const earOffset = ear(0.35, 0.6), earHalf = ear(0.16, 0.24), earHeight = ear(0.3, 0.42);
  const earAt = [Math.PI / 2 - earOffset + ear(-0.03, 0.03), Math.PI / 2 + earOffset + ear(-0.03, 0.03)];
  for (const at of earAt) bumps.push({ at, halfWidth: earHalf, height: earHeight * ear(0.92, 1.08), shape: tri });

  const leg = uniform(subStream(seed, 3));
  const legOffsets = leg(0, 1) < 0.5
    ? [leg(0.18, 0.28), leg(0.55, 0.75)].flatMap(o => [-o, o])
    : [leg(0.35, 0.55)].flatMap(o => [-o, o]);
  const legHalf = leg(0.09, 0.13), legHeight = leg(0.16, 0.28);
  for (const o of legOffsets) {
    bumps.push({ at: -Math.PI / 2 + o, halfWidth: legHalf, height: legHeight * leg(0.95, 1.05), shape: flat });
  }

  const tail = uniform(subStream(seed, 4));
  const right = tail(0, 1) < 0.5;
  const tailAt = right ? -tail(0.1, 0.5) : Math.PI + tail(0.1, 0.5);
  const tailHalf = tail(0.05, 0.08);
  bumps.push({ at: tailAt, halfWidth: tailHalf, height: tail(0.45, 0.7), shape: tri });

  // Spikes sit on the arc from the tail up to the ear on the tail's side.
  const spike = uniform(subStream(seed, 5));
  let count = Math.floor(spike(0, 4));
  const spikeHalf = spike(0.06, 0.09);
  const from = right ? tailAt + tailHalf + 0.15 : earAt[1] + earHalf + 0.12;
  const to = right ? earAt[0] - earHalf - 0.12 : tailAt - tailHalf - 0.15;
  while (count > 0 && (to - from) / count < 2.4 * spikeHalf) count--;
  const slot = count > 0 ? (to - from) / count : 0;
  for (let i = 0; i < count; i++) {
    const at = from + (i + 0.5) * slot + spike(-0.25, 0.25) * slot;
    bumps.push({ at, halfWidth: spikeHalf, height: spike(0.08, 0.14) * spike(0.85, 1.15), shape: tri });
  }

  const pts: Pt[] = [];
  for (let i = 0; i < 720; i++) {
    const th = (TAU * i) / 720;
    let r = 0.55 * (1 + 0.08 * Math.sin(2 * th + a1) + 0.05 * Math.sin(3 * th + a2));
    for (const b of bumps) r += b.height * b.shape(wrap(th - b.at) / b.halfWidth);
    pts.push([stretch * r * Math.cos(th), r * Math.sin(th)]);
  }
  return pts;
}

/**
 * The scribble: 6–10 control points roughly around a circle (angle ±0.4 rad, radius 0.35–1), with
 * a small loop (radius 0.1–0.2) at 1–3 of them, joined by a closed centripetal Catmull–Rom
 * spline, 30 points per segment.
 */
function scribble(seed: number): Pt[] {
  const shape = uniform(subStream(seed, 11));
  const n = 6 + Math.floor(shape(0, 5));
  const turn = shape(0, TAU);
  const cps: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = turn + (TAU * i) / n + shape(-0.4, 0.4), r = shape(0.35, 1);
    cps.push([r * Math.cos(a), r * Math.sin(a)]);
  }

  // Which control points get a loop: the first 1–3 of a seeded Fisher–Yates shuffle.
  const loopRnd = subStream(seed, 12), loop = uniform(loopRnd);
  const order = cps.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(loopRnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const loops = new Set(order.slice(0, 1 + Math.floor(loop(0, 3))));

  const ctrl: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p = cps[i];
    ctrl.push(p);
    if (!loops.has(i)) continue;
    // Go once round a circle that touches the path at p, on one side of the direction of travel,
    // then leave slightly ahead of p so the spline crosses itself and reads as a loop.
    const prev = cps[(i - 1 + n) % n], next = cps[(i + 1) % n];
    const len = Math.hypot(next[0] - prev[0], next[1] - prev[1]) || 1;
    const dx = (next[0] - prev[0]) / len, dy = (next[1] - prev[1]) / len;
    const side = loop(0, 1) < 0.5 ? 1 : -1, rho = loop(0.1, 0.2);
    const cx = p[0] - side * rho * dy, cy = p[1] + side * rho * dx;
    const phi0 = Math.atan2(p[1] - cy, p[0] - cx);
    for (let j = 1; j <= 7; j++) {
      const a = phi0 + (side * TAU * j) / 8;
      ctrl.push([cx + rho * Math.cos(a), cy + rho * Math.sin(a)]);
    }
    ctrl.push([p[0] + 0.6 * rho * dx, p[1] + 0.6 * rho * dy]);
  }
  return catmullRomClosed(ctrl, 30);
}

/** A closed centripetal (α = 0.5) Catmull–Rom spline through `ctrl`, `per` points per segment (Barry–Goldman evaluation). */
export function catmullRomClosed(ctrl: Pt[], per: number): Pt[] {
  const m = ctrl.length, out: Pt[] = [];
  const knot = (a: Pt, b: Pt) => Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-9);
  for (let i = 0; i < m; i++) {
    const p0 = ctrl[(i - 1 + m) % m], p1 = ctrl[i], p2 = ctrl[(i + 1) % m], p3 = ctrl[(i + 2) % m];
    const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3);
    for (let s = 0; s < per; s++) {
      const t = t1 + ((t2 - t1) * s) / per;
      const lerp = (a: Pt, b: Pt, ta: number, tb: number): Pt => [
        ((tb - t) * a[0] + (t - ta) * b[0]) / (tb - ta),
        ((tb - t) * a[1] + (t - ta) * b[1]) / (tb - ta),
      ];
      const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3);
      out.push(lerp(b1, b2, t1, t2));
    }
  }
  return out;
}

/**
 * The spiky star: 5–9 points, outer radius 0.75–1, inner radius 0.3–0.6 (and at most 0.75 of the
 * outer), every vertex jittered a little, joined by straight lines. Its corners make the
 * coefficients fall off only like 1/k², which is the point of this drawing.
 */
function star(seed: number): Pt[] {
  const rnd = uniform(subStream(seed, 21));
  const n = 5 + Math.floor(rnd(0, 5));
  const outer = rnd(0.75, 1), inner = rnd(0.3, Math.min(0.6, 0.75 * outer));
  const turn = rnd(-0.3, 0.3) * (Math.PI / n);
  const pts: Pt[] = [];
  for (let i = 0; i < 2 * n; i++) {
    const a = Math.PI / 2 + turn + (Math.PI * i) / n + rnd(-0.15, 0.15) * (Math.PI / n);
    const r = (i % 2 === 0 ? outer : inner) * rnd(0.92, 1.08);
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}
