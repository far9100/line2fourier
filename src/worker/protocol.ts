// Messages between the page and the worker. Strokes travel packed in typed arrays (transferable,
// no per-point objects); handle() is a plain function, so tests call it without a worker.
import type { Pt } from '../core/fourier.ts';
import type { Stroke } from '../core/path.ts';
import { optimizeTour, type Tour, type TourOptions } from '../core/tour.ts';

export interface Packed { xy: Float64Array; offsets: Uint32Array; closed: Uint8Array }

export function pack(strokes: Stroke[]): Packed {
  const offsets = new Uint32Array(strokes.length + 1);
  strokes.forEach((s, i) => { offsets[i + 1] = offsets[i] + s.pts.length; });
  const xy = new Float64Array(2 * offsets[strokes.length]);
  strokes.forEach((s, i) => s.pts.forEach(([x, y], k) => { xy[2 * (offsets[i] + k)] = x; xy[2 * (offsets[i] + k) + 1] = y; }));
  return { xy, offsets, closed: Uint8Array.from(strokes, s => (s.closed ? 1 : 0)) };
}

export function unpack(p: Packed): Stroke[] {
  const out: Stroke[] = [];
  for (let i = 0; i + 1 < p.offsets.length; i++) {
    const pts: Pt[] = [];
    for (let k = p.offsets[i]; k < p.offsets[i + 1]; k++) pts.push([p.xy[2 * k], p.xy[2 * k + 1]]);
    out.push({ pts, closed: p.closed[i] === 1 });
  }
  return out;
}

export type Request = { id: number; type: 'tour'; strokes: Packed; opts?: TourOptions };

export type Response = { id: number; ok: true; tour: Tour } | { id: number; ok: false; error: string };

export function handle(req: Request): Response {
  try {
    return { id: req.id, ok: true, tour: optimizeTour(unpack(req.strokes), req.opts) };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
