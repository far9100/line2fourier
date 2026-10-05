// Strokes → one walk over the whole drawing (spec §4.6, DECISIONS.md D46). The strokes of real line
// art do not touch, but they nearly do: not end to end, somewhere along their length. So instead
// of jumping from the end of one stroke to the start of the next, the pen
// - crosses from stroke to stroke where they are nearest (a spanning tree over nearest points):
//   pen down where the gap is at most `reach`, pen up where it is wider;
// - gets from where it is to where it has to go by walking back along lines it has drawn
//   (nothing is drawn twice), and lifts only where that would be several times as far.
// This is route inspection: every line has to be walked once, and the question is what to walk
// again. The answer here is the usual one: pair off the points where an odd number of lines meet,
// nearest first by the cheapest way between them, and walk the Euler circuit of what results
// (Wong and Takahashi 2011; Liu, Hodgins and McCann 2017). Nothing depends on time or chance, and
// distances are sums, products and square roots only, so every engine gives the same walk.
import type { Pt } from './fourier.ts';
import { AGAIN, JUMP, buildPath, kindSpans, type Stroke } from './path.ts';

/** A pen-up move costs this many times its length: the pen walks back along the drawing up to that much further instead. */
export const JUMP_FACTOR = 5;
/** A near contact the spanning tree did not need is crossed only when that saves this many times its length. */
export const SPARE_FACTOR = 3;
/** Nodes are taken along the strokes at most this share of the reach apart; strokes are joined at nodes. */
export const NODE_STEP = 0.4;
/** Steps of work (cells looked into, vertices settled) after which the search stops refining: counted, not timed. */
const MAX_WORK = 3e8;

export interface Routed {
  /** Open pieces in walking order. Consecutive pieces touch, except where the pen lifts. */
  strokes: Stroke[];
  /** Gaps of at most `reach` crossed pen down (drawn as lines), and their total length. */
  links: number;
  linkLength: number;
  /** Length walked along lines that were there already. */
  againLength: number;
  /** Pen lifts, and the length travelled with the pen up. */
  lifts: number;
  jumpLength: number;
  /** The pen-up length of the strokes chained end to start in the order given. */
  originalJumpLength: number;
  from: 'original' | 'routed';
}

export interface RouteOptions { maxWork?: number }

/** Work done so far against what is allowed. */
export interface Budget { work: number; max: number }

const hyp = (dx: number, dy: number) => Math.sqrt(dx * dx + dy * dy);

/** What the path built from these strokes, in this order, spends with the pen up and on lines walked again. */
export function walkStats(strokes: Stroke[]): { jumpLength: number; lifts: number; againLength: number } {
  const path = buildPath(strokes);
  return { jumpLength: path.lengths[JUMP], lifts: kindSpans(path, JUMP).length, againLength: path.lengths[AGAIN] };
}

/**
 * Join the strokes (cleaned; see prepareStrokes) into one walk. `reach` is the widest gap crossed
 * pen down, in the strokes' units. The walk never travels further with the pen up than the strokes
 * chained in the order given: if it would, they are returned as they are.
 */
export function routeStrokes(input: Stroke[], reach: number, opts: RouteOptions = {}): Routed {
  const original = walkStats(input);
  const asGiven = (): Routed => ({
    strokes: input, links: 0, linkLength: 0, againLength: original.againLength, lifts: original.lifts,
    jumpLength: original.jumpLength, originalJumpLength: original.jumpLength, from: 'original',
  });
  if (!(reach > 0) || (input.length === 1 && input[0].closed)) return asGiven();
  const walk = walkOver(input, reach, { work: 0, max: opts.maxWork ?? MAX_WORK });
  const routed = walkStats(walk.strokes);
  if (routed.jumpLength > original.jumpLength) return asGiven();
  return {
    strokes: walk.strokes, links: walk.links, linkLength: walk.linkLength, againLength: routed.againLength,
    lifts: routed.lifts, jumpLength: routed.jumpLength, originalJumpLength: original.jumpLength, from: 'routed',
  };
}

// ---------------------------------------------------------------- nodes

/** Points along the strokes: stroke s has nodes first[s] … first[s + 1] − 1, in walking order. */
export interface Nodes {
  X: Float64Array;
  Y: Float64Array;
  /** The stroke each node is on. */
  S: Int32Array;
  first: Int32Array;
  /** 1 at the strokes' own vertices, 0 at the nodes put between them. */
  corner: Uint8Array;
}

