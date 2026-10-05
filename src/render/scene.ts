// One frame on a 2D canvas (spec §6 "主畫布"; colours DECISIONS.md D45): the original, faint and
// dashed, when asked for; the full approximation after the first cycle, faint; the trail of this
// cycle up to the pen, black, with its pen-up moves grey and thin (D44); the circles and their links
// in a pale blue; c_0 as a fixed link from the origin; and the pen. Everything is drawn in world
// units under one transform; line widths and dashes are divided by the scale so they stay in pixels,
// except the pen that paints areas, which is as wide as the drawing says (D42).
import type { Computed } from '../app/pipeline.ts';
import { chainInto, type Pt } from '../core/fourier.ts';
import { AGAIN, CLOSURE, FILL, JUMP } from '../core/path.ts';
import type { Camera } from './camera.ts';
import { kindAt, traceCurve, type CurveEvents } from './curve.ts';
import type { Style } from './theme.ts';

/** Circles smaller than this on screen are not drawn, but still turn (spec §3). */
export const MIN_CIRCLE_PX = 0.8;

export interface Scene {
  computed: Computed;
  events: CurveEvents;
  originalInk: Path2D;
  originalClosure: Path2D;
  originalFill: Path2D;
  fullInk: Path2D;
  fullClosure: Path2D;
  fullFill: Path2D;
  joints: Float64Array;
}

export function buildScene(computed: Computed, events: CurveEvents): Scene {
  const originalInk = new Path2D(), originalClosure = new Path2D(), originalFill = new Path2D();
  const { poly, kinds } = computed.path;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const kind = kinds[i];
    if (kind === JUMP || kind === AGAIN) continue; // not drawn: a pen-up move, or a line that is there already
    const target = kind === CLOSURE ? originalClosure : kind === FILL ? originalFill : originalInk;
    const a = poly[i], b = poly[(i + 1) % n];
    if (i === 0 || kinds[i - 1] !== kind) target.moveTo(a[0], a[1]);
    target.lineTo(b[0], b[1]);
  }
  const fullInk = new Path2D(), fullClosure = new Path2D(), fullFill = new Path2D();
  traceCurve(events, 1, null, fullInk, fullClosure, fullFill);
  return {
    computed, events, originalInk, originalClosure, originalFill, fullInk, fullClosure, fullFill,
    joints: new Float64Array(2 * computed.M + 2),
  };
}

export interface FrameOptions {
  t: number;
  width: number;
  height: number;
  dpr: number;
  camera: Camera;
  style: Style;
  showCircles: boolean;
  showOriginal: boolean;
  /** The pen-up moves of the trail, grey. */
  showJumps: boolean;
  /** The faint full approximation, after the first cycle. */
  showFull: boolean;
  /** A freehand stroke being drawn, in world units; the epicycles are hidden meanwhile. */
  draft: Pt[] | null;
  /** The k picked in the spectrum: its circle is marked even when it is smaller than MIN_CIRCLE_PX. */
  highlightK: number | null;
}

export interface FrameStats {
  tip: Pt;
  penUp: boolean;
  /** Circles actually drawn: the ones at least MIN_CIRCLE_PX across and on screen. */
  circlesDrawn: number;
  /** The marked circle, in world units, and its place in the chain. */
  highlight: { x: number; y: number; r: number; j: number } | null;
}

/** Line widths in CSS pixels. */
const WIDTH = { trail: 1.6, jump: 1, full: 1.25, original: 1.25, machine: 1 };

