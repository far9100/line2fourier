// Line art in an image → strokes (spec §5.5): grey → Otsu threshold → Zhang–Suen thinning → the
// skeleton traced into polylines → Douglas–Peucker. Written from the published algorithms; the
// tracing rules (redundant diagonal links ignored, loops without ends traced too, short spurs
// dropped) follow what line2func's baseline does (DECISIONS.md D33). Coordinates are pixel
// centres with y down; the importer flips and normalizes them.
import type { Pt } from './fourier.ts';
import type { Stroke } from './path.ts';
import { douglasPeucker } from './simplify.ts';

export interface Gray { w: number; h: number; v: Uint8Array }

/**
 * Luma of an RGBA image (transparent counts as white paper), shrunk with a box filter so the long
 * side is at most maxSide. Done here rather than by the browser so every browser gets the same pixels.
 */
export function toGray(rgba: ArrayLike<number>, w: number, h: number, maxSide = 1024): Gray {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h * scale));
  const v = new Uint8Array(W * H);
  for (let Y = 0; Y < H; Y++) {
    const y0 = Math.floor((Y * h) / H), y1 = Math.max(y0 + 1, Math.floor(((Y + 1) * h) / H));
    for (let X = 0; X < W; X++) {
      const x0 = Math.floor((X * w) / W), x1 = Math.max(x0 + 1, Math.floor(((X + 1) * w) / W));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = 4 * (y * w + x), a = rgba[i + 3] / 255;
          const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          sum += luma * a + 255 * (1 - a);
          n++;
        }
      }
      v[Y * W + X] = Math.round(sum / n);
    }
  }
  return { w: W, h: H, v };
}

/** Otsu's threshold: grey levels ≤ the result are one class, the rest the other. */
export function otsu(g: Gray): number {
  const hist = new Float64Array(256);
  for (const x of g.v) hist[x]++;
  const total = g.v.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let w0 = 0, sum0 = 0, best = -1, at = 127;
  for (let t = 0; t < 255; t++) {
    w0 += hist[t];
    sum0 += t * hist[t];
    const w1 = total - w0;
    if (w0 === 0 || w1 === 0) continue;
    const m0 = sum0 / w0, m1 = (sumAll - sum0) / w1;
    const between = w0 * w1 * (m0 - m1) ** 2;
    if (between > best) { best = between; at = t; }
  }
  return at;
}

/** Ink is the darker class, unless that is most of the picture: then the lines are light on dark. */
export function binarize(g: Gray, threshold: number): { bits: Uint8Array; inverted: boolean } {
  const bits = new Uint8Array(g.v.length);
  let ink = 0;
  for (let i = 0; i < bits.length; i++) if ((bits[i] = g.v[i] <= threshold ? 1 : 0)) ink++;
  const inverted = ink > bits.length / 2;
  if (inverted) for (let i = 0; i < bits.length; i++) bits[i] ^= 1;
  return { bits, inverted };
}

/** Remove 8-connected specks smaller than minArea pixels, in place; returns how many were removed. */
export function removeSpecks(bits: Uint8Array, w: number, h: number, minArea: number): number {
  const seen = new Uint8Array(bits.length);
  const queue = new Int32Array(bits.length);
  let removed = 0;
  for (let start = 0; start < bits.length; start++) {
    if (!bits[start] || seen[start]) continue;
    let head = 0, tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (bits[q] && !seen[q]) { seen[q] = 1; queue[tail++] = q; }
        }
      }
    }
    if (tail < minArea) {
      for (let i = 0; i < tail; i++) bits[queue[i]] = 0;
      removed++;
    }
  }
  return removed;
}

/** Zhang and Suen's parallel thinning (CACM 27(3), 1984): one-pixel-wide lines. */
export function zhangSuen(input: Uint8Array, w: number, h: number): Uint8Array {
  const b = input.slice();
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : b[y * w + x]);
  const marked: number[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const step of [0, 1]) {
      marked.length = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!b[y * w + x]) continue;
          const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1);
          const p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
          const n = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (n < 2 || n > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let transitions = 0;
          for (let i = 0; i < 8; i++) if (seq[i] === 0 && seq[i + 1] === 1) transitions++;
          if (transitions !== 1) continue;
          if (step === 0 ? p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0 : p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          marked.push(y * w + x);
        }
      }
      for (const i of marked) b[i] = 0;
      if (marked.length) changed = true;
    }
  }
  return b;
}

/**
 * The skeleton's neighbours of pixel p: the 8 around it, except a diagonal one that is also reached
 * through a shared side neighbour (otherwise every staircase would look like a junction).
 */
