// DECISIONS.md D46: strokes are joined where they are nearest, and the pen gets about by walking
// back along the drawing rather than by jumping.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRIDGE_SHARE, bridgeEnds } from '../../src/core/bridge.ts';
import { mulberry32, type Pt } from '../../src/core/fourier.ts';
import { curvesToStrokes, parseCurvesJson } from '../../src/core/line2funcImport.ts';
import { AGAIN, FILL, INK, JUMP, buildPath, kindSpans, normalizeToUnit, prepareStrokes, type Stroke } from '../../src/core/path.ts';
import { JUMP_FACTOR, NODE_STEP, SPARE_FACTOR, connect, layNodes, routeStrokes, walkStats } from '../../src/core/route.ts';

const open = (...pts: Pt[]): Stroke => ({ pts, closed: false });
const ring = (cx: number, cy: number, r: number, n = 24): Stroke => ({
  closed: true,
  pts: Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)] as Pt),
});
const d = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);
const segmentsOf = (s: Stroke): [Pt, Pt][] => {
  const p = s.closed ? [...s.pts, s.pts[0]] : s.pts;
  return p.slice(1).map((q, i) => [p[i], q]);
};
const inkOf = (strokes: Stroke[]) => strokes.flatMap(segmentsOf).reduce((sum, [a, b]) => sum + d(a, b), 0);
/** Is p on the segment from a to b (within tol)? */
function on(p: Pt, a: Pt, b: Pt, tol = 1e-9): boolean {
  const len = d(a, b);
  if (len === 0) return d(p, a) <= tol;
  const t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (len * len);
  if (t < -tol || t > 1 + tol) return false;
  return Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / len <= tol;
}
const along = ([a, b]: [Pt, Pt], t: number): Pt => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
const passes = (pieces: Stroke[], p: Pt) => pieces.flatMap(segmentsOf).filter(([a, b]) => on(p, a, b)).length;

function randomStrokes(seed: number, n: number): Stroke[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => {
    const x = rnd() * 10, y = rnd() * 10, closed = rnd() < 0.3, k = 3 + Math.floor(rnd() * 5);
    const pts: Pt[] = Array.from({ length: k }, (_, i) => closed
      ? [x + 0.5 * Math.cos((2 * Math.PI * i) / k), y + 0.5 * Math.sin((2 * Math.PI * i) / k)]
      : [x + i * rnd(), y + i * rnd()]);
    return { pts, closed };
  });
}

/** Everything a walk has to be, whatever the drawing. */
function check(input: Stroke[], reach: number, maxWork?: number) {
  const before = JSON.stringify(input);
  const r = routeStrokes(input, reach, maxWork === undefined ? {} : { maxWork });
  expect(JSON.stringify(input), 'the strokes given are left as they were').toBe(before);
  expect(routeStrokes(input, reach, maxWork === undefined ? {} : { maxWork }), 'the same again').toEqual(r);
  expect(r.jumpLength).toBeLessThanOrEqual(r.originalJumpLength);
  expect(r.originalJumpLength).toBe(walkStats(input).jumpLength);
  if (r.from === 'original') {
    expect(r.strokes).toBe(input);
    return r;
  }

  // What is reported is what the path built from the pieces has.
  const path = buildPath(prepareStrokes(r.strokes));
  expect(prepareStrokes(r.strokes)).toEqual(r.strokes); // nothing left to clean
  expect(r.jumpLength).toBe(path.lengths[JUMP]);
  expect(r.lifts).toBe(kindSpans(path, JUMP).length);
  expect(r.againLength).toBe(path.lengths[AGAIN]);
  for (const p of r.strokes) expect(p.closed).toBe(false);

  // Every line is drawn once: the first passes are the drawing plus the links, and nothing is walked a third time.
  const ink = inkOf(input), firsts = r.strokes.filter(p => !p.again), agains = r.strokes.filter(p => p.again);
  expect(inkOf(firsts)).toBeCloseTo(ink + r.linkLength, 9);
  for (const seg of input.flatMap(segmentsOf)) {
    if (d(seg[0], seg[1]) === 0) continue;
    for (const t of [0.137, Math.SQRT2 - 1, 0.863]) { // never where a node is: nodes sit at whole fractions of a segment
      const p = along(seg, t);
      expect(passes(firsts, p), `drawn once at ${p}`).toBe(1);
      expect(passes(agains, p), `walked again at most once at ${p}`).toBeLessThanOrEqual(1);
    }
  }
  // What the first passes add to the drawing are the links: straight, and no longer than the reach.
  const added = firsts.flatMap(segmentsOf).filter(seg => passes(input, along(seg, 0.5)) === 0);
  expect(added).toHaveLength(r.links);
  expect(added.reduce((sum, [a, b]) => sum + d(a, b), 0)).toBeCloseTo(r.linkLength, 9);
  for (const [a, b] of added) expect(d(a, b)).toBeLessThanOrEqual(reach * (1 + 1e-12));
  // A stretch walked again lies on the drawing or on a link.
  for (const seg of agains.flatMap(segmentsOf)) expect(passes(firsts, along(seg, 0.5))).toBeGreaterThanOrEqual(1);
  return r;
}