/** The strokes' vertices, and nodes between them so that neighbours are at most `step` apart. A closed stroke's first vertex is not repeated. */
export function layNodes(strokes: Stroke[], step: number): Nodes {
  const n = strokes.length, first = new Int32Array(n + 1);
  const xs: number[] = [], ys: number[] = [], kept: number[] = [];
  strokes.forEach((s, si) => {
    first[si] = xs.length;
    const p = s.pts, segments = s.closed ? p.length : p.length - 1;
    for (let i = 0; i < segments; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const k = Math.max(1, Math.ceil(hyp(b[0] - a[0], b[1] - a[1]) / step));
      for (let j = 0; j < k; j++) {
        xs.push(a[0] + ((b[0] - a[0]) * j) / k);
        ys.push(a[1] + ((b[1] - a[1]) * j) / k);
        kept.push(j === 0 ? 1 : 0);
      }
    }
    if (!s.closed) {
      const z = p[p.length - 1];
      xs.push(z[0]);
      ys.push(z[1]);
      kept.push(1);
    }
  });
  first[n] = xs.length;
  const S = new Int32Array(xs.length);
  for (let s = 0; s < n; s++) S.fill(s, first[s], first[s + 1]);
  return { X: Float64Array.from(xs), Y: Float64Array.from(ys), S, first, corner: Uint8Array.from(kept) };
}

// ---------------------------------------------------------------- connectors

/** A straight line between two nodes of different strokes (a < b). */
export interface Connector {
  a: number;
  b: number;
  d: number;
  /** One of the spanning tree's: it has to be crossed, or the drawing falls apart. */
  tree: boolean;
}

interface Contact { d: number; a: number; b: number }

const byLength = (p: Contact, q: Contact) => p.d - q.d || p.a - q.a || p.b - q.b;
const closer = (d: number, a: number, b: number, o: Contact | undefined) => !o || d < o.d || (d === o.d && (a < o.a || (a === o.a && b < o.b)));

/**
 * Where the pen may cross from one stroke to another, sorted by node:
 * - the spanning tree of the strokes by their nearest nodes, whatever the distance: first the
 *   pairs within reach, shortest first (Kruskal); then, while parts are still apart, every part
 *   but the largest finds its nearest outside node (Borůvka);
 * - the other pairs of strokes within reach of each other, at their nearest nodes; and for every
 *   end of an open stroke, the nearest node of each stroke within reach of it.
 */
