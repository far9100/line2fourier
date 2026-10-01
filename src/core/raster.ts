// Line art in an image → strokes (spec §5.5): grey → Otsu threshold → Zhang–Suen thinning → the
// skeleton as a graph → Euler trails. Written from the published algorithms; coordinates are pixel
// centres with y down (the importer flips and normalizes them).
//
// Two things make the result drawable with few pen lifts (DECISIONS.md D33, D39, D40, D42):
// - areas of solid ink (dark eyes, shadows) are outlined and painted, not thinned: the skeleton of
//   a solid area is a ladder of short branches, every branch end a pen lift;
// - the thin lines are walked as Euler trails: a line goes on through a junction instead of
//   stopping there, so a stroke ends only where the drawing forces a pen lift (at its odd
//   junctions and end points, paired off nearest first).
import { fillSpacing, isolines, paintAreas, regionsOf } from './fill.ts';
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
  let removed = 0;
  for (const region of regionsOf(bits, w, h)) {
    if (region.length >= minArea) continue;
    for (const p of region) bits[p] = 0;
    removed++;
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

// ---------------------------------------------------------------- solid areas

/**
 * Chamfer (3-4) distance, in pixels, from every pixel of `from` (set to 1) to the nearest pixel
 * that is not; outside the image counts as not set.
 */
export function chamfer(from: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(from.length);
  for (let i = 0; i < d.length; i++) d[i] = from[i] ? Infinity : 0;
  const get = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!from[i]) continue;
      d[i] = Math.min(d[i], get(x - 1, y) + 3, get(x, y - 1) + 3, get(x - 1, y - 1) + 4, get(x + 1, y - 1) + 4);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!from[i]) continue;
      d[i] = Math.min(d[i], get(x + 1, y) + 3, get(x, y + 1) + 3, get(x + 1, y + 1) + 4, get(x - 1, y + 1) + 4);
    }
  }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

export interface SolidAreas {
  /** The ink that belongs to solid areas (outlined and painted, not thinned). */
  solid: Uint8Array;
  /** The typical half width of a line, in pixels. */
  halfWidth: number;
  /** Ink this far from the paper (px) or more is the core of a solid area. */
  threshold: number;
  regions: number;
}

/**
 * Areas of solid ink: where the ink is at least 2.5 times as thick as a typical line. The typical
 * half width is the median distance to the paper along the ink's ridges (pixels at least as far
 * from the paper as their neighbours on one axis); a solid area is its core grown back by the
 * threshold, within the ink, and only counts when it is at least (2·threshold)² pixels large.
 */
export function solidAreas(bits: Uint8Array, w: number, h: number): SolidAreas {
  const d = chamfer(bits, w, h);
  const ridge: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, v = d[i];
      if (!bits[i]) continue;
      const left = x > 0 ? d[i - 1] : 0, right = x < w - 1 ? d[i + 1] : 0;
      const up = y > 0 ? d[i - w] : 0, down = y < h - 1 ? d[i + w] : 0;
      if ((v >= left && v >= right) || (v >= up && v >= down)) ridge.push(v);
    }
  }
  ridge.sort((a, b) => a - b);
  const halfWidth = ridge.length ? ridge[Math.floor(ridge.length / 2)] : 1;
  const threshold = Math.max(3, 2.5 * halfWidth);
  const core = new Uint8Array(bits.length);
  for (let i = 0; i < core.length; i++) core[i] = d[i] >= threshold ? 1 : 0;
  // grow the core back to the edge of its ink: pixels of ink within `threshold` of the core
  const notCore = Uint8Array.from(core, c => 1 - c);
  const fromCore = chamfer(notCore, w, h);
  const solid = new Uint8Array(bits.length);
  for (let i = 0; i < solid.length; i++) solid[i] = bits[i] && fromCore[i] <= threshold + 1e-6 ? 1 : 0;
  let regions = 0;
  for (const region of regionsOf(solid, w, h)) {
    if (region.length >= (2 * threshold) ** 2) { regions++; continue; }
    for (const p of region) solid[p] = 0;
  }
  return { solid, halfWidth, threshold, regions };
}

