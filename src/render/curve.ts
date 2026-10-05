// The approximation curve as something to draw: the N samples of partialCurve plus a point at
// every edge of a span that is not plain ink, each interval labelled with its kind. The canvas,
// the SVG export, the video and the flipbook all trace the curve from this one list, so the pen
// lifts exactly where a stroke ends instead of up to one sample later (DECISIONS.md D5).
import { chainInto, fft, type Pt, type Term } from '../core/fourier.ts';
import { AGAIN, CLOSURE, FILL, INK, JUMP, type SegKind, type Spans } from '../core/path.ts';

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

/**
 * The pen tip of the first M terms at any time, read off a curve sampled `oversample` times as
 * densely as the N samples (one inverse FFT), with a straight line between neighbours. An opened
 * drawing has thousands of span edges; tipAt costs O(M) for each, this O(1). With at least four
 * points to every sample the difference from tipAt is far below a pixel (DECISIONS.md D47).
 */
export function tipSampler(c0: Term, terms: Term[], M: number, N: number, oversample = 4): (t: number) => Pt {
  const F = N * oversample;
  const re = new Float64Array(F), im = new Float64Array(F);
  const put = (c: Term) => { const m = (c.k + F) % F; re[m] = c.re; im[m] = c.im; };
  put(c0);
  for (let j = 0; j < M; j++) put(terms[j]);
  fft(re, im, true);
  return t => {
    const x = (t - Math.floor(t)) * F, i = Math.min(F - 1, Math.floor(x)), f = x - i, j = i + 1 === F ? 0 : i + 1;
    return [re[i] + f * (re[j] - re[i]), im[i] + f * (im[j] - im[i])];
  };
}

const SPAN_KINDS: [keyof Spans, SegKind][] = [['jump', JUMP], ['closure', CLOSURE], ['fill', FILL], ['again', AGAIN]];

/** The kind of the path at time t (spans are sorted and do not overlap). */
export function kindAt(spans: Spans, t: number): SegKind {
  for (const [name, kind] of SPAN_KINDS) for (const [a, b] of spans[name]) if (t > a && t < b) return kind;
  return INK;
}

/**
 * Merge the samples approx[n] at t = n/len (plus the first one again at t = 1, the curve being
 * closed) with the span edges, evaluated with `at`.
 */
export function curveEvents(approx: Pt[], spans: Spans, at: (t: number) => Pt, fillWidth = 0): CurveEvents {
  const len = approx.length;
  const edges = SPAN_KINDS.flatMap(([name]) => spans[name].flat()).filter(e => e > 0 && e < 1).sort((a, b) => a - b);
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
  const all = SPAN_KINDS.flatMap(([name, k]) => spans[name].map(s => [s[0], s[1], k] as const)).sort((p, q) => p[0] - q[0]);
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
 * nowhere when it is null; when the curve is cut short it ends at `tip`. Where the pen walks along
 * a line again nothing is drawn: the line is there from the first time (D46).
 */
export function traceCurve(
  ev: CurveEvents, tEnd: number, tip: Pt | null, ink: PathSink, closure: PathSink, fill: PathSink = ink, jump: PathSink | null = null,
): void {
  let pen: PathSink | null = null;
  for (let i = 0; i + 1 < ev.count && ev.t[i] < tEnd; i++) {
    const k = ev.kind[i];
    const sink = k === JUMP ? jump : k === AGAIN ? null : k === CLOSURE ? closure : k === FILL ? fill : ink;
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
