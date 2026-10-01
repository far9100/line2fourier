// Strokes → one closed path. Every segment of the path has a kind: ink is drawn, closure is the
// straight line that closes a single open stroke (drawn dashed in the original), jump is the
// pen-up move between strokes (computed with the rest, never drawn), and fill paints an area with
// a pen as wide as the stroke says (DECISIONS.md D42). Spec §4.1, §4.6, §13.
import { resampleClosedIndexed, type Pt } from './fourier.ts';

export const INK = 0;
export const CLOSURE = 1;
export const JUMP = 2;
export const FILL = 3;
export type SegKind = typeof INK | typeof CLOSURE | typeof JUMP | typeof FILL;

export interface Stroke {
  pts: Pt[];
  closed: boolean;
  /** Set on a stroke that paints an area: the width of its pen, in the stroke's own units. */
  fill?: number;
}

/** A copy of `s` with other points, keeping what kind of stroke it is. */
export const withPts = (s: Stroke, pts: Pt[], closed = s.closed): Stroke => (s.fill ? { pts, closed, fill: s.fill } : { pts, closed });

/** How one stroke is walked in a path: its index, its direction, and (closed strokes only) the vertex it starts at. */
export interface TourStep { index: number; reversed: boolean; start: number }

export interface PathResult {
  /** The closed polyline; the segment from the last point back to the first is implied. */
  poly: Pt[];
  /** kinds[i] is the kind of the segment from poly[i] to poly[(i + 1) % poly.length]. */
  kinds: Uint8Array;
  /** cum[i] is the arc length from poly[0] to poly[i]; cum[poly.length] is the total length. */
  cum: Float64Array;
  total: number;
  /** Total length of each kind of segment, indexed by SegKind. */
  lengths: [number, number, number, number];
  /** The width of the pen that paints areas (the widest of the strokes'), 0 when nothing is painted. */
  fillWidth: number;
}

export type PathErrorCode = 'empty' | 'too-few-points' | 'zero-length';

export class PathError extends Error {
  readonly code: PathErrorCode;
  constructor(code: PathErrorCode) {
    super(`path rejected: ${code}`);
    this.name = 'PathError';
    this.code = code;
  }
}

const same = (a: Pt, b: Pt) => a[0] === b[0] && a[1] === b[1];

/** Drop repeated points (and a closed stroke's copy of its first point at the end). */
export function cleanStroke(stroke: Stroke): Stroke {
  const pts: Pt[] = [];
  for (const p of stroke.pts) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (pts.length === 0 || !same(pts[pts.length - 1], p)) pts.push([p[0], p[1]]);
  }
  if (stroke.closed && pts.length > 1 && same(pts[0], pts[pts.length - 1])) pts.pop();
  return withPts(stroke, pts, stroke.closed && pts.length > 2);
}

/** Clean every stroke and drop the ones without length; reject what spec §13 rejects. */
export function prepareStrokes(strokes: Stroke[]): Stroke[] {
  const out = strokes.map(cleanStroke).filter(s => s.pts.length > 1);
  if (out.length === 0) {
    throw new PathError(strokes.some(s => s.pts.length > 0) ? 'zero-length' : 'empty');
  }
  const distinct = new Set<string>();
  for (const s of out) {
    for (const p of s.pts) {
      distinct.add(`${p[0]},${p[1]}`);
      if (distinct.size >= 3) return out;
    }
  }
  throw new PathError('too-few-points');
}

export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

