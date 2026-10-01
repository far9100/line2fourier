import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fillSpacing } from '../../src/core/fill.ts';
import { mulberry32, type Pt } from '../../src/core/fourier.ts';
import { curvesToStrokes, parseCurvesJson, type CurvesJson } from '../../src/core/line2funcImport.ts';
import { JUMP, buildPath, normalizeToUnit, prepareStrokes, type Stroke } from '../../src/core/path.ts';
import { douglasPeucker, simplifyDrawing } from '../../src/core/simplify.ts';
import { applyTour, jumpLengthOf, optimizeTour, originalOrder } from '../../src/core/tour.ts';
import { handle, pack, unpack } from '../../src/worker/protocol.ts';

const curves = (overrides: Partial<CurvesJson> = {}): CurvesJson => ({
  format: 'line2func.curves',
  version: 1,
  image: { width: 100, height: 50 },
  coordinates: 'image-pixels-y-down',
  curves: [
    { stroke: 0, ctrl: [[0, 0], [10, 0], [20, 0], [30, 0]] },
    { stroke: 0, ctrl: [[30, 0], [30, 10], [30, 20], [30, 30]] },
    { stroke: 1, ctrl: [[50, 10], [60, 0], [70, 20], [50, 10]] },
    { stroke: 2, ctrl: [[80, 40], [85, 40], [90, 40], [95, 40]], tags: ['fill'] },
  ],
  ...overrides,
});

describe('line2func curves.json (spec §5.4)', () => {
  it('checks format, version and coordinates as line2func does', () => {
    expect(parseCurvesJson('{')).toEqual({ error: 'json' });
    expect(parseCurvesJson(JSON.stringify({ ...curves(), format: 'x' }))).toEqual({ error: 'format' });
    expect(parseCurvesJson(JSON.stringify({ ...curves(), version: 2 }))).toEqual({ error: 'version' });
    expect(parseCurvesJson(JSON.stringify({ ...curves(), coordinates: 'math' }))).toEqual({ error: 'coordinates' });
    expect(parseCurvesJson(JSON.stringify({ ...curves(), curves: [{ ctrl: [[0, 0]] }] }))).toEqual({ error: 'curves' });
    expect('doc' in parseCurvesJson(JSON.stringify(curves()))).toBe(true);
  });

  it('joins the curves of a stroke, flips y, finds closed strokes and leaves fill hatching out', () => {
    const { strokes, skippedFill, filled } = curvesToStrokes(curves());
    expect(skippedFill).toBe(1);
    expect(filled).toBe(0); // no area outline in this file: nothing painted
    expect(strokes).toHaveLength(2);
    expect(strokes[0].closed).toBe(false);
    expect(strokes[0].pts[0]).toEqual([0, 50]); // y = 0 at the top of a 50 px image
    expect(strokes[0].pts[strokes[0].pts.length - 1]).toEqual([30, 20]);
    expect(strokes[1].closed).toBe(true);
    expect(curvesToStrokes(curves(), { includeFill: true }).strokes).toHaveLength(3);
  });

  it('the filled areas (closed fill_outline strokes) are painted in, holes left bare (D42)', () => {
    const square = (x0: number, y0: number, x1: number, y1: number, stroke: number) => [
      { stroke, ctrl: [[x0, y0], [x0, y0], [x1, y0], [x1, y0]] as [Pt, Pt, Pt, Pt], tags: ['fill_outline'] },
      { stroke, ctrl: [[x1, y0], [x1, y0], [x1, y1], [x1, y1]] as [Pt, Pt, Pt, Pt], tags: ['fill_outline'] },
      { stroke, ctrl: [[x1, y1], [x1, y1], [x0, y1], [x0, y1]] as [Pt, Pt, Pt, Pt], tags: ['fill_outline'] },
      { stroke, ctrl: [[x0, y1], [x0, y1], [x0, y0], [x0, y0]] as [Pt, Pt, Pt, Pt], tags: ['fill_outline'] },
    ];
    const doc = curves({
      image: { width: 200, height: 100 },
      curves: [...square(20, 20, 80, 80, 0), ...square(40, 40, 60, 60, 1), { stroke: 2, ctrl: [[30, 30], [35, 35], [40, 40], [45, 45]], tags: ['fill'] }],
    });
    const { strokes, skippedFill, filled } = curvesToStrokes(doc);
    expect(skippedFill).toBe(1);
    expect(filled).toBe(1);
    const paint = strokes.filter(s => s.fill);
    expect(strokes.filter(s => !s.fill)).toHaveLength(2); // the two outlines stay lines
    expect(paint.length).toBeGreaterThanOrEqual(1);
    expect(paint[0].fill).toBeCloseTo(3 * fillSpacing(60 * 60 - 20 * 20, 200), 12); // the pen is three ring spacings wide
    for (const s of paint) {
      for (const [x, yUp] of s.pts) {
        const y = 100 - yUp;
        expect(x > 20 && x < 80 && y > 20 && y < 80).toBe(true); // inside the outer square
        expect(x > 40 && x < 60 && y > 40 && y < 60).toBe(false); // and not in the hole
      }
    }
    expect(curvesToStrokes(doc, { includeFill: true })).toMatchObject({ filled: 0, skippedFill: 0 });
  });

  it('a stroke id that continues somewhere else starts a new stroke', () => {
    const doc = curves({ curves: [
      { stroke: 0, ctrl: [[0, 0], [1, 0], [2, 0], [3, 0]] },
      { stroke: 0, ctrl: [[10, 10], [11, 10], [12, 10], [13, 10]] },
    ] });
    expect(curvesToStrokes(doc).strokes).toHaveLength(2);
  });
});

