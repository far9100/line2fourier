// Spec §4.6: the order and direction in which strokes are chained, so that the pen-up jumps between
// them are short. Nearest neighbour, then 2-opt with direction flips; closed strokes may be entered
// at any vertex. The result is never longer than the original order (M2 acceptance): 2-opt is run
// from both and the shorter wins. Budgets are counted in passes and evaluations, not in time, so the
// same strokes always give the same tour (spec §10; DECISIONS.md D26).
import type { Pt } from './fourier.ts';
import type { Stroke, TourStep } from './path.ts';

export interface Tour {
  steps: TourStep[];
  /** Total jump length, the jump back to the start included. */
  jumpLength: number;
  /** The same for the strokes in their original order and direction. */
  originalJumpLength: number;
  from: 'original' | 'optimized';
}

const d = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);

function entry(s: Stroke, st: TourStep): Pt {
  return s.closed ? s.pts[st.start] : st.reversed ? s.pts[s.pts.length - 1] : s.pts[0];
}
function exit(s: Stroke, st: TourStep): Pt {
  return s.closed ? s.pts[st.start] : st.reversed ? s.pts[0] : s.pts[s.pts.length - 1];
}

export function originalOrder(strokes: Stroke[]): TourStep[] {
  return strokes.map((_, index) => ({ index, reversed: false, start: 0 }));
}

export function jumpLengthOf(strokes: Stroke[], steps: TourStep[]): number {
  let total = 0;
  for (let i = 0; i < steps.length; i++) {
    const a = steps[i], b = steps[(i + 1) % steps.length];
    total += d(exit(strokes[a.index], a), entry(strokes[b.index], b));
  }
  return total;
}

/** For each closed stroke, the vertex nearest to both of its neighbours' ends. */
function anchorClosed(strokes: Stroke[], steps: TourStep[]): void {
  const n = steps.length;
  for (let i = 0; i < n; i++) {
    const s = strokes[steps[i].index];
    if (!s.closed || n === 1) continue;
    const prev = steps[(i - 1 + n) % n], next = steps[(i + 1) % n];
    const p = exit(strokes[prev.index], prev), q = entry(strokes[next.index], next);
    let best = steps[i].start, bestCost = Infinity;
    s.pts.forEach((v, k) => {
      const cost = d(p, v) + d(v, q);
      if (cost < bestCost) { bestCost = cost; best = k; }
    });
    steps[i] = { ...steps[i], start: best };
  }
}

function nearestNeighbour(strokes: Stroke[]): TourStep[] {
  const n = strokes.length;
  const used = new Uint8Array(n);
  const steps: TourStep[] = [{ index: 0, reversed: false, start: 0 }];
  used[0] = 1;
  let at = exit(strokes[0], steps[0]);
  // Closed strokes are entered at the nearest of up to 32 evenly spread vertices; anchorClosed refines it.
  const probes = strokes.map(s => {
    if (!s.closed) return [];
    const k = Math.max(1, Math.floor(s.pts.length / 32));
    const list: number[] = [];
    for (let v = 0; v < s.pts.length; v += k) list.push(v);
    return list;
  });
  for (let count = 1; count < n; count++) {
    let best: TourStep | null = null, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const s = strokes[i];
      if (s.closed) {
        for (const v of probes[i]) {
          const dd = d(at, s.pts[v]);
          if (dd < bestD) { bestD = dd; best = { index: i, reversed: false, start: v }; }
        }
      } else {
        const a = d(at, s.pts[0]), b = d(at, s.pts[s.pts.length - 1]);
        if (a < bestD) { bestD = a; best = { index: i, reversed: false, start: 0 }; }
        if (b < bestD) { bestD = b; best = { index: i, reversed: true, start: 0 }; }
      }
    }
    used[best!.index] = 1;
    steps.push(best!);
    at = exit(strokes[best!.index], best!);
  }
  return steps;
}

/** 2-opt on the cycle of strokes: reverse a run of steps (flipping each stroke) while that shortens the jumps. */
function twoOpt(strokes: Stroke[], start: TourStep[], budget: { passes: number; evals: number }, eps: number): TourStep[] {
  const steps = start.map(s => ({ ...s }));
  const n = steps.length;
  if (n < 3) return steps;
  const flip = (st: TourStep): TourStep => (strokes[st.index].closed ? st : { ...st, reversed: !st.reversed });
  for (let pass = 0; pass < budget.passes && budget.evals > 0; pass++) {
    let improved = false;
    for (let i = 1; i < n && budget.evals > 0; i++) {
      const before = exit(strokes[steps[i - 1].index], steps[i - 1]);
      const first = entry(strokes[steps[i].index], steps[i]);
      for (let j = i; j < n; j++) {
        budget.evals--;
        const last = exit(strokes[steps[j].index], steps[j]);
        const after = entry(strokes[steps[(j + 1) % n].index], steps[(j + 1) % n]);
        // Reversed, the run starts with the last stroke's (old) exit and ends with the first's (old) entry.
        const delta = d(before, last) + d(first, after) - d(before, first) - d(last, after);
        if (delta < -eps) {
          const run = steps.slice(i, j + 1).reverse().map(flip);
          steps.splice(i, run.length, ...run);
          improved = true;
          break; // this i's neighbours changed: go on with the next i
        }
      }
    }
    anchorClosed(strokes, steps);
    if (!improved) break;
  }
  return steps;
}

export interface TourOptions { maxPasses?: number; maxEvals?: number }

export function optimizeTour(strokes: Stroke[], opts: TourOptions = {}): Tour {
  const original = originalOrder(strokes);
  const originalJumpLength = jumpLengthOf(strokes, original);
  if (strokes.length < 2) return { steps: original, jumpLength: originalJumpLength, originalJumpLength, from: 'original' };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) for (const [x, y] of s.pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const eps = 1e-12 * Math.max(maxX - minX, maxY - minY, 1e-300);
  const maxPasses = opts.maxPasses ?? 50;
  const maxEvals = opts.maxEvals ?? 2e7;

  // 2-opt from the original order and from nearest neighbour; each gets half the budget.
  const candidates: { steps: TourStep[] }[] = [];
  const fromOriginal = original.map(s => ({ ...s }));
  anchorClosed(strokes, fromOriginal);
  candidates.push({ steps: twoOpt(strokes, fromOriginal, { passes: maxPasses, evals: maxEvals / 2 }, eps) });
  const nn = nearestNeighbour(strokes);
  anchorClosed(strokes, nn);
  candidates.push({ steps: twoOpt(strokes, nn, { passes: maxPasses, evals: maxEvals / 2 }, eps) });

  // Strictly shorter wins, so on a tie the original order is kept.
  let best = { steps: original, length: originalJumpLength };
  for (const c of candidates) {
    const length = jumpLengthOf(strokes, c.steps);
    if (length < best.length) best = { steps: c.steps, length };
  }
  return { steps: best.steps, jumpLength: best.length, originalJumpLength, from: best.steps === original ? 'original' : 'optimized' };
}

/** The strokes walked as the tour says: each in its direction (closed ones round from their start and back). */
export function applyTour(strokes: Stroke[], steps: TourStep[]): Stroke[] {
  return steps.map(st => {
    const s = strokes[st.index];
    if (!s.closed) return { closed: false, pts: st.reversed ? s.pts.slice().reverse() : s.pts.slice() };
    if (steps.length === 1) return { closed: true, pts: s.pts.slice() };
    const n = s.pts.length;
    const pts: Pt[] = [];
    for (let k = 0; k <= n; k++) pts.push(s.pts[(st.start + k) % n]);
    return { closed: false, pts };
  });
}
