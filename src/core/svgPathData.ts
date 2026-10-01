// SVG geometry without a browser: path data parsed to absolute segments, basic shapes turned into
// the same segments, and everything flattened to polylines after the element's transform. Used
// instead of getPointAtLength (spec §5.3) so that importing works in tests and gives the same
// points in every browser (DECISIONS.md D25).
import { applyPt, type Affine } from './affine.ts';
import type { Pt } from './fourier.ts';
import type { Stroke } from './path.ts';

export type Seg =
  | { c: 'L'; x: number; y: number }
  | { c: 'Q'; x1: number; y1: number; x: number; y: number }
  | { c: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { c: 'A'; rx: number; ry: number; phi: number; large: boolean; sweep: boolean; x: number; y: number };

export interface Subpath { x0: number; y0: number; segs: Seg[]; closed: boolean }

/** Path data → subpaths in absolute coordinates. Like a browser, stops at the first error and keeps what came before. */
export function parsePathData(d: string): { subpaths: Subpath[]; errorAt: number | null } {
  const subpaths: Subpath[] = [];
  let i = 0;
  const n = d.length;
  const skip = () => { while (i < n && /[\s,]/.test(d[i])) i++; };
  const num = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  const readNumber = (): number | null => {
    skip();
    num.lastIndex = i;
    const m = num.exec(d);
    if (!m) return null;
    i = num.lastIndex;
    return Number(m[0]);
  };
  const readFlag = (): boolean | null => {
    skip();
    if (d[i] === '0' || d[i] === '1') return d[i++] === '1';
    return null;
  };
  const startsNumber = () => { skip(); return i < n && /[0-9+\-.]/.test(d[i]); };

  let cx = 0, cy = 0, sx = 0, sy = 0;
  // Assigned inside begin() too, so it is declared wide (TypeScript would narrow it to null otherwise).
  let cur = null as Subpath | null;
  let prevC: [number, number] | null = null; // second control point of a previous C/S
  let prevQ: [number, number] | null = null; // control point of a previous Q/T
  let errorAt: number | null = null;

  const begin = () => {
    if (!cur) {
      cur = { x0: cx, y0: cy, segs: [], closed: false };
      subpaths.push(cur);
    }
    return cur;
  };

  skip();
  if (i < n && !/[Mm]/.test(d[i])) return { subpaths, errorAt: i };
  let cmd = '';
  while (true) {
    skip();
    if (i >= n) break;
    if (/[A-Za-z]/.test(d[i])) {
      cmd = d[i++];
    } else if (!cmd || /[Zz]/.test(cmd) || !startsNumber()) {
      errorAt = i;
      break;
    } else if (cmd === 'M') {
      cmd = 'L'; // further pairs after a moveto are linetos
    } else if (cmd === 'm') {
      cmd = 'l';
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    const bad = () => { errorAt = i; };
    if (C === 'Z') {
      if (cur) { cur.closed = true; cur = null; }
      cx = sx; cy = sy;
      prevC = prevQ = null;
      continue;
    }
    if (C === 'M') {
      const x = readNumber(), y = readNumber();
      if (x === null || y === null) { bad(); break; }
      cx = ox + x; cy = oy + y; sx = cx; sy = cy;
      cur = null;
      begin();
      prevC = prevQ = null;
      continue;
    }
    const sp = begin();
    if (C === 'L' || C === 'H' || C === 'V') {
      let x = cx, y = cy;
      if (C === 'L') {
        const a = readNumber(), b = readNumber();
        if (a === null || b === null) { bad(); break; }
        x = ox + a; y = oy + b;
      } else {
        const a = readNumber();
        if (a === null) { bad(); break; }
        if (C === 'H') x = (rel ? cx : 0) + a; else y = (rel ? cy : 0) + a;
      }
      sp.segs.push({ c: 'L', x, y });
      cx = x; cy = y;
      prevC = prevQ = null;
    } else if (C === 'C' || C === 'S') {
      let x1: number, y1: number;
      if (C === 'C') {
        const a = readNumber(), b = readNumber();
        if (a === null || b === null) { bad(); break; }
        x1 = ox + a; y1 = oy + b;
      } else {
        x1 = prevC ? 2 * cx - prevC[0] : cx;
        y1 = prevC ? 2 * cy - prevC[1] : cy;
      }
      const a2 = readNumber(), b2 = readNumber(), a = readNumber(), b = readNumber();
      if (a2 === null || b2 === null || a === null || b === null) { bad(); break; }
      const seg = { c: 'C' as const, x1, y1, x2: ox + a2, y2: oy + b2, x: ox + a, y: oy + b };
      sp.segs.push(seg);
      prevC = [seg.x2, seg.y2];
      prevQ = null;
      cx = seg.x; cy = seg.y;
    } else if (C === 'Q' || C === 'T') {
      let x1: number, y1: number;
      if (C === 'Q') {
        const a = readNumber(), b = readNumber();
        if (a === null || b === null) { bad(); break; }
        x1 = ox + a; y1 = oy + b;
      } else {
        x1 = prevQ ? 2 * cx - prevQ[0] : cx;
        y1 = prevQ ? 2 * cy - prevQ[1] : cy;
      }
      const a = readNumber(), b = readNumber();
      if (a === null || b === null) { bad(); break; }
      sp.segs.push({ c: 'Q', x1, y1, x: ox + a, y: oy + b });
      prevQ = [x1, y1];
      prevC = null;
      cx = ox + a; cy = oy + b;
    } else if (C === 'A') {
      const rx = readNumber(), ry = readNumber(), phi = readNumber(), large = readFlag(), sweep = readFlag(), a = readNumber(), b = readNumber();
      if (rx === null || ry === null || phi === null || large === null || sweep === null || a === null || b === null) { bad(); break; }
      sp.segs.push({ c: 'A', rx: Math.abs(rx), ry: Math.abs(ry), phi, large, sweep, x: ox + a, y: oy + b });
      cx = ox + a; cy = oy + b;
      prevC = prevQ = null;
    } else {
      bad();
      break;
    }
  }
  return { subpaths: subpaths.filter(s => s.segs.length > 0), errorAt };
}

const num = (v: string | null | undefined, fallback = 0): number => {
  if (v === null || v === undefined || v.trim() === '') return fallback;
  const m = v.trim().match(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?:px)?$/);
  return m ? parseFloat(v) : NaN;
};

/** line, polyline, polygon, rect (rounded too), circle and ellipse as subpaths (SVG 2 §9 "equivalent path"). */
export function shapeToSubpaths(tag: string, attr: (name: string) => string | null): Subpath[] {
  switch (tag) {
    case 'line': {
      const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(a => num(attr(a)));
      if (![x1, y1, x2, y2].every(Number.isFinite)) return [];
      return [{ x0: x1, y0: y1, segs: [{ c: 'L', x: x2, y: y2 }], closed: false }];
    }
    case 'polyline':
    case 'polygon': {
      const values = (attr('points') ?? '').match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g)?.map(Number) ?? [];
      if (values.length < 4) return [];
      const segs: Seg[] = [];
      for (let k = 2; k + 1 < values.length; k += 2) segs.push({ c: 'L', x: values[k], y: values[k + 1] });
      return [{ x0: values[0], y0: values[1], segs, closed: tag === 'polygon' }];
    }
    case 'rect': {
      const x = num(attr('x')), y = num(attr('y')), w = num(attr('width')), h = num(attr('height'));
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return [];
      let rx = num(attr('rx'), NaN), ry = num(attr('ry'), NaN);
      if (!Number.isFinite(rx) && Number.isFinite(ry)) rx = ry;
      if (!Number.isFinite(ry) && Number.isFinite(rx)) ry = rx;
      rx = Math.min(Math.max(rx || 0, 0), w / 2);
      ry = Math.min(Math.max(ry || 0, 0), h / 2);
      if (rx === 0 || ry === 0) {
        return [{ x0: x, y0: y, segs: [{ c: 'L', x: x + w, y }, { c: 'L', x: x + w, y: y + h }, { c: 'L', x, y: y + h }], closed: true }];
      }
      const arc = (ex: number, ey: number): Seg => ({ c: 'A', rx, ry, phi: 0, large: false, sweep: true, x: ex, y: ey });
      return [{
        x0: x + rx, y0: y, closed: true, segs: [
          { c: 'L', x: x + w - rx, y }, arc(x + w, y + ry),
          { c: 'L', x: x + w, y: y + h - ry }, arc(x + w - rx, y + h),
          { c: 'L', x: x + rx, y: y + h }, arc(x, y + h - ry),
          { c: 'L', x, y: y + ry }, arc(x + rx, y),
        ],
      }];
    }
    case 'circle':
    case 'ellipse': {
      const cx = num(attr('cx')), cy = num(attr('cy'));
      const rx = tag === 'circle' ? num(attr('r')) : num(attr('rx'), NaN);
      let ry = tag === 'circle' ? rx : num(attr('ry'), NaN);
      const rxx = Number.isFinite(rx) ? rx : ry;
      ry = Number.isFinite(ry) ? ry : rxx;
      if (![cx, cy, rxx, ry].every(Number.isFinite) || rxx <= 0 || ry <= 0) return [];
      const arc = (ex: number, ey: number): Seg => ({ c: 'A', rx: rxx, ry, phi: 0, large: false, sweep: true, x: ex, y: ey });
      return [{ x0: cx + rxx, y0: cy, closed: true, segs: [arc(cx, cy + ry), arc(cx - rxx, cy), arc(cx, cy - ry), arc(cx + rxx, cy)] }];
    }
    default:
      return [];
  }
}

