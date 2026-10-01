import { describe, expect, it } from 'vitest';
import { coefficients, orderTerms, partialCurve, type Pt } from '../../src/core/fourier.ts';
import { CLOSURE, FILL, INK, JUMP, buildPath, kindSpans, samplePath, type Stroke } from '../../src/core/path.ts';
import { makeCamera, toScreen, toWorld } from '../../src/render/camera.ts';
import { curveEvents, kindAt, tipAt, traceCurve, type PathSink } from '../../src/render/curve.ts';

/** Records drawing calls as polylines. */
function recorder() {
  const lines: Pt[][] = [];
  const sink: PathSink = {
    moveTo: (x, y) => { lines.push([[x, y]]); },
    lineTo: (x, y) => { lines[lines.length - 1].push([x, y]); },
  };
  return { lines, sink };
}

const strokes: Stroke[] = [
  { pts: [[0, 0], [1, 0], [1, 1]], closed: false },
  { pts: [[3, 0], [4, 1]], closed: false },
];
const path = buildPath(strokes);
const spans = { jump: kindSpans(path, JUMP), closure: kindSpans(path, CLOSURE), fill: kindSpans(path, FILL) };
const N = 256;
const s = samplePath(path, N);
const o = orderTerms(coefficients(s.pts));
const M = N - 1;
const approx = partialCurve(o.c0, o.terms, M, N);
const ev = curveEvents(approx, spans, t => tipAt(o.c0, o.terms, M, t));

describe('curve events', () => {
  it('hold every sample (and the first again at t = 1) plus a point at each span edge', () => {
    const edges = [...spans.jump.flat(), ...spans.closure.flat()].filter(e => e > 0 && e < 1);
    expect(ev.count).toBe(N + 1 + new Set(edges.filter(e => !Number.isInteger(e * N))).size);
    expect(ev.t[0]).toBe(0);
    expect(ev.t[ev.count - 1]).toBe(1);
    for (let i = 1; i < ev.count; i++) expect(ev.t[i]).toBeGreaterThan(ev.t[i - 1]);
  });

  it('label each stretch with the kind of the path there', () => {
    for (let i = 0; i + 1 < ev.count; i++) expect(ev.kind[i]).toBe(kindAt(spans, (ev.t[i] + ev.t[i + 1]) / 2));
    expect(kindAt(spans, 0.01)).toBe(INK);
    expect(kindAt(spans, (spans.jump[0][0] + spans.jump[0][1]) / 2)).toBe(JUMP);
  });

  it('with all N − 1 circles, the edges of the strokes are on the drawing', () => {
    // The approximation interpolates the samples; at a stroke's end it is close to the end point.
    const [a] = spans.jump[0];
    const p = tipAt(o.c0, o.terms, M, a);
    expect(Math.hypot(p[0] - 1, p[1] - 1)).toBeLessThan(0.05);
  });
});

