// Painting an area (DECISIONS.md D42). The epicycles draw one line, so an area of solid ink is
// painted the way a pen plotter paints: rings at s, 2s, 3s, … in from its edge, drawn with a pen 3s
// wide. Every ring overlaps its neighbours by twice what it needs to, so the painting stays solid
// when the approximation strays from the rings by about a spacing (as it does at the M picked for a
// detailed drawing); the first ring reaches half a spacing past the edge, under the outline. The
// rings of an area are joined by short hops (pen down, inside the area) into closed walks, so
// painting costs no pen lift.
//
// Coordinates are image coordinates: pixel (x, y) is the square [x, x + 1] × [y, y + 1].
import type { Pt } from './fourier.ts';
import type { Stroke } from './path.ts';
import { douglasPeucker } from './simplify.ts';

/** Ring spacing as a share of the picture's long side. */
export const FILL_SHARE = 0.0025;
/** Painting adds at most about this many long sides of path; past that the rings are spaced wider. */
export const FILL_BUDGET = 12;
/** The pen's width in ring spacings. */
export const PEN_SPACINGS = 3;

/** Ring spacing in pixels for `area` pixels to paint in a picture whose long side is `side` pixels. */
export function fillSpacing(area: number, side: number): number {
  return Math.max(1, FILL_SHARE * side, area / (FILL_BUDGET * side));
}

/** 8-connected components of the set pixels, as lists of pixel indices. */
export function regionsOf(bits: Uint8Array, w: number, h: number): Int32Array[] {
  const seen = new Uint8Array(bits.length);
  const queue = new Int32Array(bits.length);
  const out: Int32Array[] = [];
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
    out.push(queue.slice(0, tail));
  }
  return out;
}

/**
 * Euclidean distance transform (Felzenszwalb and Huttenlocher, Theory of Computing 8, 2012): for
 * every pixel of the mask, the distance from its centre to the centre of the nearest pixel that is
 * not in it; outside the image counts as not in it. Pixels not in the mask get 0.
 */
export function edt(mask: Uint8Array, w: number, h: number): Float64Array {
  const W = w + 2, H = h + 2; // one pixel of paper all round
  const far = (W + H) ** 2; // farther than any pixel can be, and still an exact integer
  const g = new Float64Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) g[(y + 1) * W + x + 1] = far;
  const n = Math.max(W, H);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  // The lower envelope of the parabolas (q - i)² + f[i], in one dimension.
  const line = (len: number) => {
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - f[v[k]] - v[k] * v[k]) / (2 * (q - v[k]));
      while (s <= z[k]) { k--; s = (f[q] + q * q - f[v[k]] - v[k] * v[k]) / (2 * (q - v[k])); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]]; }
  };
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    line(H);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x];
    line(W);
    for (let x = 0; x < W; x++) g[y * W + x] = d[x];
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) out[y * w + x] = Math.sqrt(g[(y + 1) * W + x + 1]);
  return out;
}

/**
 * The closed contours where `field` (one value per pixel centre) crosses `level`: marching squares,
 * the crossing on each cell edge found by linear interpolation. Outside the image the field is 0,
 * below every level used here, so every contour closes. Where a cell has two opposite corners
 * above the level they stay apart, unless the cell's centre (the mean of its corners) is above it.
 */
