// World (math, y up) ↔ screen (CSS pixels, y down). The view is fitted to the drawing: its bounding
// box, with a small margin, fills the canvas (DECISIONS.md D45). On top of that the viewer can zoom
// about any point and move the view, or have it follow the pen.
import type { Pt } from '../core/fourier.ts';
import type { BBox } from '../core/path.ts';

/** Space left around the drawing on every side, as a share of its long side. */
export const FIT_MARGIN = 0.04;
/** How far the free view zooms out and in, relative to the whole drawing. */
export const ZOOM_RANGE = { min: 0.5, max: 64 };
/** The box a view shows before there is a drawing: the [-1, 1]² every generated drawing fills. */
export const UNIT_BOX: BBox = { minX: -1, minY: -1, maxX: 1, maxY: 1 };

export interface Camera {
  /** CSS pixels per world unit. */
  s: number;
  /** The world point at the screen point (ox, oy). */
  cx: number;
  cy: number;
  ox: number;
  oy: number;
}

/** Pixels per world unit at which `box`, with its margin, just fits a width × height canvas. */
export function fitScale(width: number, height: number, box: BBox): number {
  const w = box.maxX - box.minX, h = box.maxY - box.minY;
  const pad = 2 * FIT_MARGIN * Math.max(w, h, 1e-9);
  return Math.min(width / (w + pad), height / (h + pad));
}

/** The camera showing `box` zoomed `zoom` times, with `center` (default: the box's centre) in the middle. */
export function cameraFor(width: number, height: number, box: BBox, zoom = 1, center: Pt | null = null): Camera {
  return {
    s: fitScale(width, height, box) * zoom,
    cx: center ? center[0] : (box.minX + box.maxX) / 2,
    cy: center ? center[1] : (box.minY + box.maxY) / 2,
    ox: width / 2,
    oy: height / 2,
  };
}

/** The same camera with its scale multiplied by `factor` and the world point under (sx, sy) kept there. */
export function zoomAbout(c: Camera, factor: number, sx: number, sy: number): Camera {
  const [wx, wy] = toWorld(c, sx, sy);
  const s = c.s * factor;
  return { ...c, s, cx: wx - (sx - c.ox) / s, cy: wy + (sy - c.oy) / s };
}

export function toScreen(c: Camera, x: number, y: number): Pt {
  return [c.ox + c.s * (x - c.cx), c.oy - c.s * (y - c.cy)];
}

export function toWorld(c: Camera, sx: number, sy: number): Pt {
  return [c.cx + (sx - c.ox) / c.s, c.cy - (sy - c.oy) / c.s];
}