type Cubic = [number, number, number, number, number, number, number, number]; // x0 y0 x1 y1 x2 y2 x3 y3

/** An elliptical arc as cubic Béziers of at most 90° each (SVG 2 implementation notes B.2.4–B.2.5). */
export function arcToCubics(x0: number, y0: number, s: Extract<Seg, { c: 'A' }>): Cubic[] {
  const { x, y, large, sweep } = s;
  let { rx, ry } = s;
  if (x0 === x && y0 === y) return [];
  if (rx === 0 || ry === 0) return [[x0, y0, x0, y0, x, y, x, y]];
  const phi = (s.phi * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const k = Math.sqrt(lambda); rx *= k; ry *= k; }
  const num2 = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num2 / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x) / 2, cy = sin * cxp + cos * cyp + (y0 + y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const parts = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const step = dt / parts, k = (4 / 3) * Math.tan(step / 4);
  const point = (t: number): Pt => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const deriv = (t: number): Pt => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const out: Cubic[] = [];
  let px = x0, py = y0;
  for (let p = 0; p < parts; p++) {
    const ta = t1 + p * step, tb = ta + step;
    const da = deriv(ta), db = deriv(tb);
    const [ex, ey] = p === parts - 1 ? [x, y] : point(tb);
    out.push([px, py, px + k * da[0], py + k * da[1], ex - k * db[0], ey - k * db[1], ex, ey]);
    px = ex; py = ey;
  }
  return out;
}

