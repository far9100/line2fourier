// The main canvas: keeps its backing store at the device pixel ratio and its size in step with the
// layout, and turns client coordinates into world coordinates for freehand drawing.
import type { Pt } from '../core/fourier.ts';
import { makeCamera, toScreen, toWorld, type Camera } from './camera.ts';
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

  /** The fixed camera (no follow): freehand points are stored in its world units. */
  baseCamera(): Camera {
    return makeCamera(this.width, this.height);
  }

  camera(follow: Pt | null, zoom: number): Camera {
    return makeCamera(this.width, this.height, follow, zoom);
  }

  worldFromClient(clientX: number, clientY: number): Pt {
    const rect = this.canvas.getBoundingClientRect();
    return toWorld(this.baseCamera(), clientX - rect.left, clientY - rect.top);
  }

  screenOf(p: Pt): Pt {
    return toScreen(this.lastCamera ?? this.baseCamera(), p[0], p[1]);
  }

  render(o: Omit<FrameOptions, 'width' | 'height' | 'dpr' | 'style'>): FrameStats {
    this.lastCamera = o.camera;
    this.last = drawFrame(this.ctx, this.scene, { ...o, width: this.width, height: this.height, dpr: this.dpr, style: this.style });
    return this.last;
  }
}
