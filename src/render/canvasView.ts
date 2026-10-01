// The main canvas: keeps its backing store at the device pixel ratio and its size in step with the
// layout, holds the viewer's zoom and position, and turns client coordinates into world
// coordinates for freehand drawing.
import type { Pt } from '../core/fourier.ts';
import type { BBox } from '../core/path.ts';
import { UNIT_BOX, ZOOM_RANGE, cameraFor, fitScale, toScreen, toWorld, zoomAbout, type Camera } from './camera.ts';
import { drawFrame, type FrameOptions, type FrameStats, type Scene } from './scene.ts';
import { readStyle, type Style } from './theme.ts';

export class CanvasView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  width = 0;
  height = 0;
  dpr = 1;
  style: Style;
  scene: Scene | null = null;
  last: FrameStats | null = null;
  lastCamera: Camera | null = null;
  /** The drawing's bounding box: zoom 1 shows all of it. */
  box: BBox = UNIT_BOX;
  /** The viewer's zoom, and the world point in the middle of the canvas (null: the box's centre). */
  zoom = 1;
  center: Pt | null = null;

  constructor(canvas: HTMLCanvasElement, onResize: () => void) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.style = readStyle();
    this.resize();
    new ResizeObserver(() => { if (this.resize()) onResize(); }).observe(canvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      this.style = readStyle();
      onResize();
    });
  }

  /** Match the backing store to the element; true when anything changed. */
  resize(): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
    if (w === this.width && h === this.height && dpr === this.dpr) return false;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    return true;
  }

  /** The viewer's own view: the whole drawing, zoomed and moved as they left it. */
  freeCamera(): Camera {
    return cameraFor(this.width, this.height, this.box, this.zoom, this.center);
  }

  /** The view that keeps the pen in the middle, `zoom` times the whole drawing. */
  followCamera(tip: Pt, zoom: number): Camera {
    return cameraFor(this.width, this.height, this.box, zoom, tip);
  }

  /** Show a new drawing whole. */
  fitTo(box: BBox): void {
    this.box = box;
    this.fit();
  }

  fit(): void {
    this.zoom = 1;
    this.center = null;
  }

  /** Zoom the free view by `factor` about the canvas point (sx, sy), within ZOOM_RANGE. */
  zoomBy(factor: number, sx = this.width / 2, sy = this.height / 2): void {
    const target = Math.min(ZOOM_RANGE.max, Math.max(ZOOM_RANGE.min, this.zoom * factor));
    const c = zoomAbout(this.freeCamera(), target / this.zoom, sx, sy);
    this.zoom = target;
    this.center = [c.cx, c.cy];
  }

  /** Move the free view by (dx, dy) CSS pixels, the drawing following the pointer. */
  panBy(dx: number, dy: number): void {
    const c = this.freeCamera();
    this.center = [c.cx - dx / c.s, c.cy + dy / c.s];
  }

  /** Start the free view where a camera is (after following the pen, say). */
  takeView(c: Camera): void {
    this.zoom = c.s / fitScale(this.width, this.height, this.box);
    this.center = [c.cx, c.cy];
  }

  worldFromClient(clientX: number, clientY: number): Pt {
    const rect = this.canvas.getBoundingClientRect();
    return toWorld(this.lastCamera ?? this.freeCamera(), clientX - rect.left, clientY - rect.top);
  }

  screenOf(p: Pt): Pt {
    return toScreen(this.lastCamera ?? this.freeCamera(), p[0], p[1]);
  }

  render(o: Omit<FrameOptions, 'width' | 'height' | 'dpr' | 'style'>): FrameStats {
    this.lastCamera = o.camera;
    this.last = drawFrame(this.ctx, this.scene, { ...o, width: this.width, height: this.height, dpr: this.dpr, style: this.style });
    return this.last;
  }
}
