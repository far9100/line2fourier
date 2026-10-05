// Opening a drawing from a file (spec §5.3–§5.5): read it into strokes, clean and simplify them
// (§13), normalize to [-1, 1]² (§3), join ends that nearly meet (D38), find the one walk over them
// in the worker (§4.6, D46), and pick N for its length.
import { BRIDGE_SHARE, bridgeEnds } from '../core/bridge.ts';
import { curvesToStrokes, parseCurvesJson } from '../core/line2funcImport.ts';
import { JUMP, PathError, buildPath, kindSpans, normalizeToUnit, prepareStrokes, strokesBBox, withPts, type Stroke } from '../core/path.ts';
import type { Routed } from '../core/route.ts';
import { simplifyDrawing } from '../core/simplify.ts';
import { readSvg, svgItemsToStrokes, type ImportWarnings } from '../core/svgImport.ts';
import { autoN, type NSize } from '../core/ticks.ts';
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
  /** Normalized, cleaned, joined where ends nearly meet, and cut into the pieces of one walk (core/route.ts). */
  strokes: Stroke[];
  /** Strokes in the file (after cleaning), before any were joined. */
  strokeCount: number;
  /** Strokes once ends that nearly meet are joined: the lines the drawing is made of. */
  penDownStrokes: number;
  /** Times the pen lifts on the walk. */
  lifts: number;
  jumpRatio: number;
  /** The pen-up share of the path had the file's strokes been chained as they are, in the file's order. */
  originalJumpRatio: number;
  N: NSize;
  /** i18n key → count, for things in the file that were left out or changed. */
  warnings: ImportWarnings;
}

/** core/route.ts's routeStrokes, here or in the worker. */
export type RouteFn = (strokes: Stroke[], reach: number) => Promise<Routed>;

/** What every kind of file goes through once it is strokes (y up): clean, simplify, normalize, join into one walk. */
export async function finishImport(raw: Stroke[], warnings: ImportWarnings, route: RouteFn): Promise<Prepared | { error: string }> {
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
  const strokeCount = strokes.length;
  // The baseline shown next to the result: the file's strokes as they are, in the file's order.
  const asFiled = buildPath(strokes);

  // Gaps narrower than 0.5% of the drawing are crossed pen-down (the long side is 2 after normalizing):
  // between ends here, anywhere along the strokes in the walk.
  const reach = BRIDGE_SHARE * 2;
  const bridged = bridgeEnds(strokes, reach);
  if (bridged.bridges > 0) warnings['import.bridged'] = bridged.bridges;
  strokes = prepareStrokes(bridged.strokes);

  // If the walk cannot be found the drawing still opens, its strokes chained as they are.
  let walked = strokes;
  try {
    const routed = await route(strokes, reach);
    walked = prepareStrokes(routed.strokes);
    if (routed.links > 0) warnings['import.linked'] = routed.links;
  } catch {
    warnings['import.unrouted'] = 1;
  }
  const path = buildPath(walked);
  return {
    strokes: walked,
    strokeCount,
    penDownStrokes: strokes.length,
    lifts: kindSpans(path, JUMP).length,
    jumpRatio: path.lengths[JUMP] / path.total,
    originalJumpRatio: asFiled.lengths[JUMP] / asFiled.total,
    N: autoN(path.total),
    warnings,
  };
}

/** An SVG file or line2func's curves.json. */
export async function prepareImport(kind: 'svg' | 'line2func', text: string, route: RouteFn): Promise<Prepared | { error: string }> {
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
    // The hatching is left out because the areas are painted instead; it is said so when none is.
    if (c.filled > 0) warnings['import.filled'] = c.filled;
    else if (c.skippedFill > 0) warnings['line2func.skippedFill'] = c.skippedFill;
    raw = c.strokes;
  }
  return finishImport(raw, warnings, route);
}

/** Strokes traced from an image (pixel coordinates, y down; see core/raster.ts), turned y up. */
export function imageStrokes(strokes: Stroke[], height: number): Stroke[] {
  return strokes.map(s => withPts(s, s.pts.map(([x, y]) => [x, height - y] as Pt)));
}

/** SHA-256 of the file as hex (spec §10: an imported source is saved by name and hash). */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