function neighbours(sk: Uint8Array, w: number, h: number, p: number, out: number[]): number[] {
  out.length = 0;
  const x = p % w, y = (p - x) / w;
  const on = (nx: number, ny: number) => nx >= 0 && ny >= 0 && nx < w && ny < h && sk[ny * w + nx] === 1;
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) if (on(x + dx, y + dy)) out.push((y + dy) * w + x + dx);
  for (const [dx, dy] of [[1, -1], [1, 1], [-1, 1], [-1, -1]]) {
    if (on(x + dx, y + dy) && !on(x + dx, y) && !on(x, y + dy)) out.push((y + dy) * w + x + dx);
  }
  return out;
}

export interface TracedLine { pts: Pt[]; closed: boolean; endTypes: [number, number] }

/**
 * Follow the skeleton from every end point and junction to the next one; then trace what is left,
 * which can only be closed loops. endTypes holds the degree at each end (1 end point, ≥ 3 junction).
 */
export function traceSkeleton(sk: Uint8Array, w: number, h: number): TracedLine[] {
  const n = sk.length;
  const deg = new Uint8Array(n);
  const buf: number[] = [];
  for (let p = 0; p < n; p++) if (sk[p]) deg[p] = neighbours(sk, w, h, p, buf).length;
  const visited = new Uint8Array(n); // interior (degree 2) pixels already on a line
  const usedPair = new Set<number>(); // node-to-node steps already taken
  const centre = (p: number): Pt => [(p % w) + 0.5, Math.floor(p / w) + 0.5];
  const lines: TracedLine[] = [];
  const isNode = (p: number) => deg[p] !== 2;

  for (let start = 0; start < n; start++) {
    if (!sk[start] || !isNode(start) || deg[start] === 0) continue;
    for (const first of neighbours(sk, w, h, start, [])) {
      if (!isNode(first) && visited[first]) continue;
      if (isNode(first)) {
        const key = Math.min(start, first) * n + Math.max(start, first);
        if (usedPair.has(key)) continue;
        usedPair.add(key);
        if (deg[start] >= 3 && deg[first] >= 3) continue; // two junction pixels side by side: one junction
        lines.push({ pts: [centre(start), centre(first)], closed: false, endTypes: [deg[start], deg[first]] });
        continue;
      }
      const path = [start, first];
      visited[first] = 1;
      let prev = start, cur = first;
      for (;;) {
        const next = neighbours(sk, w, h, cur, buf).find(q => q !== prev && (isNode(q) || !visited[q]));
        if (next === undefined) break;
        path.push(next);
        if (isNode(next)) break;
        visited[next] = 1;
        prev = cur;
        cur = next;
      }
      const end = path[path.length - 1];
      lines.push({ pts: path.map(centre), closed: false, endTypes: [deg[start], deg[end]] });
    }
  }

  // Loops with no end point or junction on them.
  for (let start = 0; start < n; start++) {
    if (!sk[start] || deg[start] !== 2 || visited[start]) continue;
    const path = [start];
    visited[start] = 1;
    let prev = -1, cur = start;
    for (;;) {
      const next = neighbours(sk, w, h, cur, buf).find(q => q !== prev && !visited[q]);
      if (next === undefined) break;
      visited[next] = 1;
      path.push(next);
      prev = cur;
      cur = next;
    }
    if (path.length >= 3) lines.push({ pts: path.map(centre), closed: true, endTypes: [2, 2] });
  }
  return lines;
}

export interface RasterResult {
  /** Pixel coordinates, y down. */
  strokes: Stroke[];
  w: number;
  h: number;
  inkShare: number;
  inverted: boolean;
  /** i18n key → count. */
  warnings: Record<string, number>;
}

const lengthOf = (pts: Pt[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

export function rasterToStrokes(rgba: ArrayLike<number>, width: number, height: number, maxSide = 1024): RasterResult {
  const g = toGray(rgba, width, height, maxSide);
  const { w, h } = g;
  const { bits, inverted } = binarize(g, otsu(g));
  removeSpecks(bits, w, h, Math.max(4, Math.round(1e-5 * w * h)));
  let ink = 0;
  for (const b of bits) ink += b;
  const inkShare = ink / bits.length;
  const warnings: Record<string, number> = {};
  if (inverted) warnings['raster.inverted'] = 1;
  if (inkShare > 0.35) warnings['raster.photo'] = 1;

  const skeleton = zhangSuen(bits, w, h);
  const spur = Math.max(3, 0.01 * Math.max(w, h));
  const strokes: Stroke[] = [];
  for (const line of traceSkeleton(skeleton, w, h)) {
    // A short branch from an end point to a junction is thinning noise, not a line.
    const spurLike = !line.closed && line.endTypes.includes(1) && line.endTypes.some(d => d >= 3);
    if (spurLike && lengthOf(line.pts) < spur) continue;
    const pts = line.closed ? douglasPeucker([...line.pts, line.pts[0]], 0.75).slice(0, -1) : douglasPeucker(line.pts, 0.75);
    if (pts.length >= 2) strokes.push({ pts, closed: line.closed && pts.length >= 3 });
  }
  if (strokes.length > 3000) warnings['raster.photo'] = 1;
  return { strokes, w, h, inkShare, inverted, warnings };
}
