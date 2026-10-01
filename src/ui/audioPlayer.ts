// Playing the oscilloscope audio (spec §8): one period looped, a volume control, and the two channels
// read back by AnalyserNodes for the XY preview. The analysers sit before the volume, so the preview
// does not shrink when the sound is turned down.
import { SAMPLE_RATE, type Period } from '../export/audio.ts';

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private left: AnalyserNode | null = null;
  private right: AnalyserNode | null = null;
  private splitter: ChannelSplitterNode | null = null;
  playing = false;

  private graph(): AudioContext {
    if (this.ctx) return this.ctx;
    // 48 kHz so the 480-sample loop is played as it is, not resampled (where the device allows it).
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    } catch {
      ctx = new AudioContext();
    }
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    this.splitter = ctx.createChannelSplitter(2);
    this.left = ctx.createAnalyser();
    this.right = ctx.createAnalyser();
    this.left.fftSize = this.right.fftSize = 2048;
    this.splitter.connect(this.left, 0);
    this.splitter.connect(this.right, 1);
    return ctx;
  }

  /** Start (or switch to) a period; the previous source stops as the new one starts. */
  async play(period: Period, volume: number): Promise<void> {
    const ctx = this.graph();
    await ctx.resume();
    const buffer = ctx.createBuffer(2, period.x.length, SAMPLE_RATE);
    buffer.copyToChannel(period.x as Float32Array<ArrayBuffer>, 0);
    buffer.copyToChannel(period.y as Float32Array<ArrayBuffer>, 1);
    const next = ctx.createBufferSource();
    next.buffer = buffer;
    next.loop = true;
    next.connect(this.gain!);
    next.connect(this.splitter!);
    this.setVolume(volume);
    const when = ctx.currentTime + 0.02;
    this.source?.stop(when);
    next.start(when);
    this.source = next;
    this.playing = true;
  }

  stop(): void {
    this.source?.stop();
    this.source = null;
    this.playing = false;
  }

  setVolume(v: number): void {
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** The latest samples of both channels, into xs and ys (length ≤ 2048); false when nothing plays. */
  read(xs: Float32Array<ArrayBuffer>, ys: Float32Array<ArrayBuffer>): boolean {
    if (!this.playing || !this.left || !this.right) return false;
    this.left.getFloatTimeDomainData(xs);
    this.right.getFloatTimeDomainData(ys);
    return true;
  }
}

/** Draw x–y pairs in [-1, 1]² as an oscilloscope in XY mode would (y up). */
export function drawXY(canvas: HTMLCanvasElement, xs: ArrayLike<number>, ys: ArrayLike<number>, colors: { paper: string; trace: string; grid: string }): void {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = colors.paper;
  ctx.fillRect(0, 0, w, h);
  const s = Math.min(w, h) / 2 * 0.92;
  ctx.strokeStyle = colors.grid;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(w / 2, h / 2 - s); ctx.lineTo(w / 2, h / 2 + s);
  ctx.moveTo(w / 2 - s, h / 2); ctx.lineTo(w / 2 + s, h / 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colors.trace;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < xs.length; i++) {
    const x = w / 2 + s * xs[i], y = h / 2 - s * ys[i];
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.stroke();
}
