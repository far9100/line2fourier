// line2func's curves.json → strokes (spec §5.4). The format, as line2func writes and reads it
// (line2func/curves.py, docs/details.md): image pixels with y down; a flat list of cubic Bézier
// curves, ctrl = [P0, P1, P2, P3]; consecutive curves with the same `stroke` id join end to end;
// a stroke is closed when its last P3 is its first P0. Curves tagged `fill` are the hatching
// line2func draws inside filled areas, left out unless asked for (DECISIONS.md D27); the areas
// themselves, the closed strokes tagged `fill_outline`, are painted here instead (D42).
import { fillSpacing, paintAreas, rasterizeLoops } from './fill.ts';
import type { Pt } from './fourier.ts';
import type { Stroke } from './path.ts';

export interface CurvesJson {
  format: 'line2func.curves';
  version: 1;
  image: { width: number; height: number };
  coordinates?: string;
  curves: { stroke?: number; ctrl: [Pt, Pt, Pt, Pt]; tags?: string[] }[];
}

export type CurvesError = 'json' | 'format' | 'version' | 'coordinates' | 'curves';

const isPt = (v: unknown): v is Pt => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n));

export function parseCurvesJson(text: string): { doc: CurvesJson } | { error: CurvesError } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'json' };
  }
  const d = data as Partial<CurvesJson> & Record<string, unknown>;
  if (typeof d !== 'object' || d === null || d.format !== 'line2func.curves') return { error: 'format' };
  if (d.version !== 1) return { error: 'version' };
  if (d.coordinates !== undefined && d.coordinates !== 'image-pixels-y-down') return { error: 'coordinates' };
  const img = d.image;
  if (!img || !(img.width > 0) || !(img.height > 0) || !Array.isArray(d.curves)) return { error: 'curves' };
  for (const c of d.curves) {
    if (!c || !Array.isArray(c.ctrl) || c.ctrl.length !== 4 || !c.ctrl.every(isPt)) return { error: 'curves' };
  }
  return { doc: d as CurvesJson };
}

function bezier(c: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, cc = 3 * u * t * t, e = t * t * t;
  return [a * c[0][0] + b * c[1][0] + cc * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + cc * c[2][1] + e * c[3][1]];
}

const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** The longest side of the grid the filled areas are painted on, as for pictures (core/raster.ts). */
const PAINT_SIDE = 1024;

/**
 * Sample every curve in proportion to the length of its control polygon (about one point per
 * 1/500 of the image's diagonal, 2 to 64 per curve), join the curves of a stroke, flip y. The
 * filled areas are painted in (their hatching left out), unless the hatching is asked for.
 */
export function curvesToStrokes(doc: CurvesJson, opts: { includeFill?: boolean } = {}): { strokes: Stroke[]; skippedFill: number; filled: number } {
  const { width, height } = doc.image;
  const step = Math.hypot(width, height) / 500;
  const strokes: Stroke[] = [];
  const areas: Pt[][] = [];
  let skippedFill = 0;
  let cur: { id: number; pts: Pt[]; area: boolean } | null = null;
  const finish = () => {
    if (cur && cur.pts.length > 1) {
      const closed = dist(cur.pts[0], cur.pts[cur.pts.length - 1]) < 1e-6;
      const pts = cur.pts.map(([x, y]) => [x, height - y] as Pt);
      strokes.push({ closed, pts });
      if (closed && cur.area) areas.push(pts);
    }
    cur = null;
  };
  for (const curve of doc.curves) {
    if (!opts.includeFill && curve.tags?.includes('fill')) { skippedFill++; finish(); continue; }
    const id = curve.stroke ?? 0;
    const c = curve.ctrl;
    // A new stroke when the id changes, or when this piece does not start where the last one ended.
    if (!cur || cur.id !== id || dist(cur.pts[cur.pts.length - 1], c[0]) > 1e-6) {
      finish();
      cur = { id, pts: [c[0]], area: false };
    }
    if (curve.tags?.includes('fill_outline')) cur.area = true;
    const poly = dist(c[0], c[1]) + dist(c[1], c[2]) + dist(c[2], c[3]);
    const n = Math.min(64, Math.max(2, Math.ceil(poly / step)));
    for (let k = 1; k <= n; k++) cur.pts.push(bezier(c, k / n));
  }
  finish();
  if (opts.includeFill || areas.length === 0) return { strokes, skippedFill, filled: 0 };

  // Paint the areas on a grid at most PAINT_SIDE pixels long (the outlines are y up already).
  const scale = Math.min(1, PAINT_SIDE / Math.max(width, height));
  const gw = Math.max(1, Math.ceil(width * scale)), gh = Math.max(1, Math.ceil(height * scale));
  const mask = rasterizeLoops(areas.map(loop => loop.map(([x, y]) => [x * scale, y * scale] as Pt)), gw, gh);
  let area = 0;
  for (const b of mask) area += b;
  const painted = paintAreas(mask, gw, gh, fillSpacing(area, Math.max(gw, gh)));
  for (const s of painted.strokes) {
    strokes.push({ pts: s.pts.map(([x, y]) => [x / scale, y / scale] as Pt), closed: true, fill: s.fill! / scale });
  }
  return { strokes, skippedFill, filled: painted.areas };
}
