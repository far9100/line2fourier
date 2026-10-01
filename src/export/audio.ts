// Oscilloscope audio (spec §8): left = x(t), right = y(t), one cycle per period of the base frequency
// f0. A term turning k times per cycle becomes a tone of |k|·f0 Hz, so terms at or above half the
// sample rate cannot be played and are left out (and counted). The centre c_0 is left out too: a
// constant offset is no use to a speaker or a scope (DECISIONS.md D35).
import type { Term } from '../core/fourier.ts';

export const SAMPLE_RATE = 48000;
/** Base frequencies that divide 48 000, so a period is a whole number of samples and loops exactly. */
export const F0_CHOICES = [50, 60, 75, 80, 100, 120, 150, 200, 240, 300, 400];
export const DEFAULT_F0 = 100;
export const WAV_SECONDS = 10;
export const PEAK = 0.9;

export interface Period {
  /** One period of each channel, scaled so the larger peak is PEAK. */
  x: Float32Array;
  y: Float32Array;
  kept: number;
  dropped: number;
  /** Share of the energy of the M terms that was left out for being too high. */
  droppedEnergy: number;
}

export function synthesizePeriod(terms: Term[], M: number, f0: number, fs = SAMPLE_RATE): Period {
  const P = fs / f0;
  if (!Number.isInteger(P)) throw new Error('f0 must divide the sample rate');
  const use = terms.slice(0, M);
  const kept = use.filter(c => Math.abs(c.k) * f0 < fs / 2);
  let all = 0, lost = 0;
  for (const c of use) all += c.amp * c.amp;
  for (const c of use) if (Math.abs(c.k) * f0 >= fs / 2) lost += c.amp * c.amp;
  const x = new Float64Array(P), y = new Float64Array(P);
  for (const c of kept) {
    const w = (2 * Math.PI * c.k) / P;
    for (let n = 0; n < P; n++) {
      const a = w * n + c.phase;
      x[n] += c.amp * Math.cos(a);
      y[n] += c.amp * Math.sin(a);
    }
  }
  let peak = 0;
  for (let n = 0; n < P; n++) peak = Math.max(peak, Math.abs(x[n]), Math.abs(y[n]));
  const scale = peak > 0 ? PEAK / peak : 0;
  return {
    x: Float32Array.from(x, v => v * scale),
    y: Float32Array.from(y, v => v * scale),
    kept: kept.length,
    dropped: use.length - kept.length,
    droppedEnergy: all > 0 ? lost / all : 0,
  };
}

/** 16-bit PCM stereo WAV of `periods` repetitions of one period. */
export function encodeWav(x: Float32Array, y: Float32Array, periods: number, fs = SAMPLE_RATE): ArrayBuffer {
  const frames = x.length * periods;
  const buffer = new ArrayBuffer(44 + 4 * frames);
  const v = new DataView(buffer);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  v.setUint32(4, 36 + 4 * frames, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 2, true); // channels
  v.setUint32(24, fs, true);
  v.setUint32(28, fs * 4, true); // bytes per second
  v.setUint16(32, 4, true); // bytes per frame
  v.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  v.setUint32(40, 4 * frames, true);
  const q = (s: number) => Math.round(Math.max(-1, Math.min(1, s)) * 32767);
  for (let f = 0, n = 0; f < frames; f++, n = n + 1 === x.length ? 0 : n + 1) {
    v.setInt16(44 + 4 * f, q(x[n]), true);
    v.setInt16(46 + 4 * f, q(y[n]), true);
  }
  return buffer;
}