export function strokesBBox(strokes: Stroke[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    for (const [x, y] of s.pts) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Move the bounding box's centre to the origin and scale its long side to 2, i.e. into [-1, 1]² (spec §3). */
export function normalizeToUnit(strokes: Stroke[]): Stroke[] {
  const b = strokesBBox(strokes);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const half = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2;
  const s = half > 0 ? 1 / half : 1;
  return strokes.map(st => {
    const pts = st.pts.map(([x, y]) => [(x - cx) * s, (y - cy) * s] as Pt);
    return st.fill ? { pts, closed: st.closed, fill: st.fill * s } : { pts, closed: st.closed };
  });
}

/** The points of one stroke in walking order. A closed stroke starts at `start` and comes back to it. */
export function orientedPoints(stroke: Stroke, step: TourStep): Pt[] {
  const p = stroke.pts;
  if (!stroke.closed) return step.reversed ? p.slice().reverse() : p.slice();
  const n = p.length, out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const j = step.reversed ? (step.start - i + n * 2) % n : (step.start + i) % n;
    out.push(p[j]);
  }
  return out;
}

export function identityOrder(strokes: Stroke[]): TourStep[] {
  return strokes.map((_, index) => ({ index, reversed: false, start: 0 }));
}

/**
 * Chain the strokes (already cleaned) into one closed path, in the given order. Strokes that
 * touch are joined without a jump. The way back to the start is a jump when there are several
 * strokes, the closing line when there is one open stroke, and ink when there is one closed stroke.
 */
export function buildPath(strokes: Stroke[], order: TourStep[] = identityOrder(strokes)): PathResult {
  if (order.length === 0) throw new PathError('empty');
  const pts: Pt[] = [];
  const arrive: SegKind[] = []; // arrive[i]: kind of the segment that ends at pts[i]
  const push = (p: Pt, kind: SegKind) => {
    if (pts.length > 0 && same(pts[pts.length - 1], p)) return;
    pts.push(p);
    arrive.push(kind);
  };
  let fillWidth = 0;
  for (const step of order) {
    const stroke = strokes[step.index], kind = stroke.fill ? FILL : INK;
    if (stroke.fill) fillWidth = Math.max(fillWidth, stroke.fill);
    orientedPoints(stroke, step).forEach((p, i) => push(p, i === 0 ? JUMP : kind));
  }
  const only = order.length === 1 ? strokes[order[0].index] : null;
  let closing: SegKind = only ? (only.closed ? (only.fill ? FILL : INK) : CLOSURE) : JUMP;
  if (pts.length > 1 && same(pts[pts.length - 1], pts[0])) {
    closing = arrive[arrive.length - 1];
    pts.pop();
    arrive.pop();
  }
  const n = pts.length;
  const kinds = new Uint8Array(n);
  for (let i = 0; i < n - 1; i++) kinds[i] = arrive[i + 1];
  kinds[n - 1] = closing;

  const cum = new Float64Array(n + 1);
  const lengths: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    cum[i + 1] = cum[i] + d;
    lengths[kinds[i]] += d;
  }
  const total = cum[n];
  if (!(total > 0)) throw new PathError('zero-length');
  return { poly: pts, kinds, cum, total, lengths, fillWidth };
}

/**
 * The parameter intervals [t0, t1] (t = arc length / total, as in the samples) covered by segments
 * of one kind, with neighbouring segments of that kind merged.
 */
export function kindSpans(path: PathResult, kind: SegKind): [number, number][] {
  const out: [number, number][] = [];
  const n = path.poly.length;
  for (let i = 0; i < n; i++) {
    if (path.kinds[i] !== kind) continue;
    const t0 = path.cum[i] / path.total, t1 = path.cum[i + 1] / path.total;
    const last = out[out.length - 1];
    if (last && last[1] === t0) last[1] = t1;
    else out.push([t0, t1]);
  }
  return out;
}

export interface Samples {
  /** The N samples: exactly resampleClosed(path.poly, N). */
  pts: Pt[];
  /** The kind of the segment each sample lies on; the spec's penUp[n] is kind[n] === JUMP. */
  kind: Uint8Array;
}

export function samplePath(path: PathResult, N: number): Samples {
  const { pts, seg } = resampleClosedIndexed(path.poly, N);
  const kind = new Uint8Array(N);
  for (let n = 0; n < N; n++) kind[n] = path.kinds[seg[n]];
  return { pts, kind };
}
