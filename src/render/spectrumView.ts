// The spectrum panel (spec §6): |c_k| for k from -K to K on a log scale, the terms in use in brass,
// the one picked in the selection colour. When there are more terms than pixel columns, each column
// shows its largest term (in use drawn over not in use), so nothing in use disappears.
import type { Term } from '../core/fourier.ts';
import type { Style } from './theme.ts';

export const DECADES = 6;

export interface SpectrumInput {
  spectrum: Term[];
  /** k of the terms in use. */
  used: Set<number>;
  selected: number | null;
  /** Show k from -K to K. */
  K: number;
}

/** The default range: every term in use visible, at least ±32, at most N/2. */
export function autoRange(used: Set<number>, N: number): number {
  let K = 32;
  for (const k of used) K = Math.max(K, Math.abs(k));
  return Math.min(K, N / 2);
}

export class SpectrumView {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** What the panel shows now (read by the end-to-end tests). */
  input: SpectrumInput | null = null;
  private width = 0;
  private height = 0;
  private dpr = 1;
  style: Style;

  constructor(canvas: HTMLCanvasElement, style: Style) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.style = style;
    new ResizeObserver(() => { this.resize(); this.draw(); }).observe(canvas);
    this.resize();
  }

  private resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.width = Math.max(1, Math.round(r.width));
    this.height = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
  }

  private readonly pad = { left: 8, right: 8, top: 8, bottom: 18 };

  private xOf(k: number, K: number): number {
    const w = this.width - this.pad.left - this.pad.right;
    return this.pad.left + ((k + K) / (2 * K)) * w;
  }

  /** The client x coordinate of k's stem. */
  clientXOf(k: number): number {
    return this.canvas.getBoundingClientRect().left + this.xOf(k, this.input?.K ?? 1);
  }

  /** The k under a client x coordinate (never 0: c_0 is not a circle), within the range shown. */
  kAt(clientX: number): number | null {
    if (!this.input) return null;
    const K = this.input.K;
    const w = this.width - this.pad.left - this.pad.right;
    const x = clientX - this.canvas.getBoundingClientRect().left;
    let k = Math.round(((x - this.pad.left) / w) * 2 * K - K);
    k = Math.max(-K, Math.min(K, k));
    if (k === 0) k = x >= this.xOf(0, K) ? 1 : -1;
    return k;
  }

  set(input: SpectrumInput): void {
    this.input = input;
    this.draw();
  }

  draw(): void {
    const ctx = this.ctx, inp = this.input, s = this.style;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!inp) return;
    const { K } = inp;
    let top = 0;
    for (const c of inp.spectrum) if (c.k !== 0 && c.amp > top) top = c.amp;
    if (!(top > 0)) return;
    const hi = Math.log10(top), lo = hi - DECADES;
    const base = this.height - this.pad.bottom;
    const yOf = (amp: number) => {
      const v = Math.max(lo, Math.log10(Math.max(amp, 1e-300)));
      return base - ((v - lo) / (hi - lo)) * (base - this.pad.top);
    };

    // Decade lines, faint.
    ctx.strokeStyle = s.orbit;
    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let d = 0; d <= DECADES; d += 2) {
      const y = Math.round(yOf(10 ** (hi - d))) + 0.5;
      ctx.moveTo(this.pad.left, y);
      ctx.lineTo(this.width - this.pad.right, y);
    }
    ctx.stroke();

    // The tallest stem per pixel column, not in use then in use.
    const columns = Math.max(1, Math.round(this.width));
    const idle = new Float64Array(columns), busy = new Float64Array(columns);
    for (const c of inp.spectrum) {
      if (c.k === 0 || Math.abs(c.k) > K) continue;
      const col = Math.min(columns - 1, Math.max(0, Math.round(this.xOf(c.k, K))));
      const table = inp.used.has(c.k) ? busy : idle;
      if (c.amp > table[col]) table[col] = c.amp;
    }
    const stems = (table: Float64Array, color: string, alpha: number) => {
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = Math.max(1, Math.min(4, (this.width / (2 * K + 1)) * 0.6));
      ctx.beginPath();
      table.forEach((amp, col) => {
        if (amp <= 0) return;
        ctx.moveTo(col + 0.5, base);
        ctx.lineTo(col + 0.5, yOf(amp));
      });
      ctx.stroke();
    };
    stems(idle, s.orbit, 0.7);
    stems(busy, s.brass, 1);

    if (inp.selected !== null && Math.abs(inp.selected) <= K) {
      const c = inp.spectrum.find(t => t.k === inp.selected);
      if (c) {
        const x = this.xOf(c.k, K), y = yOf(c.amp);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = s.select;
        ctx.fillStyle = s.select;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, base);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, 2 * Math.PI);
        ctx.fill();
      }
    }

    // k labels: -K, 0, K.
    ctx.globalAlpha = 1;
    ctx.fillStyle = s.ink;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    const label = (k: number, align: CanvasTextAlign) => {
      ctx.textAlign = align;
      ctx.fillText(String(k), this.xOf(k, K), this.height - 2);
    };
    label(-K, 'left');
    label(0, 'center');
    label(K, 'right');
  }
}
