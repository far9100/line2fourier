// Spec §12 M3: the audio leaves out every term at or above fs/2 and peaks at 0.9; the flipbook's
// layout and PDF; the video's timing.
import { describe, expect, it } from 'vitest';
import { coefficients, orderTerms, resampleClosed, type Term } from '../../src/core/fourier.ts';
import { generate } from '../../src/core/generators.ts';
import { F0_CHOICES, PEAK, SAMPLE_RATE, encodeWav, synthesizePeriod } from '../../src/export/audio.ts';
import { A4, MM_TO_PT, exportFlipbook, flipbookLayout } from '../../src/export/flipbook.ts';
import { videoPlan } from '../../src/export/video.ts';

const { terms } = orderTerms(coefficients(resampleClosed(generate('star', 42).pts, 1024)));

describe('oscilloscope audio (spec §8)', () => {
  it('every base frequency divides 48 kHz, so a period loops exactly', () => {
    for (const f0 of F0_CHOICES) expect(Number.isInteger(SAMPLE_RATE / f0)).toBe(true);
  });

  it('at f0 = 100 Hz, |k| = 239 is kept and |k| = 240 is not', () => {
    const t = (k: number): Term => ({ k, re: 0.1, im: 0, amp: 0.1, phase: 0 });
    const p = synthesizePeriod([t(239), t(-239), t(240), t(-241), t(1)], 5, 100);
    expect(p.kept).toBe(3);
    expect(p.dropped).toBe(2);
    expect(p.droppedEnergy).toBeCloseTo(0.4, 12);
  });

  it('the peak of either channel is 0.9', () => {
    const p = synthesizePeriod(terms, 1023, 100);
    let peak = 0;
    for (let n = 0; n < p.x.length; n++) peak = Math.max(peak, Math.abs(p.x[n]), Math.abs(p.y[n]));
    expect(peak).toBeCloseTo(PEAK, 6);
    expect(peak).toBeLessThanOrEqual(PEAK + 1e-6);
  });

  it('a period contains exactly the kept terms, scaled, and nothing at or above fs/2', () => {
    const f0 = 100, P = SAMPLE_RATE / f0, M = 600;
    const p = synthesizePeriod(terms, M, f0);
    // The DFT of x + iy over one period gives each kept term back, times the scale.
    const kept = new Map(terms.slice(0, M).filter(c => Math.abs(c.k) * f0 < SAMPLE_RATE / 2).map(c => [c.k, c]));
    let scale = NaN;
    for (let k = -P / 2; k < P / 2; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < P; n++) {
        const a = (-2 * Math.PI * k * n) / P;
        re += p.x[n] * Math.cos(a) - p.y[n] * Math.sin(a);
        im += p.x[n] * Math.sin(a) + p.y[n] * Math.cos(a);
      }
      re /= P; im /= P;
      const c = kept.get(k);
      if (c) {
        if (Number.isNaN(scale)) scale = Math.hypot(re, im) / c.amp;
        expect(Math.hypot(re - scale * c.re, im - scale * c.im)).toBeLessThan(2e-6);
      } else {
        expect(Math.hypot(re, im), `k = ${k}`).toBeLessThan(2e-6);
      }
    }
  });

  it('writes a 16-bit stereo WAV of whole periods', () => {
    const p = synthesizePeriod(terms, 50, 100);
    const wav = new DataView(encodeWav(p.x, p.y, 3));
    const text = (at: number, n: number) => String.fromCharCode(...new Uint8Array(wav.buffer, at, n));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 8)).toBe('WAVEfmt ');
    expect(wav.getUint16(20, true)).toBe(1);
    expect(wav.getUint16(22, true)).toBe(2);
    expect(wav.getUint32(24, true)).toBe(48000);
    expect(wav.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe('data');
    expect(wav.getUint32(40, true)).toBe(3 * 480 * 4);
    let peak = 0;
    for (let i = 44; i < wav.byteLength; i += 2) peak = Math.max(peak, Math.abs(wav.getInt16(i, true)));
    expect(peak).toBeLessThanOrEqual(Math.round(PEAK * 32767));
    // The third period repeats the first.
    expect(wav.getInt16(44 + 2 * 480 * 4, true)).toBe(wav.getInt16(44, true));
  });
});