describe('nodes along the strokes', () => {
  it('keep every vertex, add points so that none are far apart, and do not repeat a closed stroke’s first', () => {
    const strokes = [open([0, 0], [1, 0], [1, 0.25]), ring(5, 5, 1, 4)];
    const nodes = layNodes(strokes, 0.3);
    expect(Array.from(nodes.first)).toEqual([0, 6, 6 + 4 * 5]); // 4 + 1 + the end; four sides of √2 in five steps each
    expect([nodes.X[0], nodes.Y[0]]).toEqual([0, 0]);
    expect([nodes.X[4], nodes.Y[4]]).toEqual([1, 0]);
    expect([nodes.X[5], nodes.Y[5]]).toEqual([1, 0.25]);
    expect(Array.from(nodes.corner.slice(0, 6))).toEqual([1, 0, 0, 0, 1, 1]);
    expect(Array.from(nodes.S.slice(4, 8))).toEqual([0, 0, 1, 1]);
    for (let s = 0; s < 2; s++) {
      for (let i = nodes.first[s] + 1; i < nodes.first[s + 1]; i++) {
        expect(Math.hypot(nodes.X[i] - nodes.X[i - 1], nodes.Y[i] - nodes.Y[i - 1])).toBeLessThanOrEqual(0.3 + 1e-12);
      }
    }
  });
});

describe('where the pen may cross between strokes', () => {
  /** Kruskal over the nearest nodes of every two strokes, each pair looked at: the weight of the spanning tree. */
  function bruteTree(strokes: Stroke[], step: number): number {
    const { X, Y, S } = layNodes(strokes, step), n = strokes.length;
    const nearest = new Float64Array(n * n).fill(Infinity);
    for (let a = 0; a < X.length; a++) {
      for (let b = a + 1; b < X.length; b++) {
        if (S[a] === S[b]) continue;
        const dist = Math.sqrt((X[a] - X[b]) ** 2 + (Y[a] - Y[b]) ** 2);
        if (dist < nearest[S[a] * n + S[b]]) nearest[S[a] * n + S[b]] = dist;
      }
    }
    const pairs: [number, number, number][] = [];
    for (let s = 0; s < n; s++) for (let t = s + 1; t < n; t++) pairs.push([nearest[s * n + t], s, t]);
    pairs.sort((p, q) => p[0] - q[0]);
    const part = Array.from({ length: n }, (_, i) => i);
    const find = (a: number): number => (part[a] === a ? a : (part[a] = find(part[a])));
    let weight = 0;
    for (const [dist, s, t] of pairs) {
      if (find(s) === find(t)) continue;
      part[find(s)] = find(t);
      weight += dist;
    }
    return weight;
  }

  it('the spanning tree is the shortest there is, near strokes and far ones alike', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const strokes = prepareStrokes(randomStrokes(seed, 2 + (seed % 14)));
      for (const reach of [0.05, 0.4, 3]) {
        const nodes = layNodes(strokes, NODE_STEP * reach);
        const tree = connect(strokes, nodes, reach).filter(c => c.tree);
        expect(tree).toHaveLength(strokes.length - 1);
        expect(tree.reduce((sum, c) => sum + c.d, 0)).toBeCloseTo(bruteTree(strokes, NODE_STEP * reach), 9);
        // and it does join everything
        const part = strokes.map((_, i) => i);
        const find = (a: number): number => (part[a] === a ? a : (part[a] = find(part[a])));
        for (const c of tree) part[find(nodes.S[c.a])] = find(nodes.S[c.b]);
        expect(new Set(strokes.map((_, i) => find(i))).size).toBe(1);
      }
    }
  });

  it('connectors join different strokes, the lower node first, and the spare ones are within reach', () => {
    const strokes = prepareStrokes(randomStrokes(3, 12));
    const reach = 0.4, nodes = layNodes(strokes, NODE_STEP * reach);
    const all = connect(strokes, nodes, reach);
    for (const c of all) {
      expect(c.a).toBeLessThan(c.b);
      expect(nodes.S[c.a]).not.toBe(nodes.S[c.b]);
      expect(c.d).toBe(Math.sqrt((nodes.X[c.a] - nodes.X[c.b]) ** 2 + (nodes.Y[c.a] - nodes.Y[c.b]) ** 2));
      if (!c.tree) expect(c.d).toBeLessThanOrEqual(reach);
    }
    expect(all.map(c => [c.a, c.b])).toEqual([...all].sort((p, q) => p.a - q.a || p.b - q.b).map(c => [c.a, c.b]));
  });

  it('out of budget, the tree is still a tree: perhaps longer, never broken', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const strokes = prepareStrokes(randomStrokes(seed, 3 + (seed % 12)));
      const nodes = layNodes(strokes, NODE_STEP * 0.05);
      const tree = connect(strokes, nodes, 0.05, { work: 1, max: 0 }).filter(c => c.tree);
      expect(tree).toHaveLength(strokes.length - 1);
      expect(tree.reduce((sum, c) => sum + c.d, 0)).toBeGreaterThanOrEqual(bruteTree(strokes, NODE_STEP * 0.05) - 1e-9);
    }
  });
});