export function isolines(field: ArrayLike<number>, w: number, h: number, level: number): Pt[][] {
  const v = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : field[y * w + x]);
  const W = w + 2;
  // Grid node (x, y) is the centre of pixel (x, y). Edge 2·cell is the one from node (x, y) to
  // (x + 1, y), edge 2·cell + 1 the one to (x, y + 1), with cell = (y + 1)·W + x + 1.
  const H = (x: number, y: number) => 2 * ((y + 1) * W + (x + 1));
  const V = (x: number, y: number) => 2 * ((y + 1) * W + (x + 1)) + 1;
  const where = (k: number): Pt => {
    const cell = k >> 1, x = (cell % W) - 1, y = Math.floor(cell / W) - 1;
    const a = v(x, y), b = k & 1 ? v(x, y + 1) : v(x + 1, y);
    const t = (level - a) / (b - a);
    return k & 1 ? [x + 0.5, y + 0.5 + t] : [x + 0.5 + t, y + 0.5];
  };
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const vtl = v(x, y), vtr = v(x + 1, y), vbr = v(x + 1, y + 1), vbl = v(x, y + 1);
      const tl = vtl > level ? 1 : 0, tr = vtr > level ? 1 : 0, br = vbr > level ? 1 : 0, bl = vbl > level ? 1 : 0;
      const T = H(x, y), B = H(x, y + 1), L = V(x, y), R = V(x + 1, y);
      switch (tl * 8 + tr * 4 + br * 2 + bl) {
        case 1: case 14: link(L, B); break;
        case 2: case 13: link(B, R); break;
        case 3: case 12: link(L, R); break;
        case 4: case 11: link(T, R); break;
        case 6: case 9: link(T, B); break;
        case 7: case 8: link(T, L); break;
        case 5: // tr and bl above
          if ((vtl + vtr + vbr + vbl) / 4 > level) { link(T, L); link(B, R); } else { link(T, R); link(L, B); }
          break;
        case 10: // tl and br above
          if ((vtl + vtr + vbr + vbl) / 4 > level) { link(T, R); link(L, B); } else { link(T, L); link(B, R); }
          break;
      }
    }
  }
  const loops: Pt[][] = [];
  const done = new Set<number>();
  for (const start of [...links.keys()].sort((a, b) => a - b)) {
    if (done.has(start)) continue;
    const loop: Pt[] = [];
    let prev = -1, cur = start;
    while (!done.has(cur)) {
      done.add(cur);
      loop.push(where(cur));
      const next = links.get(cur)!.find(k => k !== prev && !done.has(k)) ?? -1;
      if (next < 0) break;
      prev = cur;
      cur = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** The pixels whose centres lie inside the closed loops, by the even-odd rule. */
export function rasterizeLoops(loops: Pt[][], w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  const xs: number[] = [];
  for (let y = 0; y < h; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        if ((a[1] <= cy) !== (b[1] <= cy)) xs.push(a[0] + ((cy - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k] - 0.5)), x1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = x0; x <= x1; x++) mask[y * w + x] = 1;
    }
  }
  return mask;
}

export interface Painted {
  /** Closed walks, each with `fill` set to the pen's width (PEN_SPACINGS × spacing). */
  strokes: Stroke[];
  /** Areas that got at least one ring. */
  areas: number;
  spacing: number;
}