/**
 * The boundaries of the set pixels as closed loops, between pixel centres (pixels that touch only
 * at a corner are kept apart), in image coordinates.
 */
export function outlines(mask: Uint8Array, w: number, h: number): Pt[][] {
  return isolines(mask, w, h, 0.5);
}

// ---------------------------------------------------------------- the skeleton as a graph

export interface SkeletonGraph {
  /** End points, junctions (side-by-side junction pixels merged) and one node per loop without either. */
  nodes: { x: number; y: number }[];
  /** Lines between nodes; a loop with no node on it starts and ends at its own node. */
  edges: { a: number; b: number; pts: Pt[]; len: number }[];
}

const lengthOf = (pts: Pt[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

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

export function skeletonGraph(sk: Uint8Array, w: number, h: number): SkeletonGraph {
  const n = sk.length, buf: number[] = [];
  const deg = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (sk[p]) deg[p] = neighbours(sk, w, h, p, buf).length;
  const isNode = (p: number) => sk[p] === 1 && deg[p] !== 2;
  // Junction pixels side by side are one junction.
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (let p = 0; p < n; p++) {
    if (!sk[p] || deg[p] < 3) continue;
    for (const q of neighbours(sk, w, h, p, buf)) if (deg[q] >= 3) parent[find(p)] = find(q);
  }
  const ids = new Map<number, number>();
  const sums: { x: number; y: number; c: number }[] = [];
  const nodeOf = (p: number) => {
    const r = find(p);
    let id = ids.get(r);
    if (id === undefined) { id = sums.length; ids.set(r, id); sums.push({ x: 0, y: 0, c: 0 }); }
    return id;
  };
  for (let p = 0; p < n; p++) {
    if (!isNode(p) || deg[p] === 0) continue;
    const s = sums[nodeOf(p)];
    s.x += (p % w) + 0.5;
    s.y += Math.floor(p / w) + 0.5;
    s.c++;
  }
  const centre = (p: number): Pt => [(p % w) + 0.5, Math.floor(p / w) + 0.5];
  const edges: SkeletonGraph['edges'] = [];
  const visited = new Uint8Array(n); // degree-2 pixels already on an edge
  const steps = new Set<number>(); // node-to-node steps already taken
  for (let s = 0; s < n; s++) {
    if (!isNode(s) || deg[s] === 0) continue;
    for (const first of neighbours(sk, w, h, s, [])) {
      if (isNode(first)) {
        if (find(first) === find(s)) continue; // inside one junction
        const key = Math.min(s, first) * n + Math.max(s, first);
        if (steps.has(key)) continue;
        steps.add(key);
        const pts = [centre(s), centre(first)];
        edges.push({ a: nodeOf(s), b: nodeOf(first), pts, len: lengthOf(pts) });
        continue;
      }
      if (visited[first]) continue;
      const path = [s, first];
      visited[first] = 1;
      let prev = s, cur = first;
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
      const pts = path.map(centre);
      edges.push({ a: nodeOf(s), b: isNode(end) ? nodeOf(end) : nodeOf(s), pts, len: lengthOf(pts) });
    }
  }
  // Loops with no end point or junction on them get a node of their own.
  for (let s = 0; s < n; s++) {
    if (!sk[s] || deg[s] !== 2 || visited[s]) continue;
    const path = [s];
    visited[s] = 1;
    let prev = -1, cur = s;
    for (;;) {
      const next = neighbours(sk, w, h, cur, buf).find(q => q !== prev && !visited[q]);
      if (next === undefined) break;
      visited[next] = 1;
      path.push(next);
      prev = cur;
      cur = next;
    }
    if (path.length < 3) continue;
    const pts = path.map(centre);
    pts.push(pts[0]);
    const id = sums.length;
    sums.push({ x: pts[0][0], y: pts[0][1], c: 1 });
    edges.push({ a: id, b: id, pts, len: lengthOf(pts) });
  }
  return { nodes: sums.map(s => ({ x: s.x / s.c, y: s.y / s.c })), edges };
}

function degrees(g: SkeletonGraph): Int32Array {
  const d = new Int32Array(g.nodes.length);
  for (const e of g.edges) { d[e.a]++; d[e.b]++; }
  return d;
}

/** Drop branches from an end point to a junction shorter than `spur` px (thinning noise), up to 3 rounds. */
export function pruneSpurs(g: SkeletonGraph, spur: number): SkeletonGraph {
  let edges = g.edges;
  for (let round = 0; round < 3; round++) {
    const d = degrees({ nodes: g.nodes, edges });
    const kept = edges.filter(e => !(e.a !== e.b && e.len < spur && ((d[e.a] === 1 && d[e.b] >= 3) || (d[e.b] === 1 && d[e.a] >= 3))));
    if (kept.length === edges.length) break;
    edges = kept;
  }
  return { nodes: g.nodes, edges };
}

/**
 * Walk the graph in as few pen-down trails as its odd vertices allow: in every connected part, the
 * odd vertices are paired nearest first by pen lifts (virtual edges), the Euler circuit of the
 * part is walked, and it is cut at the virtual edges. A part with no odd vertex is one closed trail.
 */
export function eulerTrails(g: SkeletonGraph): Stroke[] {
  const N = g.nodes.length, E = g.edges.length;
  const uf = new Int32Array(N);
  for (let i = 0; i < N; i++) uf[i] = i;
  const find = (a: number): number => { while (uf[a] !== a) { uf[a] = uf[uf[a]]; a = uf[a]; } return a; };
  for (const e of g.edges) uf[find(e.a)] = find(e.b);
  const d = degrees(g);
  const dist = (a: number, b: number) => Math.hypot(g.nodes[a].x - g.nodes[b].x, g.nodes[a].y - g.nodes[b].y);

  // Pair odd vertices within their part: candidates from a grid of nearby odd vertices, nearest first.
  const odd: number[] = [];
  for (let v = 0; v < N; v++) if (d[v] % 2 === 1) odd.push(v);
  const cellSize = 16, grid = new Map<string, number[]>();
  const cellKey = (v: number) => `${Math.floor(g.nodes[v].x / cellSize)},${Math.floor(g.nodes[v].y / cellSize)}`;
  for (const v of odd) (grid.get(cellKey(v)) ?? grid.set(cellKey(v), []).get(cellKey(v))!).push(v);
  const cand: [number, number, number][] = [];
  for (const v of odd) {
    const cx = Math.floor(g.nodes[v].x / cellSize), cy = Math.floor(g.nodes[v].y / cellSize);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const u of grid.get(`${cx + dx},${cy + dy}`) ?? []) if (u > v && find(u) === find(v)) cand.push([dist(u, v), v, u]);
    }
  }
  cand.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
  const free = new Uint8Array(N);
  for (const v of odd) free[v] = 1;
  const virtual: [number, number][] = [];
  for (const [, a, b] of cand) if (free[a] && free[b]) { free[a] = free[b] = 0; virtual.push([a, b]); }
  // Whatever is left (no partner nearby) pairs with the nearest free odd vertex of its part.
  const leftByPart = new Map<number, number[]>();
  for (const v of odd) if (free[v]) (leftByPart.get(find(v)) ?? leftByPart.set(find(v), []).get(find(v))!).push(v);
  for (const left of leftByPart.values()) {
    while (left.length > 1) {
      const a = left.shift()!;
      let best = 0;
      for (let k = 1; k < left.length; k++) if (dist(a, left[k]) < dist(a, left[best])) best = k;
      virtual.push([a, left.splice(best, 1)[0]]);
    }
  }

  // Hierholzer over every part at once; edge ids ≥ E are the virtual pen lifts.
  const ends: [number, number][] = [...g.edges.map(e => [e.a, e.b] as [number, number]), ...virtual];
  const adj: number[][] = Array.from({ length: N }, () => []);
  ends.forEach(([a, b], i) => { adj[a].push(i); if (b !== a) adj[b].push(i); else adj[a].push(i); });
  const used = new Uint8Array(ends.length), ptr = new Int32Array(N);
  const strokes: Stroke[] = [];
  const startedParts = new Set<number>();
  for (let start = 0; start < N; start++) {
    if (adj[start].length === 0 || startedParts.has(find(start))) continue;
    startedParts.add(find(start));
    const stack: { v: number; via: number }[] = [{ v: start, via: -1 }];
    const circuit: { v: number; via: number }[] = [];
    while (stack.length) {
      const top = stack[stack.length - 1];
      while (ptr[top.v] < adj[top.v].length && used[adj[top.v][ptr[top.v]]]) ptr[top.v]++;
      if (ptr[top.v] === adj[top.v].length) { circuit.push(stack.pop()!); continue; }
      const id = adj[top.v][ptr[top.v]];
      used[id] = 1;
      const [a, b] = ends[id];
      stack.push({ v: a === top.v ? b : a, via: id });
    }
    circuit.reverse();
    // Cut the circuit at its pen lifts; rotate it so that it starts right after one, if any.
    const lifts = circuit.map((c, k) => (k > 0 && c.via >= E ? k : -1)).filter(k => k >= 0);
    const order = lifts.length ? [...circuit.slice(lifts[0]), ...circuit.slice(1, lifts[0] + 1)] : circuit;
    let pts: Pt[] = [];
    const flush = (closed: boolean) => {
      if (pts.length > 1) strokes.push({ pts, closed });
      pts = [];
    };
    for (let k = 1; k < order.length; k++) {
      const id = order[k].via, from = order[k - 1].v;
      if (id >= E) { flush(false); continue; }
      const e = g.edges[id];
      // Through a junction the pen goes on: consecutive edges meet at the same junction, possibly
      // at neighbouring pixels of it, so every point is kept.
      pts.push(...(e.a === from && e.b !== from ? e.pts : e.a === e.b ? e.pts : e.pts.slice().reverse()));
    }
    flush(lifts.length === 0);
  }
  return strokes;
}

