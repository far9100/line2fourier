// Spec §13: too many strokes (> 2000) or too many points are announced and simplified.
import type { Pt } from './fourier.ts';
import type { Stroke } from './path.ts';

/** Douglas–Peucker on an open polyline, without recursion; the end points are always kept. */
export function douglasPeucker(pts: Pt[], eps: number): Pt[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d = len > 0 ? Math.abs((px - ax) * dy - (py - ay) * dx) / len : Math.hypot(px - ax, py - ay);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > eps) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export const LIMITS = { maxStrokes: 2000, maxPoints: 200_000 };

const lengthOf = (s: Stroke) => s.pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p[0] - s.pts[i - 1][0], p[1] - s.pts[i - 1][1]) : 0), 0);

/**
 * Keep the 2000 longest strokes (in their original order), then simplify with Douglas–Peucker,
 * doubling the tolerance from 1/10,000 of the drawing's size until there are at most 200,000 points.
 */
export function simplifyDrawing(strokes: Stroke[], size: number, limits = LIMITS): { strokes: Stroke[]; droppedStrokes: number; epsilon: number } {
  let kept = strokes;
  let droppedStrokes = 0;
  if (strokes.length > limits.maxStrokes) {
    const order = strokes.map((s, i) => ({ i, len: lengthOf(s) })).sort((p, q) => q.len - p.len || p.i - q.i);
    const keep = new Set(order.slice(0, limits.maxStrokes).map(o => o.i));
    kept = strokes.filter((_, i) => keep.has(i));
    droppedStrokes = strokes.length - kept.length;
  }
  const count = (list: Stroke[]) => list.reduce((n, s) => n + s.pts.length, 0);
  let epsilon = 0;
  while (count(kept) > limits.maxPoints) {
    epsilon = epsilon ? epsilon * 2 : size * 1e-4;
    kept = kept.map(s => ({ closed: s.closed, pts: douglasPeucker(s.pts, epsilon) }));
  }
  return { strokes: kept, droppedStrokes, epsilon };
}