/** Paint every 8-connected area of the mask with rings `s` apart and a pen 3s wide. */
export function paintAreas(mask: Uint8Array, w: number, h: number, s: number): Painted {
  const dist = edt(mask, w, h);
  const strokes: Stroke[] = [];
  let areas = 0;
  for (const region of regionsOf(mask, w, h)) {
    // The region's box with a pixel of paper all round, and in it the distance to the region's edge
    // (half a pixel less than to the nearest paper pixel's centre).
    let x0 = w, y0 = h, x1 = -1, y1 = -1, deepest = 0;
    for (const p of region) {
      const x = p % w, y = (p - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      deepest = Math.max(deepest, dist[p] - 0.5);
    }
    const levels = Math.floor(deepest / s);
    if (levels < 1) continue;
    const bx = x0 - 1, by = y0 - 1, bw = x1 - x0 + 3, bh = y1 - y0 + 3;
    const field = new Float64Array(bw * bh);
    for (const p of region) {
      const x = p % w, y = (p - x) / w;
      field[(y - by) * bw + (x - bx)] = dist[p] - 0.5;
    }
    const rings: Pt[][] = [];
    for (let k = 1; k <= levels; k++) {
      for (const loop of isolines(field, bw, bh, k * s)) rings.push(loop.map(([x, y]) => [x + bx, y + by] as Pt));
    }
    if (rings.length === 0) continue;
    areas++;
    for (const pts of joinRings(rings, s)) strokes.push({ pts, closed: true, fill: PEN_SPACINGS * s });
  }
  return { strokes, areas, spacing: s };
}

/**
 * Join the rings of one area into closed walks. Hops shorter than 2s between two rings (their
 * nearest pair of points) make a minimum spanning forest; each tree is walked depth first: every
 * ring once round, every hop down and back up. Both ends of a hop are at least s from the edge, so
 * a hop shorter than 2s stays inside the area.
 */
function joinRings(rings: Pt[][], s: number): Pt[][] {
  const reach = 2 * s;
  // Every point of every ring, on a grid of cells `reach` wide.
  const ringOf: number[] = [], indexOf: number[] = [];
  const grid = new Map<number, number[]>();
  const key = (x: number, y: number) => Math.floor(x / reach) * 1_000_003 + Math.floor(y / reach);
  rings.forEach((ring, r) => ring.forEach(([x, y], i) => {
    const id = ringOf.length, k = key(x, y);
    ringOf.push(r);
    indexOf.push(i);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(id);
  }));
  // The shortest hop between each pair of rings within reach.
  const best = new Map<number, { d: number; a: number; b: number }>();
  for (let a = 0; a < ringOf.length; a++) {
    const [x, y] = rings[ringOf[a]][indexOf[a]];
    const cx = Math.floor(x / reach), cy = Math.floor(y / reach);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const b of grid.get((cx + dx) * 1_000_003 + cy + dy) ?? []) {
        if (ringOf[b] <= ringOf[a]) continue;
        const q = rings[ringOf[b]][indexOf[b]], d = Math.hypot(x - q[0], y - q[1]);
        if (d >= reach) continue;
        const pair = ringOf[a] * rings.length + ringOf[b], old = best.get(pair);
        if (!old || d < old.d) best.set(pair, { d, a, b });
      }
    }
  }
  // Kruskal: the shortest hops that join rings not yet joined.
  const uf = rings.map((_, i) => i);
  const find = (i: number): number => { while (uf[i] !== i) { uf[i] = uf[uf[i]]; i = uf[i]; } return i; };
  const hops = [...best.values()].sort((p, q) => p.d - q.d || ringOf[p.a] - ringOf[q.a] || ringOf[p.b] - ringOf[q.b]);
  const near: { at: number; ring: number; entry: number }[][] = rings.map(() => []);
  for (const { a, b } of hops) {
    const ra = ringOf[a], rb = ringOf[b];
    if (find(ra) === find(rb)) continue;
    uf[find(ra)] = find(rb);
    near[ra].push({ at: indexOf[a], ring: rb, entry: indexOf[b] });
    near[rb].push({ at: indexOf[b], ring: ra, entry: indexOf[a] });
  }

  // Fewer points: Douglas–Peucker on every ring, keeping its first point and the ends of its hops.
  const eps = Math.min(0.75, 0.25 * s);
  const kept: Pt[][] = [], renumber: Map<number, number>[] = [];
  rings.forEach((ring, r) => {
    const forced = [...new Set([0, ...near[r].map(h => h.at)])].sort((p, q) => p - q);
    const out: Pt[] = [], map = new Map<number, number>();
    forced.forEach((from, f) => {
      const to = f + 1 < forced.length ? forced[f + 1] : ring.length;
      const piece: Pt[] = [];
      for (let i = from; i <= to; i++) piece.push(ring[i % ring.length]);
      map.set(from, out.length);
      out.push(...douglasPeucker(piece, eps).slice(0, -1));
    });
    kept.push(out);
    renumber.push(map);
  });

  // Walk each tree from its lowest-numbered ring.
  const walks: Pt[][] = [];
  const visited = new Uint8Array(rings.length);
  for (let root = 0; root < rings.length; root++) {
    if (visited[root]) continue;
    const walk: Pt[] = [kept[root][0]];
    type Frame = { ring: number; entry: number; step: number; next: number; children: { pos: number; ring: number; entry: number }[] };
    const frame = (ring: number, entry: number): Frame => {
      visited[ring] = 1;
      const n = kept[ring].length;
      const children = near[ring]
        .filter(c => !visited[c.ring])
        .map(c => ({ pos: (renumber[ring].get(c.at)! - entry + n) % n, ring: c.ring, entry: renumber[c.ring].get(c.entry)! }))
        .sort((p, q) => p.pos - q.pos || p.ring - q.ring);
      for (const c of children) visited[c.ring] = 1; // claimed here, so no other ring walks into it
      return { ring, entry, step: 0, next: 0, children };
    };
    const stack: Frame[] = [frame(root, 0)];
    while (stack.length) {
      const f = stack[stack.length - 1];
      const pts = kept[f.ring], n = pts.length;
      if (f.next < f.children.length && f.children[f.next].pos === f.step) {
        const c = f.children[f.next++];
        walk.push(kept[c.ring][c.entry]); // hop down
        stack.push(frame(c.ring, c.entry));
        continue;
      }
      if (f.step === n) {
        stack.pop();
        const up = stack[stack.length - 1];
        if (up) walk.push(kept[up.ring][(up.entry + up.step) % kept[up.ring].length]); // and back up
        continue;
      }
      f.step++;
      walk.push(pts[(f.entry + f.step) % n]);
    }
    walks.push(walk);
  }
  return walks;
}