// ---------------------------------------------------------------- the whole way

export interface RasterResult {
  /** Pixel coordinates, y down. */
  strokes: Stroke[];
  w: number;
  h: number;
  inkShare: number;
  inverted: boolean;
  /** Solid areas outlined and painted in (DECISIONS.md D42). */
  filled: number;
  /** i18n key → count. */
  warnings: Record<string, number>;
}

const simplify = (s: Stroke): Stroke | null => {
  if (!s.closed) {
    const pts = douglasPeucker(s.pts, 0.75);
    return pts.length >= 2 ? { pts, closed: false } : null;
  }
  const pts = douglasPeucker([...s.pts, s.pts[0]], 0.75).slice(0, -1);
  return pts.length >= 3 ? { pts, closed: true } : null;
};

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

  // Solid areas are outlined and painted; the rest is thinned and walked as a graph.
  const fill = solidAreas(bits, w, h);
  const thin = new Uint8Array(bits.length);
  for (let i = 0; i < bits.length; i++) thin[i] = bits[i] && !fill.solid[i] ? 1 : 0;
  const graph = pruneSpurs(skeletonGraph(zhangSuen(thin, w, h), w, h), Math.max(3, 0.01 * Math.max(w, h)));
  const strokes: Stroke[] = [];
  for (const s of eulerTrails(graph)) { const t = simplify(s); if (t) strokes.push(t); }
  for (const loop of outlines(fill.solid, w, h)) { const t = simplify({ pts: loop, closed: true }); if (t) strokes.push(t); }
  let solidArea = 0;
  for (const b of fill.solid) solidArea += b;
  const painted = paintAreas(fill.solid, w, h, fillSpacing(solidArea, Math.max(w, h)));
  strokes.push(...painted.strokes);
  if (painted.areas > 0) warnings['import.filled'] = painted.areas;
  if (strokes.length > 3000) warnings['raster.photo'] = 1;
  return { strokes, w, h, inkShare, inverted, filled: painted.areas, warnings };
}
