// The non-linear scales of the controls (spec §3): circle counts, demo steps, speeds and sample counts.

export const N_CHOICES = [512, 1024, 2048, 4096, 8192] as const;
export type NSize = (typeof N_CHOICES)[number];
export const DEFAULT_N: NSize = 1024;
export const DEFAULT_M = 50;

const M_BASE = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 300, 500, 1000, 1500, 2000, 3000, 5000];

/** The circle-count ticks for N samples: the spec's scale below N − 1, then N − 1 itself (all circles). */
export function mTicks(N: number): number[] {
  return M_BASE.filter(m => m < N - 1).concat(N - 1);
}

/** M is a whole number of circles between 1 and N − 1 (spec §13). */
export function clampM(M: number, N: number): number {
  if (!Number.isFinite(M)) return 1;
  return Math.min(N - 1, Math.max(1, Math.round(M)));
}

/** The index of the largest tick ≤ M: where the slider's thumb sits when M is between ticks. */
export function sliderIndex(M: number, ticks: number[]): number {
  let i = 0;
  while (i + 1 < ticks.length && ticks[i + 1] <= M) i++;
  return i;
}

/** One step of the ← / → keys: to the next tick in that direction, or by one circle when `fine` (Shift). */
export function stepM(M: number, N: number, dir: 1 | -1, fine = false): number {
  if (fine) return clampM(M + dir, N);
  const ticks = mTicks(N);
  const next = dir > 0 ? ticks.find(m => m > M) : [...ticks].reverse().find(m => m < M);
  return next ?? clampM(M, N);
}

/** "示範收斂": these circle counts in turn, one cycle each (limited to N − 1, without repeats). */
export const DEMO_STEPS = [1, 2, 3, 5, 10, 20, 50, 100, 300, 1000];
export const DEMO_CYCLE_SECONDS = 3.5;

export function demoSequence(N: number): number[] {
  return [...new Set(DEMO_STEPS.map(m => Math.min(m, N - 1)))];
}

export const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
export const CYCLE_SECONDS = 8;

/**
 * N for an imported drawing: the smallest power of two that puts samples at most 0.01 apart
 * (0.5% of the long side, which is 2 after normalizing), between 1024 and 8192.
 * `length` is the path length in normalized units, jumps included.
 */
export function autoN(length: number): NSize {
  for (const N of N_CHOICES) if (N >= 1024 && length / N <= 0.01) return N;
  return 8192;
}

/**
 * M for an imported drawing: the smallest tick whose RMS error, sqrt(dropped[M]) from energyTable,
 * is at most `tol` (default 0.005: a quarter of a percent of the long side, which is 2).
 */
export function suggestM(dropped: Float64Array, N: number, tol = 0.005): number {
  for (const M of mTicks(N)) if (Math.sqrt(dropped[M]) <= tol) return M;
  return N - 1;
}