/** Every segment of a subpath as cubics (lines and quadratics elevated), in the subpath's own coordinates. */
export function subpathCubics(sp: Subpath): Cubic[] {
  const out: Cubic[] = [];
  let x = sp.x0, y = sp.y0;
  for (const s of sp.segs) {
    if (s.c === 'L') out.push([x, y, x, y, s.x, s.y, s.x, s.y]);
    else if (s.c === 'Q') out.push([x, y, x + (2 / 3) * (s.x1 - x), y + (2 / 3) * (s.y1 - y), s.x + (2 / 3) * (s.x1 - s.x), s.y + (2 / 3) * (s.y1 - s.y), s.x, s.y]);
    else if (s.c === 'C') out.push([x, y, s.x1, s.y1, s.x2, s.y2, s.x, s.y]);
    else out.push(...arcToCubics(x, y, s));
    x = s.x; y = s.y;
  }
  if (sp.closed && (x !== sp.x0 || y !== sp.y0)) out.push([x, y, x, y, sp.x0, sp.y0, sp.x0, sp.y0]);
  return out;
}

export function transformCubic(m: Affine, c: Cubic): Cubic {
  const out = [] as unknown as Cubic;
  for (let k = 0; k < 8; k += 2) {
    const [px, py] = applyPt(m, c[k], c[k + 1]);
    out[k] = px;
    out[k + 1] = py;
  }
  return out;
}

/** Points along one cubic (its start excluded) until no control point is further than tol from the chord. */
function flattenCubic(c: Cubic, tol: number, out: Pt[]): void {
  const stack: Cubic[] = [c];
  let guard = 0;
  while (stack.length) {
    const q = stack.pop()!;
    const [x0, y0, x1, y1, x2, y2, x3, y3] = q;
    const dx = x3 - x0, dy = y3 - y0, len = Math.hypot(dx, dy);
    const dist = (px: number, py: number) => (len > 0 ? Math.abs((px - x0) * dy - (py - y0) * dx) / len : Math.hypot(px - x0, py - y0));
    if ((dist(x1, y1) <= tol && dist(x2, y2) <= tol) || ++guard > 1 << 16) {
      out.push([x3, y3]);
      continue;
    }
    // de Casteljau at 1/2; push the second half first so the first comes out first.
    const ax = (x0 + x1) / 2, ay = (y0 + y1) / 2, bx = (x1 + x2) / 2, by = (y1 + y2) / 2, cx = (x2 + x3) / 2, cy = (y2 + y3) / 2;
    const abx = (ax + bx) / 2, aby = (ay + by) / 2, bcx = (bx + cx) / 2, bcy = (by + cy) / 2;
    const mx = (abx + bcx) / 2, my = (aby + bcy) / 2;
    stack.push([mx, my, bcx, bcy, cx, cy, x3, y3], [x0, y0, ax, ay, abx, aby, mx, my]);
  }
}

/** A subpath under the transform m as a polyline, flat to within tol (in the transformed units). */
export function flattenSubpath(sp: Subpath, m: Affine, tol: number): Stroke | null {
  const cubics = subpathCubics(sp).map(c => transformCubic(m, c));
  if (cubics.length === 0) return null;
  const pts: Pt[] = [[cubics[0][0], cubics[0][1]]];
  for (const c of cubics) flattenCubic(c, tol, pts);
  return { pts, closed: sp.closed };
}

/** The bounding box of every control point of the subpaths under m (it contains the curves). */
export function controlBox(items: { subpaths: Subpath[]; m: Affine }[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const item of items) {
    for (const sp of item.subpaths) {
      for (const c of subpathCubics(sp)) {
        for (let k = 0; k < 8; k += 2) {
          const [x, y] = applyPt(item.m, c[k], c[k + 1]);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }
  return { minX, minY, maxX, maxY };
}