describe('simplifying (spec §13)', () => {
  it('Douglas–Peucker keeps corners and drops what is within tolerance', () => {
    const line: Pt[] = [[0, 0], [1, 0.001], [2, 0], [3, 1], [4, 2]];
    expect(douglasPeucker(line, 0.01)).toEqual([[0, 0], [2, 0], [4, 2]]);
    // Even at zero tolerance a point exactly on the line is dropped.
    expect(douglasPeucker(line, 0)).toEqual([[0, 0], [1, 0.001], [2, 0], [4, 2]]);
  });

  it('keeps the longest strokes and thins points until under the limits', () => {
    const rnd = mulberry32(3);
    const strokes: Stroke[] = Array.from({ length: 30 }, (_, i) => ({
      closed: false,
      pts: Array.from({ length: 40 }, (_, k) => [k * (i + 1) * 0.01, 0.001 * Math.sin(k) + rnd() * 1e-6] as Pt),
    }));
    const out = simplifyDrawing(strokes, 12, { maxStrokes: 10, maxPoints: 100 });
    expect(out.droppedStrokes).toBe(20);
    expect(out.strokes).toHaveLength(10);
    expect(out.strokes.reduce((n, s) => n + s.pts.length, 0)).toBeLessThanOrEqual(100);
    expect(out.epsilon).toBeGreaterThan(0);
    // The longest (the last ones) are kept, in their original order.
    const first = out.strokes[0].pts;
    expect(first[first.length - 1][0]).toBeCloseTo(39 * 21 * 0.01, 9);
  });
});

function randomStrokes(seed: number, n: number): Stroke[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => {
    const x = rnd() * 10, y = rnd() * 10, closed = rnd() < 0.3;
    const k = 3 + Math.floor(rnd() * 5);
    const pts: Pt[] = Array.from({ length: k }, (_, i) => closed
      ? [x + 0.5 * Math.cos((2 * Math.PI * i) / k), y + 0.5 * Math.sin((2 * Math.PI * i) / k)]
      : [x + i * rnd(), y + i * rnd()]);
    return { pts, closed };
  });
}

