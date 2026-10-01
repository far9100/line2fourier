// An SVG file → strokes (spec §5.3). DOMParser reads the file into a detached document; only the
// geometry of path, line, polyline, polygon, rect, circle and ellipse elements and their transforms
// is read from it, so nothing the file contains is ever put into the page or run (DECISIONS.md D25).
import { IDENTITY, mul, parseTransform, type Affine } from './affine.ts';
import type { Pt } from './fourier.ts';
import type { Stroke } from './path.ts';
import { controlBox, flattenSubpath, parsePathData, shapeToSubpaths, type Subpath } from './svgPathData.ts';

export interface SvgItem { subpaths: Subpath[]; m: Affine }

/** Things that were in the file but are not drawn: i18n key → how many. */
export type ImportWarnings = Record<string, number>;

const SHAPES = new Set(['path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse']);
const GROUPS = new Set(['svg', 'g', 'a', 'switch']);
const SKIPPED = new Set(['defs', 'symbol', 'clipPath', 'mask', 'marker', 'pattern', 'linearGradient', 'radialGradient',
  'filter', 'style', 'script', 'title', 'desc', 'metadata', 'foreignObject']);
const UNSUPPORTED: Record<string, string> = { use: 'svg.skippedUse', text: 'svg.skippedText', image: 'svg.skippedImage' };

function hidden(el: Element): boolean {
  if (el.getAttribute('display') === 'none' || el.getAttribute('visibility') === 'hidden') return true;
  const style = el.getAttribute('style') ?? '';
  return /(^|;)\s*display\s*:\s*none/i.test(style) || /(^|;)\s*visibility\s*:\s*hidden/i.test(style);
}

export type SvgReadError = 'svg';

/** Read the drawable geometry of an SVG document's text. */
export function readSvg(text: string): { items: SvgItem[]; warnings: ImportWarnings } | { error: SvgReadError } {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'svg' || doc.getElementsByTagName('parsererror').length > 0) return { error: 'svg' };
  const items: SvgItem[] = [];
  const warnings: ImportWarnings = {};
  const warn = (key: string) => { warnings[key] = (warnings[key] ?? 0) + 1; };

  const walk = (el: Element, parent: Affine) => {
    const tag = el.localName;
    if (SKIPPED.has(tag) || hidden(el)) return;
    if (UNSUPPORTED[tag]) { warn(UNSUPPORTED[tag]); return; }
    const own = parseTransform(el.getAttribute('transform'));
    if (!own) { warn('svg.badTransform'); return; }
    let m = mul(parent, own);
    if (tag === 'svg' && el !== root) {
      // A nested <svg>: its x and y place it; a viewBox inside it is not supported.
      m = mul(m, [1, 0, 0, 1, Number(el.getAttribute('x')) || 0, Number(el.getAttribute('y')) || 0]);
      if (el.hasAttribute('viewBox')) warn('svg.nestedViewBox');
    }
    if (GROUPS.has(tag)) {
      for (const child of Array.from(el.children)) walk(child, m);
      return;
    }
    if (!SHAPES.has(tag)) return;
    let subpaths: Subpath[];
    if (tag === 'path') {
      const parsed = parsePathData(el.getAttribute('d') ?? '');
      if (parsed.errorAt !== null) warn('svg.badPath');
      subpaths = parsed.subpaths;
    } else {
      subpaths = shapeToSubpaths(tag, name => el.getAttribute(name));
    }
    if (subpaths.length > 0) items.push({ subpaths, m });
  };
  walk(root, IDENTITY);
  return { items, warnings };
}

/**
 * Flatten every subpath into a stroke, flat to 1/2000 of the drawing's size, with y turned up
 * (SVG's y points down). Every subpath is a stroke of its own (spec §5.3).
 */
export function svgItemsToStrokes(items: SvgItem[]): Stroke[] {
  const box = controlBox(items);
  const size = Math.max(box.maxX - box.minX, box.maxY - box.minY);
  if (!(size > 0)) return [];
  const tol = 5e-4 * size;
  const strokes: Stroke[] = [];
  for (const item of items) {
    for (const sp of item.subpaths) {
      const s = flattenSubpath(sp, item.m, tol);
      if (s) strokes.push({ closed: s.closed, pts: s.pts.map(([x, y]) => [x, -y] as Pt) });
    }
  }
  return strokes;
}
