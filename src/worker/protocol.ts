// Messages between the page and the worker. Strokes travel packed in typed arrays (transferable,
// no per-point objects); handle() is a plain function, so tests call it without a worker.
import type { Pt } from '../core/fourier.ts';
import type { Stroke } from '../core/path.ts';
import { rasterToStrokes } from '../core/raster.ts';
import { routeStrokes, type Routed } from '../core/route.ts';

/**
 * fill[i] is stroke i's pen width when it paints an area, 0 when it is a line; again[i] is 1 when
 * it is a stretch walked along again (DECISIONS.md D46).
 */
export interface Packed { xy: Float64Array; offsets: Uint32Array; closed: Uint8Array; fill: Float64Array; again: Uint8Array }

export function pack(strokes: Stroke[]): Packed {
  const offsets = new Uint32Array(strokes.length + 1);
  strokes.forEach((s, i) => { offsets[i + 1] = offsets[i] + s.pts.length; });
  const xy = new Float64Array(2 * offsets[strokes.length]);
  strokes.forEach((s, i) => s.pts.forEach(([x, y], k) => { xy[2 * (offsets[i] + k)] = x; xy[2 * (offsets[i] + k) + 1] = y; }));
  return {
    xy, offsets, closed: Uint8Array.from(strokes, s => (s.closed ? 1 : 0)),
    fill: Float64Array.from(strokes, s => s.fill ?? 0), again: Uint8Array.from(strokes, s => (s.again ? 1 : 0)),
  };
}

export function unpack(p: Packed): Stroke[] {
  const out: Stroke[] = [];
  for (let i = 0; i + 1 < p.offsets.length; i++) {
    const pts: Pt[] = [];
    for (let k = p.offsets[i]; k < p.offsets[i + 1]; k++) pts.push([p.xy[2 * k], p.xy[2 * k + 1]]);
    const stroke: Stroke = { pts, closed: p.closed[i] === 1 };
    if (p.fill[i] > 0) stroke.fill = p.fill[i];
    if (p.again[i] === 1) stroke.again = true;
    out.push(stroke);
  }
  return out;
}

export type Request =
  | { id: number; type: 'route'; strokes: Packed; reach: number }
  | { id: number; type: 'raster'; rgba: Uint8ClampedArray; width: number; height: number };

/** routeStrokes's result, its pieces packed. */
export type RouteReply = Omit<Routed, 'strokes'> & { strokes: Packed };

export interface RasterReply { strokes: Packed; w: number; h: number; inkShare: number; warnings: Record<string, number> }

export type Response =
  | { id: number; ok: true; route: RouteReply }
  | { id: number; ok: true; raster: RasterReply }
  | { id: number; ok: false; error: string };

export function handle(req: Request): Response {
  try {
    if (req.type === 'route') {
      const r = routeStrokes(unpack(req.strokes), req.reach);
      return { id: req.id, ok: true, route: { ...r, strokes: pack(r.strokes) } };
    }
    const r = rasterToStrokes(req.rgba, req.width, req.height);
    return { id: req.id, ok: true, raster: { strokes: pack(r.strokes), w: r.w, h: r.h, inkShare: r.inkShare, warnings: r.warnings } };
  } catch (e) {
    return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
