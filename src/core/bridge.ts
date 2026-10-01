// Strokes whose ends nearly meet are joined pen-down (DECISIONS.md D38). Line tracers leave small
// gaps where lines meet (line2func trims every stroke at a junction; thresholding breaks faint
// lines), and every gap costs a pen lift. A gap at most `eps` wide is crossed with a short drawn
// segment instead: the ends are paired nearest first, chains never close back on themselves
// through a bridge, and a chain whose two ends end up within eps is closed.
import type { Pt } from './fourier.ts';
import type { Stroke } from './path.ts';

/** The widest gap crossed, as a share of the drawing's long side. */
export const BRIDGE_SHARE = 0.005;

export interface Bridged {
  strokes: Stroke[];
  /** Gaps crossed between different strokes. */
  bridges: number;
  /** Their total length. */
  length: number;
  /** Chains closed because their own two ends met. */
  closed: number;
}

export function bridgeEnds(input: Stroke[], eps: number): Bridged {
  const n = input.length;
  if (!(eps > 0) || n === 0) return { strokes: input, bridges: 0, length: 0, closed: 0 };
  // End k belongs to stroke k >> 1: k & 1 = 0 its first point, 1 its last.
  const endPt = (k: number): Pt => { const s = input[k >> 1]; return k & 1 ? s.pts[s.pts.length - 1] : s.pts[0]; };
  const open = (k: number) => !input[k >> 1].closed && input[k >> 1].pts.length > 1;
  const cell = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / eps)},${Math.floor(y / eps)}`;
  for (let k = 0; k < 2 * n; k++) {
    if (!open(k)) continue;
    const [x, y] = endPt(k), c = key(x, y);
    (cell.get(c) ?? cell.set(c, []).get(c)!).push(k);
  }
  const pairs: [number, number, number][] = [];
  for (let a = 0; a < 2 * n; a++) {
    if (!open(a)) continue;
    const [x, y] = endPt(a), cx = Math.floor(x / eps), cy = Math.floor(y / eps);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const b of cell.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (b <= a || b >> 1 === a >> 1) continue;
        const q = endPt(b), d = Math.hypot(x - q[0], y - q[1]);
        if (d <= eps) pairs.push([d, a, b]);
      }
    }
  }
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);

  const partner = new Int32Array(2 * n).fill(-1);
  const uf = Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => { while (uf[a] !== a) { uf[a] = uf[uf[a]]; a = uf[a]; } return a; };
  let bridges = 0, length = 0;
  for (const [d, a, b] of pairs) {
    if (partner[a] >= 0 || partner[b] >= 0 || find(a >> 1) === find(b >> 1)) continue;
    partner[a] = b;
    partner[b] = a;
    uf[find(a >> 1)] = find(b >> 1);
    bridges++;
    length += d;
  }
  if (bridges === 0) {
    return closeNear(input, eps, 0);
  }

  // Walk every chain from one of its free ends, in index order (the result does not depend on chance).
  const seen = new Uint8Array(n);
  const out: Stroke[] = [];
  for (let k = 0; k < 2 * n; k++) {
    const i = k >> 1;
    if (seen[i]) continue;
    if (input[i].closed || input[i].pts.length < 2) { seen[i] = 1; out.push(input[i]); continue; }
    if (partner[k] >= 0) continue; // not a free end: the chain is entered from its other end
    const pts: Pt[] = [];
    for (let e = k; e >= 0 && !seen[e >> 1];) {
      const s = input[e >> 1];
      seen[e >> 1] = 1;
      pts.push(...(e & 1 ? s.pts.slice().reverse() : s.pts));
      e = partner[e ^ 1];
    }
    out.push({ pts, closed: false });
  }
  return closeNear(out, eps, bridges, length);
}

/** Close the open strokes whose two ends are within eps of each other. */
function closeNear(strokes: Stroke[], eps: number, bridges: number, length = 0): Bridged {
  let closed = 0;
  const out = strokes.map(s => {
    if (s.closed || s.pts.length < 3) return s;
    const a = s.pts[0], b = s.pts[s.pts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > eps) return s;
    closed++;
    return { pts: s.pts, closed: true };
  });
  return { strokes: out, bridges, length, closed };
}
