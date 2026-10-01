// The animation's time: t ∈ [0, 1) is the position within one cycle (spec §4.3).

/** Frames further apart than this (a hidden tab, a debugger pause) advance time by this much only. */
export const MAX_FRAME_MS = 100;

/** Move t on by one frame of dtMs, with one cycle lasting cycleMs. */
export function advance(t: number, dtMs: number, cycleMs: number): { t: number; wrapped: boolean } {
  const dt = Math.min(Math.max(dtMs, 0), MAX_FRAME_MS);
  const next = t + dt / cycleMs;
  if (next < 1) return { t: next, wrapped: false };
  return { t: next - Math.floor(next), wrapped: true };
}

/** How long one cycle takes: 8 s at 1× (spec §3), 3.5 s per step in the demo regardless of speed. */
export function cycleMs(speed: number, demo: boolean): number {
  return demo ? 3500 : 8000 / speed;
}