describe('one walk over the drawing', () => {
  it('a T with a small gap: one link, no pen lift, every line drawn once and walked back once', () => {
    const r = check([open([0, 10], [10, 10]), open([5, 9.97], [5, 0])], 0.05);
    expect(r.from).toBe('routed');
    expect(r.links).toBe(1);
    expect(r.linkLength).toBeCloseTo(0.03, 12);
    expect(r.lifts).toBe(0);
    expect(r.jumpLength).toBe(0);
    expect(r.originalJumpLength).toBeCloseTo(Math.hypot(5, 0.03) + Math.hypot(5, 10), 12); // bar's end to the stem's, and back to the start
    expect(r.againLength).toBeCloseTo(20, 9); // a closed walk over a tree goes along everything twice: 19.97 of line and the link
    const path = buildPath(r.strokes);
    expect(path.total).toBeCloseTo(40, 9);
    expect(Array.from(new Set(path.kinds)).sort()).toEqual([INK, AGAIN]);
  });

  it('two rings that nearly touch: each walked round once, the link between them there and back', () => {
    const r = check([ring(0, 0, 1), ring(2.03, 0, 1)], 0.05);
    expect(r.links).toBe(1);
    expect(r.linkLength).toBeCloseTo(0.03, 12);
    expect(r.lifts).toBe(0);
    expect(r.againLength).toBeCloseTo(0.03, 12);
  });

  it('strokes far apart: no link, pen-up moves between nearest points, never more than in the order given', () => {
    const strokes = [open([0, 0], [10, 0]), open([0, 3], [10, 3]), ring(20, 1.5, 1)];
    const r = check(strokes, 0.05);
    expect(r.from).toBe('routed');
    expect(r.links).toBe(0);
    expect(r.lifts).toBeGreaterThan(0);
    expect(r.jumpLength).toBeLessThan(r.originalJumpLength);
    // The lines are 3 apart and the ring 9 from them: no tour of their ends is as short as crossing at nearest points.
    expect(r.jumpLength).toBeLessThanOrEqual(2 * (3 + 9) + 1e-9);
  });

  it(`walks back rather than jump while that is less than ${JUMP_FACTOR} times as far`, () => {
    // One open line: walked back along itself, unless its two ends are close enough to jump.
    const hook = (gap: number) => open([0, 0], [10, 0], [10, 1], [gap, 1]);
    const far = check([hook(8)], 0.05); // 19 to walk back, 5 × 8.06 to jump
    expect(far.strokes).toHaveLength(2);
    expect(far.strokes[1]).toEqual({ pts: [[8, 1], [10, 1], [10, 0], [0, 0]], closed: false, again: true });
    expect(far.againLength).toBeCloseTo(13, 12);
    expect(buildPath(far.strokes).lengths[JUMP]).toBe(0);
    const near = check([hook(1)], 0.05); // 20 to walk back, 5 × 1.41 to jump: left as it is, to be closed as a single line is
    expect(near.strokes).toEqual([hook(1)]);
    expect(near.againLength).toBe(0);
  });

  it(`a near contact the tree does not need is crossed only when that saves ${SPARE_FACTOR} times its length`, () => {
    // A square of four lines whose corners all but meet: three corners join it up, the fourth closes it.
    const gap = 0.02, square = (side: number) => [
      open([gap, 0], [side - gap, 0]), open([side, gap], [side, side - gap]),
      open([side - gap, side], [gap, side]), open([0, side - gap], [0, gap]),
    ];
    const big = check(square(10), 0.05);
    expect(big.links).toBe(4); // going round costs four links; without the fourth, three sides would be walked back
    expect(big.againLength).toBe(0);
    expect(big.lifts).toBe(0);
  });

  it('painted strokes keep their pen on the first pass only', () => {
    const paint: Stroke = { ...ring(0, 0, 1), fill: 0.3 };
    const r = check([paint, open([1.03, 0], [4, 0])], 0.05);
    expect(r.links).toBe(1);
    const painted = r.strokes.filter(p => p.fill);
    expect(inkOf(painted)).toBeCloseTo(inkOf([paint]), 9);
    for (const p of r.strokes) if (p.again) expect(p.fill).toBeUndefined();
    const path = buildPath(r.strokes);
    expect(path.fillWidth).toBe(0.3);
    expect(path.lengths[FILL]).toBeCloseTo(inkOf([paint]), 9);
  });

  it('is left alone without a reach, and a single closed line is its own walk', () => {
    const strokes = [open([0, 0], [1, 0]), open([1.01, 0], [2, 1])];
    expect(routeStrokes(strokes, 0)).toMatchObject({ strokes, from: 'original', links: 0 });
    const one = [ring(0, 0, 1)];
    expect(routeStrokes(one, 0.05)).toMatchObject({ strokes: one, from: 'original', jumpLength: 0, lifts: 0 });
  });

  it('whatever the drawing: every line once, links within reach, never more pen-up than in the order given', () => {
    const seen = { routed: 0, original: 0, links: 0, lifts: 0 };
    for (let seed = 1; seed <= 200; seed++) {
      const strokes = prepareStrokes(randomStrokes(seed, 1 + (seed % 13)));
      const r = check(strokes, 0.2);
      seen[r.from]++;
      seen.links += r.links;
      seen.lifts += r.lifts;
    }
    expect(seen.routed).toBeGreaterThan(190);
    expect(seen.links).toBeGreaterThan(100);
    expect(seen.lifts).toBeGreaterThan(100);
  });

  it('out of budget it jumps where it would have walked back: still every line once, and the order given when that has less pen-up', () => {
    const seen = { routed: 0, original: 0 };
    for (let seed = 1; seed <= 60; seed++) seen[check(prepareStrokes(randomStrokes(seed, 2 + (seed % 12))), 0.2, 0).from]++;
    expect(seen.routed).toBeGreaterThan(50);
    expect(seen.original).toBeGreaterThan(0); // seeds 13 and 51: jumping everywhere is worse than the strokes as they came
  });

  it('is the same walk on every machine', () => {
    // The fingerprint of one walk. If this changes, opened drawings change: raise the project file's engine version.
    const r = routeStrokes(prepareStrokes(randomStrokes(42, 12)), 0.2);
    const text = JSON.stringify(r.strokes.map(s => [s.again ? 1 : 0, s.pts.map(([x, y]) => [x.toFixed(9), y.toFixed(9)])]));
    expect(createHash('sha256').update(text).digest('hex')).toBe('76db41cce617238a0f0489279c1a351db3a0d5e4d0ab5b734a99c69e4a52f7df');
  });

  const real = new URL('../../../line2func/out/curves.json', import.meta.url);
  it.skipIf(!existsSync(real))('line2func’s own output (local benchmark): a tenth of the pen-up, a fifth of the lifts', { timeout: 60_000 }, () => {
    const read = parseCurvesJson(readFileSync(real, 'utf8'));
    if ('error' in read) throw new Error(read.error);
    const reach = BRIDGE_SHARE * 2;
    const strokes = prepareStrokes(bridgeEnds(normalizeToUnit(prepareStrokes(curvesToStrokes(read.doc).strokes)), reach).strokes);
    const started = performance.now();
    const r = routeStrokes(strokes, reach);
    const ms = performance.now() - started;
    const path = buildPath(prepareStrokes(r.strokes)), ink = inkOf(strokes);
    console.log(`line2func out/curves.json: ${strokes.length} strokes → ${r.strokes.length} pieces in ${ms.toFixed(0)} ms; `
      + `pen-up ${(100 * r.jumpLength / path.total).toFixed(1)}% of the path in ${r.lifts} lifts; ${r.links} links, ${(100 * r.linkLength / ink).toFixed(1)}% of the ink; `
      + `walked again ${(100 * r.againLength / ink).toFixed(0)}%; path ${(path.total / ink).toFixed(2)} × the ink`);
    expect(r.from).toBe('routed');
    expect(r.lifts).toBeLessThan(strokes.length / 5);
    expect(r.jumpLength / path.total).toBeLessThan(0.025);
    expect(r.linkLength / ink).toBeLessThan(0.04);
    expect(path.total / ink).toBeLessThan(1.4);
  });
});
