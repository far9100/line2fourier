// The approximation curve as something to draw: the N samples of partialCurve plus an exact point
// at every edge of a jump, closure or fill span, each interval labelled with its kind. The canvas,
// the SVG export, the video and the flipbook all trace the curve from this one list, so the pen
// lifts exactly where a stroke ends instead of up to one sample later (DECISIONS.md D5).
import { chainInto, type Pt, type Term } from '../core/fourier.ts';
import { CLOSURE, FILL, INK, JUMP, type SegKind } from '../core/path.ts';

export interface Spans { jump: [number, number][]; closure: [number, number][]; fill: [number, number][] }

export interface CurveEvents {
  count: number;
  t: Float64Array;
  x: Float64Array;
  y: Float64Array;
  /** kind[i] is the kind of the stretch from event i to event i + 1. */
  kind: Uint8Array;
  /** The width of the pen that paints the fill stretches (world units), 0 when there are none. */
  fillWidth: number;
}

/** Something to draw lines into: a Path2D, a canvas context, or the SVG writer. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
}

/** The pen tip of the first M terms at time t. */
export function tipAt(c0: Term, terms: Term[], M: number, t: number, scratch = new Float64Array(2 * M + 2)): Pt {
  chainInto(c0, terms, M, t, scratch);
  return [scratch[2 * M], scratch[2 * M + 1]];
}

/** The kind of the path at time t (spans are sorted and do not overlap). */
export function kindAt(spans: Spans, t: number): SegKind {
  for (const [a, b] of spans.jump) if (t > a && t < b) return JUMP;
  for (const [a, b] of spans.closure) if (t > a && t < b) return CLOSURE;
  for (const [a, b] of spans.fill) if (t > a && t < b) return FILL;
  return INK;
}

/**
 * Merge the samples approx[n] at t = n/len (plus the first one again at t = 1, the curve being
 * closed) with the span edges, evaluated with `at`.
 */
export function curveEvents(approx: Pt[], spans: Spans, at: (t: number) => Pt, fillWidth = 0): CurveEvents {
  const len = approx.length;
  const edges = [...spans.jump.flat(), ...spans.closure.flat(), ...spans.fill.flat()].filter(e => e > 0 && e < 1).sort((a, b) => a - b);
  const ts: number[] = [], xs: number[] = [], ys: number[] = [];
  const push = (t: number, p: Pt) => { ts.push(t); xs.push(p[0]); ys.push(p[1]); };
  let e = 0;
  for (let n = 0; n <= len; n++) {
    const tn = n / len;
    for (; e < edges.length && edges[e] <= tn; e++) {
      if (edges[e] < tn && edges[e] > ts[ts.length - 1]) push(edges[e], at(edges[e]));
    }
    push(tn, approx[n % len]);
  }
  const count = ts.length;
  const kind = new Uint8Array(count);
  // Spans are sorted, so one walk over them labels every interval.
  const all = [
    ...spans.jump.map(s => [s[0], s[1], JUMP] as const),
    ...spans.closure.map(s => [s[0], s[1], CLOSURE] as const),
    ...spans.fill.map(s => [s[0], s[1], FILL] as const),
  ].sort((p, q) => p[0] - q[0]);
  let s = 0;
  for (let i = 0; i + 1 < count; i++) {
    const mid = (ts[i] + ts[i + 1]) / 2;
    while (s < all.length && all[s][1] <= mid) s++;
    kind[i] = s < all.length && all[s][0] < mid ? all[s][2] : INK;
  }
  return { count, t: Float64Array.from(ts), x: Float64Array.from(xs), y: Float64Array.from(ys), kind, fillWidth };
}

/**
 * Draw the curve from t = 0 up to tEnd (all of it when tEnd ≥ 1) into `ink`, `closure` and `fill`
 * (the stretches that paint an area, drawn with the wide pen), and the jumps into `jump`, or
 * nowhere when it is null; when the curve is cut short it ends at `tip`.
 */
export function traceCurve(
  ev: CurveEvents, tEnd: number, tip: Pt | null, ink: PathSink, closure: PathSink, fill: PathSink = ink, jump: PathSink | null = null,
): void {
  let pen: PathSink | null = null;
  for (let i = 0; i + 1 < ev.count && ev.t[i] < tEnd; i++) {
    const k = ev.kind[i];
    const sink = k === JUMP ? jump : k === CLOSURE ? closure : k === FILL ? fill : ink;
    if (!sink) { pen = null; continue; }
    if (pen !== sink) { sink.moveTo(ev.x[i], ev.y[i]); pen = sink; }
    if (ev.t[i + 1] <= tEnd || !tip) {
      sink.lineTo(ev.x[i + 1], ev.y[i + 1]);
    } else {
      sink.lineTo(tip[0], tip[1]);
      break;
    }
  }
}