export function drawFrame(ctx: CanvasRenderingContext2D, scene: Scene | null, o: FrameOptions): FrameStats {
  const { camera: cam, style, dpr } = o;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.fillStyle = style.canvas;
  ctx.fillRect(0, 0, o.width, o.height);

  const s = cam.s, px = 1 / s;
  ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * (cam.ox - s * cam.cx), dpr * (cam.oy + s * cam.cy));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const stats: FrameStats = { tip: [0, 0], penUp: false, circlesDrawn: 0, highlight: null };
  // Painted areas: as wide as the drawing says, never thinner than a line.
  const fillWidth = scene ? Math.max(scene.events.fillWidth, WIDTH.trail * px) : 0;
  const painted = !!scene && scene.events.fillWidth > 0;

  if (scene && o.showOriginal) {
    ctx.strokeStyle = style.orbit;
    if (painted) {
      ctx.globalAlpha = 0.2;
      ctx.lineWidth = fillWidth;
      ctx.stroke(scene.originalFill);
    }
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = WIDTH.original * px;
    ctx.setLineDash([4 * px, 3 * px]);
    ctx.stroke(scene.originalInk);
    ctx.setLineDash([1.5 * px, 4.5 * px]);
    ctx.stroke(scene.originalClosure);
    ctx.setLineDash([]);
  }

  if (scene && !o.draft) {
    const c = scene.computed, { c0, terms } = c.ordered, M = c.M;
    const joints = scene.joints;
    chainInto(c0, terms, M, o.t, joints);
    const tip: Pt = [joints[2 * M], joints[2 * M + 1]];
    stats.tip = tip;
    stats.penUp = kindAt(c.spans, o.t) === JUMP;

    ctx.strokeStyle = style.drawing;
    if (o.showFull) {
      ctx.globalAlpha = 0.14;
      if (painted) {
        ctx.lineWidth = fillWidth;
        ctx.stroke(scene.fullFill);
      }
      ctx.lineWidth = WIDTH.full * px;
      ctx.stroke(scene.fullInk);
      ctx.setLineDash([6 * px, 4 * px]);
      ctx.stroke(scene.fullClosure);
      ctx.setLineDash([]);
    }

    const trailInk = new Path2D(), trailClosure = new Path2D(), trailFill = new Path2D(), trailJump = new Path2D();
    traceCurve(scene.events, o.t, tip, trailInk, trailClosure, trailFill, o.showJumps ? trailJump : null);
    ctx.globalAlpha = 1;
    if (o.showJumps) {
      ctx.strokeStyle = style.jump;
      ctx.lineWidth = WIDTH.jump * px;
      ctx.stroke(trailJump);
      ctx.strokeStyle = style.drawing;
    }
    if (painted) {
      ctx.lineWidth = fillWidth;
      ctx.stroke(trailFill);
    }
    ctx.lineWidth = WIDTH.trail * px;
    ctx.stroke(trailInk);
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.stroke(trailClosure);
    ctx.setLineDash([]);

    if (o.showCircles) {
      // The visible part of the world, to skip circles that are entirely off screen.
      const x0 = cam.cx - cam.ox / s, x1 = cam.cx + (o.width - cam.ox) / s;
      const y0 = cam.cy - (o.height - cam.oy) / s, y1 = cam.cy + cam.oy / s;
      const circles = new Path2D();
      for (let j = 0; j < M; j++) {
        const r = terms[j].amp;
        if (r * s < MIN_CIRCLE_PX) continue;
        const cx = joints[2 * j], cy = joints[2 * j + 1];
        if (cx + r < x0 || cx - r > x1 || cy + r < y0 || cy - r > y1) continue;
        circles.moveTo(cx + r, cy);
        circles.arc(cx, cy, r, 0, 2 * Math.PI);
        stats.circlesDrawn++;
      }
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = style.orbit;
      ctx.lineWidth = WIDTH.machine * px;
      ctx.stroke(circles);

      const links = new Path2D();
      links.moveTo(0, 0);
      for (let j = 0; j <= M; j++) links.lineTo(joints[2 * j], joints[2 * j + 1]);
      ctx.globalAlpha = 1;
      ctx.stroke(links);
      // The fixed pivot of c_0's link.
      ctx.fillStyle = style.orbit;
      ctx.beginPath();
      ctx.arc(0, 0, 2 * px, 0, 2 * Math.PI);
      ctx.fill();
    }

    if (o.highlightK !== null) {
      let j = -1;
      for (let i = 0; i < M; i++) if (terms[i].k === o.highlightK) { j = i; break; }
      if (j >= 0) {
        const x = joints[2 * j], y = joints[2 * j + 1], r = terms[j].amp;
        ctx.globalAlpha = 1;
        ctx.strokeStyle = style.select;
        ctx.lineWidth = 2 * px;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(r, 4 * px), 0, 2 * Math.PI);
        ctx.moveTo(x, y);
        ctx.lineTo(joints[2 * j + 2], joints[2 * j + 3]);
        ctx.stroke();
        stats.highlight = { x, y, r, j };
      }
    }

    // The pen: a brass dot while it draws, a ring while it is lifted.
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(tip[0], tip[1], 3.5 * px, 0, 2 * Math.PI);
    if (stats.penUp) {
      ctx.strokeStyle = style.brass;
      ctx.lineWidth = 1.5 * px;
      ctx.stroke();
    } else {
      ctx.fillStyle = style.brass;
      ctx.fill();
    }
  }

  if (o.draft && o.draft.length > 0) {
    const d = o.draft;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = style.drawing;
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.moveTo(d[0][0], d[0][1]);
    for (const p of d) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    if (d.length > 1) {
      ctx.strokeStyle = style.orbit;
      ctx.lineWidth = 1.5 * px;
      ctx.setLineDash([5 * px, 5 * px]);
      ctx.beginPath();
      ctx.moveTo(d[d.length - 1][0], d[d.length - 1][1]);
      ctx.lineTo(d[0][0], d[0][1]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  ctx.globalAlpha = 1;
  return stats;
}
