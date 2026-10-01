// World (math, y up) ↔ screen (CSS pixels, y down). The scale depends only on the canvas size, never
// on the drawing, so a freehand line stays where and as large as it was drawn, and the view does
// not jump when M changes.
import type { Pt } from '../core/fourier.ts';

/** World units from the centre to the nearest canvas edge: [-1, 1]² plus a margin for the circles. */
export const VIEW_HALF = 1.35;

export interface Camera {
  /** CSS pixels per world unit. */
  s: number;
  /** The world point at the screen point (ox, oy). */
  cx: number;
  cy: number;
  ox: number;
  oy: number;
}

export function makeCamera(width: number, height: number, follow: Pt | null = null, zoom = 1): Camera {
  const base = Math.min(width, height) / 2 / VIEW_HALF;
  return {
    s: follow ? base * zoom : base,
    cx: follow ? follow[0] : 0,
    cy: follow ? follow[1] : 0,
    ox: width / 2,
    oy: height / 2,
  };
}

export function toScreen(c: Camera, x: number, y: number): Pt {
  return [c.ox + c.s * (x - c.cx), c.oy - c.s * (y - c.cy)];
}

export function toWorld(c: Camera, sx: number, sy: number): Pt {
  return [c.cx + (sx - c.ox) / c.s, c.cy - (sy - c.oy) / c.s];
}