export function connect(strokes: Stroke[], nodes: Nodes, reach: number, budget: Budget = { work: 0, max: MAX_WORK }): Connector[] {
  const { X, Y, S, first } = nodes, n = strokes.length, NN = X.length;
  const between = (a: number, b: number) => hyp(X[a] - X[b], Y[a] - Y[b]);

  // a grid over the nodes, with cells at least `reach` wide
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < NN; i++) {
    if (X[i] < minX) minX = X[i];
    if (X[i] > maxX) maxX = X[i];
    if (Y[i] < minY) minY = Y[i];
    if (Y[i] > maxY) maxY = Y[i];
  }
  const cell = Math.max(reach, Math.max(maxX - minX, maxY - minY) / 256);
  const W = Math.floor((maxX - minX) / cell) + 1, H = Math.floor((maxY - minY) / cell) + 1;
  const cellX = (i: number) => Math.floor((X[i] - minX) / cell), cellY = (i: number) => Math.floor((Y[i] - minY) / cell);
  const head = new Int32Array(W * H).fill(-1), next = new Int32Array(NN);
  for (let i = NN - 1; i >= 0; i--) {
    const c = cellY(i) * W + cellX(i);
    next[i] = head[c];
    head[c] = i;
  }
  /** Every node within the 3 × 3 cells around node a: all that can be within reach of it. */
  const around = (a: number, visit: (b: number) => void) => {
    const cx = cellX(a), cy = cellY(a);
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(H - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(W - 1, cx + 1); gx++) {
        for (let b = head[gy * W + gx]; b >= 0; b = next[b]) visit(b);
      }
    }
  };

  const found = new Map<number, Connector>();
  const add = (a: number, b: number, d: number, tree: boolean) => {
    if (a > b) [a, b] = [b, a];
    const key = a * NN + b, old = found.get(key);
    if (old) old.tree ||= tree;
    else found.set(key, { a, b, d, tree });
  };

  // the nearest pair of nodes of every two strokes within reach of each other
  const nearPairs = new Map<number, Contact>();
  for (let a = 0; a < NN; a++) {
    around(a, b => {
      if (S[b] <= S[a]) return;
      const d = between(a, b);
      if (d > reach) return;
      const key = S[a] * n + S[b];
      if (closer(d, a, b, nearPairs.get(key))) nearPairs.set(key, { d, a, b });
    });
  }
  // what the ends of open strokes are near
  for (let s = 0; s < n; s++) {
    if (strokes[s].closed) continue;
    for (const a of [first[s], first[s + 1] - 1]) {
      const nearest = new Map<number, Contact>();
      around(a, b => {
        if (S[b] === s) return;
        const d = between(a, b);
        if (d <= reach && closer(d, a, b, nearest.get(S[b]))) nearest.set(S[b], { d, a, b });
      });
      for (const c of nearest.values()) add(c.a, c.b, c.d, false);
    }
  }

  // the spanning tree
  const part = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => {
    while (part[a] !== a) {
      part[a] = part[part[a]];
      a = part[a];
    }
    return a;
  };
  let parts = n;
  const join = (c: Contact) => {
    const ra = find(S[c.a]), rb = find(S[c.b]);
    if (ra === rb) return false;
    part[ra] = rb;
    parts--;
    add(c.a, c.b, c.d, true);
    return true;
  };
  for (const c of [...nearPairs.values()].sort(byLength)) if (!join(c)) add(c.a, c.b, c.d, false);
  const rings = Math.max(W, H);
  while (parts > 1) {
    const size = new Int32Array(n);
    for (let s = 0; s < n; s++) size[find(s)] += first[s + 1] - first[s];
    let largest = -1;
    for (let s = 0; s < n; s++) if (part[s] === s && (largest < 0 || size[s] > size[largest])) largest = s;
    // what a cell holds: nothing (-1), nodes of one part (its number), or of several (-2)
    const holds = new Int32Array(W * H).fill(-1);
    for (let i = 0; i < NN; i++) {
      const c = cellY(i) * W + cellX(i), p = find(S[i]);
      holds[c] = holds[c] === -1 || holds[c] === p ? p : -2;
    }
    const best: (Contact | undefined)[] = new Array(n);
    const offer = (mine: number, a: number, b: number) => {
      const d = between(a, b), lo = Math.min(a, b), hi = Math.max(a, b);
      if (closer(d, lo, hi, best[mine])) best[mine] = { d, a: lo, b: hi };
    };
    for (let a = 0; a < NN; a++) {
      const mine = find(S[a]);
      if (mine === largest) continue;
      if (budget.work > budget.max) {
        // Out of budget: a part keeps the nearest it has found; one with nothing yet takes what is nearest to this node.
        if (!best[mine]) for (let b = 0; b < NN; b++) if (find(S[b]) !== mine) offer(mine, a, b);
        continue;
      }
      const cx = cellX(a), cy = cellY(a);
      for (let r = 0; r <= rings; r++) {
        const sofar = best[mine];
        if (sofar && (r - 1) * cell > sofar.d) break; // every node in this ring or beyond is further away than that
        for (let gy = cy - r; gy <= cy + r; gy++) {
          if (gy < 0 || gy >= H) continue;
          const whole = r === 0 || gy === cy - r || gy === cy + r; // the ring's top and bottom rows; of the others, the two end cells
          for (let gx = cx - r; gx <= cx + r; gx += whole ? 1 : 2 * r) {
            if (gx < 0 || gx >= W) continue;
            budget.work++;
            const c = gy * W + gx;
            if (holds[c] === -1 || holds[c] === mine) continue;
            for (let b = head[c]; b >= 0; b = next[b]) if (find(S[b]) !== mine) offer(mine, a, b);
          }
        }
      }
    }
    for (const c of (best.filter(Boolean) as Contact[]).sort(byLength)) join(c);
  }
  return [...found.values()].sort((p, q) => p.a - q.a || p.b - q.b);
}

// ---------------------------------------------------------------- the walk

