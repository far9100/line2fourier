// Opening a drawing from a file (spec §5.3–§5.5): read it into strokes, clean and simplify them
// (§13), normalize to [-1, 1]² (§3), order them in the worker (§4.6), and pick N for its length.
import { curvesToStrokes, parseCurvesJson } from '../core/line2funcImport.ts';
import { JUMP, PathError, buildPath, normalizeToUnit, prepareStrokes, strokesBBox, type Stroke } from '../core/path.ts';
import { simplifyDrawing } from '../core/simplify.ts';
import { readSvg, svgItemsToStrokes, type ImportWarnings } from '../core/svgImport.ts';
import { autoN, type NSize } from '../core/ticks.ts';
import { applyTour, type Tour } from '../core/tour.ts';
import type { Pt } from '../core/fourier.ts';

export type FileKind = 'svg' | 'line2func' | 'image' | 'project';

const RASTER = /\.(png|jpe?g|webp|bmp|gif|avif)$/i;

/** What a file is, from its type, its name and (for text) its first characters. */
export function detectKind(name: string, text: string, mime = ''): FileKind | null {
  if ((mime.startsWith('image/') && mime !== 'image/svg+xml') || RASTER.test(name)) return 'image';
  const head = text.trimStart();
  if (/\.svg$/i.test(name) || head.startsWith('<')) return 'svg';
  if (!head.startsWith('{')) return null;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    if (data.format === 'line2func.curves') return 'line2func';
    if (data.format === 'line2fourier.project' || ('version' in data && 'source' in data)) return 'project';
  } catch {
    return null;
  }
  return null;
}

export interface Prepared {
  /** Normalized, cleaned and walked in tour order (see applyTour). */
  strokes: Stroke[];
  strokeCount: number;
  jumpRatio: number;
  originalJumpRatio: number;
  N: NSize;
  /** i18n key → count, for things in the file that were left out or changed. */
  warnings: ImportWarnings;
}

type TourFn = (strokes: Stroke[]) => Promise<Tour>;

/** What every kind of file goes through once it is strokes (y up): clean, simplify, normalize, order. */
export async function finishImport(raw: Stroke[], warnings: ImportWarnings, tour: TourFn): Promise<Prepared | { error: string }> {
  let strokes: Stroke[];
  try {
    strokes = prepareStrokes(raw);
  } catch (e) {
    if (e instanceof PathError) return { error: `error.path.${e.code}` };
    throw e;
  }
  const box = strokesBBox(strokes);
  const simple = simplifyDrawing(strokes, Math.max(box.maxX - box.minX, box.maxY - box.minY));
  if (simple.droppedStrokes > 0) warnings['import.droppedStrokes'] = simple.droppedStrokes;
  if (simple.epsilon > 0) warnings['import.simplified'] = 1;
  strokes = normalizeToUnit(prepareStrokes(simple.strokes));

  const t = await tour(strokes);
  const walked = applyTour(strokes, t.steps);
  const path = buildPath(prepareStrokes(walked));
  const drawn = path.total - path.lengths[JUMP];
  return {
    strokes: walked,
    strokeCount: strokes.length,
    jumpRatio: path.lengths[JUMP] / path.total,
    originalJumpRatio: t.originalJumpLength / (drawn + t.originalJumpLength),
    N: autoN(path.total),
    warnings,
  };
}

/** An SVG file or line2func's curves.json. */
export async function prepareImport(kind: 'svg' | 'line2func', text: string, tour: TourFn): Promise<Prepared | { error: string }> {
  const warnings: ImportWarnings = {};
  let raw: Stroke[];
  if (kind === 'svg') {
    const read = readSvg(text);
    if ('error' in read) return { error: 'import.error.svg' };
    Object.assign(warnings, read.warnings);
    raw = svgItemsToStrokes(read.items);
  } else {
    const read = parseCurvesJson(text);
    if ('error' in read) return { error: `import.error.curves.${read.error}` };
    const c = curvesToStrokes(read.doc);
    if (c.skippedFill > 0) warnings['line2func.skippedFill'] = c.skippedFill;
    raw = c.strokes;
  }
  return finishImport(raw, warnings, tour);
}

/** Strokes traced from an image (pixel coordinates, y down; see core/raster.ts), turned y up. */
export function imageStrokes(strokes: Stroke[], height: number): Stroke[] {
  return strokes.map(s => ({ closed: s.closed, pts: s.pts.map(([x, y]) => [x, height - y] as Pt) }));
}

/** SHA-256 of the file as hex (spec §10: an imported source is saved by name and hash). */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