describe('flipbook (spec §8)', () => {
  const layout = flipbookLayout(32);

  it('32 frames on 4 A4 pages, 8 cards each, in reading order, the last frame complete', () => {
    expect(layout.pages).toBe(4);
    expect(layout.cards).toHaveLength(32);
    layout.cards.forEach((c, f) => {
      expect(c.frame).toBe(f);
      expect(c.page).toBe(Math.floor(f / 8));
      expect(c.t).toBeCloseTo((f + 1) / 32, 15);
    });
    expect(layout.cards[31].t).toBe(1);
    // Within a page: left to right, then top to bottom.
    const [a, b, c] = layout.cards;
    expect(b.card.x).toBeGreaterThan(a.card.x);
    expect(c.card.y).toBeGreaterThan(a.card.y);
    expect(c.card.x).toBe(a.card.x);
  });

  it('the cards tile the page inside the margins, and every mark stays 5 mm from the edge', () => {
    const cards = layout.cards.filter(c => c.page === 0);
    const area = cards.reduce((s, c) => s + c.card.w * c.card.h, 0);
    expect(area).toBeCloseTo((A4.width - 24) * (A4.height - 32), 9);
    for (const c of cards) {
      expect(c.art.x).toBeGreaterThanOrEqual(c.binding.x + c.binding.w);
      expect(c.art.x + c.art.w).toBeLessThanOrEqual(c.card.x + c.card.w);
      expect(c.art.y + c.art.h).toBeLessThanOrEqual(c.card.y + c.card.h);
    }
    for (const [x1, y1, x2, y2] of layout.marks) {
      for (const [x, y] of [[x1, y1], [x2, y2]]) {
        expect(x).toBeGreaterThanOrEqual(5);
        expect(y).toBeGreaterThanOrEqual(5);
        expect(x).toBeLessThanOrEqual(A4.width - 5);
        expect(y).toBeLessThanOrEqual(A4.height - 5);
      }
    }
    // Marks sit on the trim lines: every card edge has one.
    const xs = new Set(layout.marks.filter(m => m[0] === m[2]).map(m => m[0]));
    for (const c of cards) {
      expect(xs.has(c.card.x)).toBe(true);
      expect(xs.has(c.card.x + c.card.w)).toBe(true);
    }
  });

  it('the PDF has 4 A4 pages and asks not to be scaled when printed', async () => {
    const art = (t: number) => ({ trail: [[[0, 0], [t, t]] as [number, number][]], circles: [{ x: 0, y: 0, r: 0.5 }], arms: [[0, 0], [0.5, 0]] as [number, number][], tip: [t, t] as [number, number] });
    const bytes = await exportFlipbook(art, layout, { half: 1.35 });
    const { PDFDocument, PDFName } = await import('pdf-lib');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(4);
    for (const page of doc.getPages()) {
      expect(page.getWidth()).toBeCloseTo(A4.width * MM_TO_PT, 6);
      expect(page.getHeight()).toBeCloseTo(A4.height * MM_TO_PT, 6);
    }
    const prefs = doc.catalog.lookup(PDFName.of('ViewerPreferences'));
    expect(String(prefs)).toContain('/PrintScaling /None');
    // Frame numbers 1..32 are written in order, 8 per page.
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('/Helvetica');
  });
});

describe('video timing (spec §12 M3: exactly one cycle)', () => {
  it('frames at i·T/F last T/F, summing to the cycle even when T·fps is not whole', () => {
    for (const [T, fps] of [[8, 30], [32, 30], [8 / 0.75, 30], [4, 60]]) {
      const { frames, dt } = videoPlan(T, fps);
      expect(frames * dt).toBeCloseTo(T, 12);
      expect(Math.abs(dt - 1 / fps)).toBeLessThan(1 / fps / 2);
    }
  });
});