/** An edge of the graph: a stretch of ink between two vertices of stroke `s` (positions p to q), or, with s < 0, a connector from node p to node q. */
interface Edge {
  u: number;
  v: number;
  len: number;
  /** What walking it once more costs. */
  cost: number;
  /** It has to be walked: ink, and the connectors of the spanning tree. */
  need: boolean;
  /** A connector wider than the reach: crossed pen up. */
  hop: boolean;
  s: number;
  p: number;
  q: number;
}

/** A way to pair two odd vertices: along the graph (the edges on the way), or, with way null, a new pen-up jump of length d. */
interface Offer { cost: number; u: number; v: number; way: number[] | null; d: number }

function walkOver(strokes: Stroke[], reach: number, budget: Budget): { strokes: Stroke[]; links: number; linkLength: number } {
  const n = strokes.length;
  const nodes = layNodes(strokes, NODE_STEP * reach);
  const { X, Y, first, corner } = nodes, NN = X.length;
  const between = (a: number, b: number) => hyp(X[a] - X[b], Y[a] - Y[b]);
  /** The node at position j of stroke s; a closed stroke goes round. */
  const nodeAt = (s: number, j: number) => first[s] + (strokes[s].closed ? j % (first[s + 1] - first[s]) : j);
  const connectors = connect(strokes, nodes, reach, budget);

  // ---- the graph: vertices at the ends of open strokes and wherever a connector touches a stroke
  const isVertex = new Uint8Array(NN);
  for (let s = 0; s < n; s++) {
    if (strokes[s].closed) continue;
    isVertex[first[s]] = 1;
    isVertex[first[s + 1] - 1] = 1;
  }
  for (const c of connectors) isVertex[c.a] = isVertex[c.b] = 1;
  const vertexOf = new Int32Array(NN).fill(-1), vertexNode: number[] = [];
  for (let i = 0; i < NN; i++) {
    if (!isVertex[i]) continue;
    vertexOf[i] = vertexNode.length;
    vertexNode.push(i);
  }
  const V = vertexNode.length;

  const edges: Edge[] = [];
  for (let s = 0; s < n; s++) {
    const count = first[s + 1] - first[s], keys: number[] = [];
    for (let j = 0; j < count; j++) if (isVertex[first[s] + j]) keys.push(j);
    const stretches = strokes[s].closed ? keys.length : keys.length - 1;
    for (let i = 0; i < stretches; i++) {
      const p = keys[i], q = i + 1 < keys.length ? keys[i + 1] : keys[0] + count;
      let len = 0;
      for (let j = p; j < q; j++) len += between(nodeAt(s, j), nodeAt(s, j + 1));
      edges.push({ u: vertexOf[nodeAt(s, p)], v: vertexOf[nodeAt(s, q)], len, cost: len, need: true, hop: false, s, p, q });
    }
  }
  for (const c of connectors) {
    const hop = c.d > reach;
    edges.push({
      u: vertexOf[c.a], v: vertexOf[c.b], len: c.d, cost: (hop ? JUMP_FACTOR : c.tree ? 1 : SPARE_FACTOR) * c.d,
      need: c.tree, hop, s: -1, p: c.a, q: c.b,
    });
  }

  // ---- pair the vertices where an odd number of needed edges meet: each with the one it reaches
  // most cheaply, along the graph (those edges are walked once more) or by a new pen-up jump;
  // the cheapest pairs first, and again for whoever is left
  const degree = new Int32Array(V);
  for (const e of edges) {
    if (!e.need) continue;
    degree[e.u]++;
    degree[e.v]++;
  }
  const meeting: number[][] = Array.from({ length: V }, () => []);
  edges.forEach((e, i) => {
    meeting[e.u].push(i);
    if (e.v !== e.u) meeting[e.v].push(i);
  });
  const free = new Uint8Array(V);
  let odd: number[] = [];
  for (let v = 0; v < V; v++) {
    if (degree[v] % 2 === 1) {
      free[v] = 1;
      odd.push(v);
    }
  }
  const twice = new Uint8Array(edges.length);
  const jumps: [number, number, number][] = [];
  const cheapest = new Float64Array(V), cameBy = new Int32Array(V), visit = new Int32Array(V);
  let visiting = 0;
  // a heap of (cost, vertex), least first; equal costs by vertex, so the order never depends on how it was filled
  const heapCost: number[] = [], heapVertex: number[] = [];
  const less = (p: number, q: number) => heapCost[p] < heapCost[q] || (heapCost[p] === heapCost[q] && heapVertex[p] < heapVertex[q]);
  const swap = (p: number, q: number) => {
    [heapCost[p], heapCost[q]] = [heapCost[q], heapCost[p]];
    [heapVertex[p], heapVertex[q]] = [heapVertex[q], heapVertex[p]];
  };
  const push = (c: number, v: number) => {
    let i = heapCost.length;
    heapCost.push(c);
    heapVertex.push(v);
    for (let up = (i - 1) >> 1; i > 0 && less(i, up); i = up, up = (i - 1) >> 1) swap(i, up);
  };
  const pop = (): [number, number] => {
    const top: [number, number] = [heapCost[0], heapVertex[0]];
    const lastCost = heapCost.pop()!, lastVertex = heapVertex.pop()!;
    if (heapCost.length) {
      heapCost[0] = lastCost;
      heapVertex[0] = lastVertex;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heapCost.length && less(l, m)) m = l;
        if (r < heapCost.length && less(r, m)) m = r;
        if (m === i) break;
        swap(m, i);
        i = m;
      }
    }
    return top;
  };
  /** The free vertex cheapest to reach from `from` along the graph, if that costs less than `limit`, and the edges on the way. */
  const alongGraph = (from: number, limit: number): { to: number; cost: number; way: number[] } | null => {
    visiting++;
    heapCost.length = heapVertex.length = 0;
    cheapest[from] = 0;
    visit[from] = visiting;
    push(0, from);
    while (heapCost.length) {
      const [c, v] = pop();
      if (c > cheapest[v]) continue;
      if (c >= limit) return null;
      budget.work++;
      if (v !== from && free[v]) {
        const way: number[] = [];
        for (let w = v; w !== from;) {
          const e = edges[cameBy[w]];
          way.push(cameBy[w]);
          w = e.u === w ? e.v : e.u;
        }
        return { to: v, cost: c, way };
      }
      for (const i of meeting[v]) {
        const e = edges[i], to = e.u === v ? e.v : e.u, cost = c + e.cost;
        if (visit[to] !== visiting || cost < cheapest[to]) {
          visit[to] = visiting;
          cheapest[to] = cost;
          cameBy[to] = i;
          push(cost, to);
        }
      }
    }
    return null;
  };
  while (odd.length > 0) {
    const offers: Offer[] = [];
    for (const u of odd) {
      let to = -1, d = Infinity;
      for (const v of odd) {
        if (v === u) continue;
        const dv = between(vertexNode[u], vertexNode[v]);
        if (dv < d) {
          d = dv;
          to = v;
        }
      }
      const walk = budget.work > budget.max ? null : alongGraph(u, JUMP_FACTOR * d);
      if (walk) offers.push({ cost: walk.cost, u, v: walk.to, way: walk.way, d: 0 });
      else offers.push({ cost: JUMP_FACTOR * d, u, v: to, way: null, d });
    }
    offers.sort((p, q) => p.cost - q.cost || p.u - q.u || p.v - q.v);
    for (const o of offers) {
      if (!free[o.u] || !free[o.v]) continue;
      free[o.u] = free[o.v] = 0;
      if (o.way) for (const i of o.way) twice[i] ^= 1;
      else jumps.push([o.u, o.v, o.d]);
    }
    odd = odd.filter(v => free[v]);
  }

  // ---- the Euler circuit of every edge as often as it is walked, going straight on where it can
  const walks: number[] = []; // one entry per walk of an edge: the edge's index
  edges.forEach((e, i) => {
    for (let k = (e.need ? 1 : 0) + twice[i]; k > 0; k--) walks.push(i);
  });
  for (const [u, v, d] of jumps) {
    walks.push(edges.length); // a new pen-up jump is walked once
    edges.push({ u, v, len: d, cost: JUMP_FACTOR * d, need: true, hop: true, s: -1, p: vertexNode[u], q: vertexNode[v] });
  }
  /** dir[4i + 2·end], dir[4i + 2·end + 1]: the direction in which edge i leaves the vertex at its end 0 (u) or 1 (v). */
  const dir = new Float64Array(4 * edges.length);
  edges.forEach((e, i) => {
    for (const end of [0, 1]) {
      let a: number, b: number;
      if (e.s < 0) [a, b] = end === 0 ? [e.p, e.q] : [e.q, e.p];
      else [a, b] = end === 0 ? [nodeAt(e.s, e.p), nodeAt(e.s, e.p + 1)] : [nodeAt(e.s, e.q), nodeAt(e.s, e.q - 1)];
      const dx = X[b] - X[a], dy = Y[b] - Y[a], l = hyp(dx, dy);
      dir[4 * i + 2 * end] = l > 0 ? dx / l : 0;
      dir[4 * i + 2 * end + 1] = l > 0 ? dy / l : 0;
    }
  });
  // at[v]: the ends of walks that are at v, each as 2 × walk + end
  const at: number[][] = Array.from({ length: V }, () => []);
  walks.forEach((i, w) => {
    at[edges[i].u].push(2 * w);
    at[edges[i].v].push(2 * w + 1);
  });
  const walked = new Uint8Array(walks.length), open = Int32Array.from(at, list => list.length);
  const stackVertex: number[] = [edges[walks[0]].u], stackArrival: number[] = [-1];
  const backwards: number[] = []; // arrivals (2 × walk + the end arrived at), last first
  while (stackVertex.length) {
    const v = stackVertex[stackVertex.length - 1], arrival = stackArrival[stackArrival.length - 1];
    if (open[v] === 0) {
      stackVertex.pop();
      backwards.push(stackArrival.pop()!);
      continue;
    }
    // of the walks not yet taken, the one that leaves most nearly opposite to the way back
    const back = arrival < 0 ? -1 : 4 * walks[arrival >> 1] + 2 * (arrival & 1);
    let pick = -1, least = Infinity;
    for (const leave of at[v]) {
      if (walked[leave >> 1]) continue;
      const out = 4 * walks[leave >> 1] + 2 * (leave & 1);
      const turn = back < 0 ? 0 : dir[back] * dir[out] + dir[back + 1] * dir[out + 1];
      if (turn < least) {
        least = turn;
        pick = leave;
      }
    }
    const w = pick >> 1, e = edges[walks[w]], arriveAt = 1 - (pick & 1);
    walked[w] = 1;
    open[e.u]--;
    open[e.v]--;
    stackVertex.push(arriveAt === 0 ? e.u : e.v);
    stackArrival.push(2 * w + arriveAt);
  }
  const circuit = backwards.reverse().filter(a => a >= 0);
  if (circuit.length !== walks.length) throw new Error('the walk does not cover the drawing');

  // ---- the walk as pieces, starting right after a pen lift when there is one
  let start = 0;
  for (let k = 0; k < circuit.length; k++) {
    if (edges[walks[circuit[k] >> 1]].hop) {
      start = k + 1;
      break;
    }
  }
  const drawn = new Uint8Array(edges.length);
  const pieces: Stroke[] = [];
  let piece: Stroke | null = null, links = 0, linkLength = 0;
  for (let k = 0; k < circuit.length; k++) {
    const arrival = circuit[(start + k) % circuit.length], i = walks[arrival >> 1], e = edges[i], forward = (arrival & 1) === 1;
    if (e.hop) {
      piece = null;
      continue;
    }
    const again = drawn[i] === 1;
    drawn[i] = 1;
    if (!again && e.s < 0 && e.len > 0) {
      links++;
      linkLength += e.len;
    }
    const fill = !again && e.s >= 0 ? strokes[e.s].fill : undefined;
    if (!piece || !!piece.again !== again || piece.fill !== fill) {
      piece = { pts: [], closed: false };
      if (fill) piece.fill = fill;
      if (again) piece.again = true;
      pieces.push(piece);
    }
    const pts = piece.pts;
    const put = (node: number) => {
      const last = pts[pts.length - 1];
      if (!last || last[0] !== X[node] || last[1] !== Y[node]) pts.push([X[node], Y[node]] as Pt);
    };
    if (e.s < 0) {
      put(forward ? e.p : e.q);
      put(forward ? e.q : e.p);
    } else {
      // only the stroke's own vertices and the two ends: the nodes in between lie on straight segments
      for (let t = 0; t <= e.q - e.p; t++) {
        const node = nodeAt(e.s, forward ? e.p + t : e.q - t);
        if (t === 0 || t === e.q - e.p || corner[node]) put(node);
      }
    }
  }
  return { strokes: pieces.filter(p => p.pts.length > 1), links, linkLength };
}