describe('ordering strokes (spec §4.6, M2 acceptance)', () => {
  it('never makes the jumps longer than the original order, and is the same every time', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const strokes = randomStrokes(seed, 2 + (seed % 25));
      const tour = optimizeTour(strokes);
      const original = jumpLengthOf(strokes, originalOrder(strokes));
      expect(tour.originalJumpLength).toBe(original);
      expect(tour.jumpLength).toBeLessThanOrEqual(original);
      expect(tour.jumpLength).toBe(jumpLengthOf(strokes, tour.steps));
      expect(optimizeTour(strokes)).toEqual(tour);
      expect(new Set(tour.steps.map(s => s.index)).size).toBe(strokes.length);
    }
  });

  it('usually does much better, and leaves an already optimal order alone', () => {
    const strokes = randomStrokes(7, 60);
    const tour = optimizeTour(strokes);
    expect(tour.jumpLength).toBeLessThan(0.5 * tour.originalJumpLength);
    // Collinear segments end to start: the original order is optimal and is kept.
    const row: Stroke[] = Array.from({ length: 6 }, (_, i) => ({ closed: false, pts: [[2 * i, 0], [2 * i + 1, 0]] }));
    const kept = optimizeTour(row);
    expect(kept.jumpLength).toBe(kept.originalJumpLength);
  });

  it('closed strokes are entered at the vertex nearest the way in and out', () => {
    const ring = (cx: number, n = 12): Stroke => ({ closed: true, pts: Array.from({ length: n }, (_, i) => [cx + Math.cos((2 * Math.PI * i) / n), Math.sin((2 * Math.PI * i) / n)] as Pt) });
    const strokes = [ring(0), ring(5), ring(10)];
    const tour = optimizeTour(strokes);
    // Entered at vertex 0 the rings cost 5 + 5 + 10; entered at the vertices facing each other the
    // jumps go 1 → 4..6 → 9 and back to 1: twice 8, which is the least possible.
    expect(tour.originalJumpLength).toBeCloseTo(20, 9);
    expect(tour.jumpLength).toBeCloseTo(16, 9);
  });

  it('the walked strokes give the same jump length as the tour', () => {
    const strokes = normalizeToUnit(prepareStrokes(randomStrokes(11, 30)));
    const tour = optimizeTour(strokes);
    const path = buildPath(prepareStrokes(applyTour(strokes, tour.steps)));
    expect(path.lengths[JUMP]).toBeCloseTo(tour.jumpLength, 9);
  });

  it('the worker’s handler packs, orders and answers', () => {
    const strokes = randomStrokes(5, 12);
    expect(unpack(pack(strokes))).toEqual(strokes);
    const painted = [...strokes, { pts: [[0, 0], [1, 0], [1, 1]] as Pt[], closed: true, fill: 0.125 }];
    expect(unpack(pack(painted))).toEqual(painted);
    expect(applyTour(painted, optimizeTour(painted).steps).filter(s => s.fill)).toHaveLength(1);
    const res = handle({ id: 7, type: 'tour', strokes: pack(strokes) });
    expect(res).toMatchObject({ id: 7, ok: true });
    if (res.ok && 'tour' in res) expect(res.tour).toEqual(optimizeTour(strokes));
    else throw new Error('expected a tour');
  });

  const real = new URL('../../../line2func/out/curves.json', import.meta.url);
  it.skipIf(!existsSync(real))('line2func’s own output (local benchmark): pen-up under a quarter of the path', () => {
    const read = parseCurvesJson(readFileSync(real, 'utf8'));
    if ('error' in read) throw new Error(read.error);
    const strokes = normalizeToUnit(prepareStrokes(curvesToStrokes(read.doc).strokes));
    const started = performance.now();
    const tour = optimizeTour(strokes);
    const ms = performance.now() - started;
    const path = buildPath(prepareStrokes(applyTour(strokes, tour.steps)));
    const share = path.lengths[JUMP] / path.total;
    console.log(`line2func out/curves.json: ${strokes.length} strokes, pen-up ${(100 * share).toFixed(1)}% in ${ms.toFixed(0)} ms`);
    expect(share).toBeLessThan(0.25);
  });
});