describe('tracing the curve', () => {
  it('the whole cycle is one line per stroke: the jumps are left out', () => {
    const ink = recorder(), closure = recorder();
    traceCurve(ev, 1, null, ink.sink, closure.sink);
    expect(ink.lines).toHaveLength(2);
    expect(closure.lines).toHaveLength(0);
  });

  it('a single open stroke has its closing line traced separately', () => {
    const p = buildPath([{ pts: [[0, 0], [2, 0], [1, 1.5]], closed: false }]);
    const sp = { jump: kindSpans(p, JUMP), closure: kindSpans(p, CLOSURE), fill: kindSpans(p, FILL) };
    const sm = samplePath(p, 128);
    const oo = orderTerms(coefficients(sm.pts));
    const e = curveEvents(partialCurve(oo.c0, oo.terms, 20, 128), sp, t => tipAt(oo.c0, oo.terms, 20, t));
    const ink = recorder(), closure = recorder();
    traceCurve(e, 1, null, ink.sink, closure.sink);
    expect(ink.lines).toHaveLength(1);
    expect(closure.lines).toHaveLength(1);
    // The two pieces meet: the closure starts where the ink stops.
    expect(closure.lines[0][0]).toEqual(ink.lines[0][ink.lines[0].length - 1]);
  });

  it('the stretches that paint an area go to their own sink, with the pen width (D42)', () => {
    const p = buildPath([
      { pts: [[0, 0], [2, 0], [2, 2]], closed: false },
      { pts: [[3, 0], [4, 0], [4, 1], [3, 1]], closed: true, fill: 0.25 },
    ]);
    const sp = { jump: kindSpans(p, JUMP), closure: kindSpans(p, CLOSURE), fill: kindSpans(p, FILL) };
    expect(sp.fill).toHaveLength(1);
    const sm = samplePath(p, 256);
    const oo = orderTerms(coefficients(sm.pts));
    const e = curveEvents(partialCurve(oo.c0, oo.terms, 255, 256), sp, t => tipAt(oo.c0, oo.terms, 255, t), p.fillWidth);
    expect(e.fillWidth).toBe(0.25);
    expect(kindAt(sp, (sp.fill[0][0] + sp.fill[0][1]) / 2)).toBe(FILL);
    const ink = recorder(), closure = recorder(), fill = recorder();
    traceCurve(e, 1, null, ink.sink, closure.sink, fill.sink);
    expect(ink.lines).toHaveLength(1);
    expect(fill.lines).toHaveLength(1);
    for (const [x] of fill.lines[0]) expect(x).toBeGreaterThan(2.5);
  });

  it('with a sink for them, the jumps are traced too, each joining the end of one stroke to the start of the next (D44)', () => {
    const ink = recorder(), closure = recorder(), jump = recorder();
    traceCurve(ev, 1, null, ink.sink, closure.sink, ink.sink, jump.sink);
    expect(ink.lines).toHaveLength(2);
    expect(jump.lines).toHaveLength(2); // between the strokes, and back to the start
    expect(jump.lines[0][0]).toEqual(ink.lines[0][ink.lines[0].length - 1]);
    expect(jump.lines[0][jump.lines[0].length - 1]).toEqual(ink.lines[1][0]);
  });

  it('a trail stops at the pen, wherever it is', () => {
    const t = 0.123, tip = tipAt(o.c0, o.terms, M, t);
    const ink = recorder(), closure = recorder();
    traceCurve(ev, t, tip, ink.sink, closure.sink);
    const last = ink.lines[ink.lines.length - 1];
    expect(last[last.length - 1]).toEqual(tip);
    expect(last.length).toBeGreaterThan(Math.floor(t * N));
  });

  it('nothing is traced past the pen during a jump', () => {
    const [a, b] = spans.jump[0];
    const t = (a + b) / 2;
    const ink = recorder(), closure = recorder();
    traceCurve(ev, t, tipAt(o.c0, o.terms, M, t), ink.sink, closure.sink);
    expect(ink.lines).toHaveLength(1);
    const end = ink.lines[0][ink.lines[0].length - 1];
    expect(end).toEqual(tipAt(o.c0, o.terms, M, a)); // the line ends where the jump starts
  });
});

describe('camera', () => {
  it('maps world to screen and back, with y up in the world', () => {
    const cam = makeCamera(800, 600);
    expect(toScreen(cam, 0, 0)).toEqual([400, 300]);
    const [x, y] = toScreen(cam, 1, 1);
    expect(x).toBeGreaterThan(400);
    expect(y).toBeLessThan(300);
    const back = toWorld(cam, x, y);
    expect(back[0]).toBeCloseTo(1, 12);
    expect(back[1]).toBeCloseTo(1, 12);
  });

  it('has a fixed scale: [-1.35, 1.35] fits the shorter side, whatever is drawn', () => {
    expect(makeCamera(800, 600).s).toBeCloseTo(300 / 1.35, 12);
  });

  it('following puts the pen in the middle, magnified', () => {
    const cam = makeCamera(800, 600, [0.3, -0.2], 10);
    expect(toScreen(cam, 0.3, -0.2)).toEqual([400, 300]);
    expect(cam.s).toBeCloseTo((10 * 300) / 1.35, 9);
  });
});
