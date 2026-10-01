import { describe, expect, it } from 'vitest';
import { chainAt, coefficients, orderTerms, partialCurve, resampleClosed, type Pt, type Term } from '../../src/core/fourier.ts';
import { generate } from '../../src/core/generators.ts';
import { CLOSURE, FILL, JUMP, buildPath, kindSpans, prepareStrokes, samplePath } from '../../src/core/path.ts';
import { SLIDER_MIN_TERMS, toDesmos, toDesmosSlider } from '../../src/export/desmos.ts';
import { toCoefficientsJson, type CoefficientsFile } from '../../src/export/json.ts';
import { toLatex, toLatexPreview } from '../../src/export/latex.ts';
import { toSvg } from '../../src/export/svg.ts';
import { curveEvents, tipAt } from '../../src/render/curve.ts';
import { parseDesmos } from '../helpers/parseDesmos.ts';

const N = 1024;
const spectrum = coefficients(resampleClosed(generate('creature', 42).pts, N));
const { c0, terms } = orderTerms(spectrum);

/** Evaluate z(t)=(a+bi)+r e^{i(2kπt+φ)}+… as written by toLatex. */
function evalLatex(latex: string): (t: number) => Pt {
  const head = latex.match(/^z\(t\)=\((-?[\d.]+)([+-])([\d.]+)i\)/);
  if (!head) throw new Error('no c0');
  const cx = Number(head[1]), cy = (head[2] === '-' ? -1 : 1) * Number(head[3]);
  const re = /\+([\d.]+)e\^\{i\((-?\d*)\\pi t([+-][\d.]+)\)\}/g;
  const parts = [...latex.slice(head[0].length).matchAll(re)].map(m => ({
    r: Number(m[1]),
    w: m[2] === '' ? 2 : m[2] === '-' ? -2 : Number(m[2]),
    phi: Number(m[3]),
  }));
  return t => {
    let x = cx, y = cy;
    for (const p of parts) {
      const a = p.w * Math.PI * t + p.phi;
      x += p.r * Math.cos(a);
      y += p.r * Math.sin(a);
    }
    return [x, y];
  };
}

describe('Desmos (spec §8)', () => {
  it('the slider version has an M line, sliced sums, and at least 300 terms in its lists', () => {
    const text = toDesmosSlider(c0, terms, 20);
    const lines = text.split('\n');
    expect(lines[0]).toBe('M=20');
    expect(lines[4]).toContain('R[1...M]\\cos(2\\pi K[1...M]t+P[1...M])');
    expect(lines[4]).toContain('R[1...M]\\sin(2\\pi K[1...M]t+P[1...M])');
    expect(lines[1].split(',')).toHaveLength(SLIDER_MIN_TERMS);
  });

  it('both versions draw the same curve as the chain, for small and large M', () => {
    for (const M of [1, 20, 300, N - 1]) {
      const plain = parseDesmos(toDesmos(c0, terms, M));
      const slider = parseDesmos(toDesmosSlider(c0, terms, M));
      for (let i = 0; i <= 200; i++) {
        const t = i / 200, tip = chainAt(c0, terms, M, t)[M];
        for (const curve of [plain, slider]) {
          const p = curve(t);
          // 5 decimals on each of M radii and phases: the error grows with M but stays far below a pixel.
          expect(Math.hypot(p[0] - tip[0], p[1] - tip[1])).toBeLessThan(M <= 300 ? 1e-3 : 5e-3);
        }
      }
    }
  });
});

describe('LaTeX (spec §8)', () => {
  it('writes c_0 and the first M terms, evaluating to the chain', () => {
    const M = 30;
    const latex = toLatex(c0, terms, M);
    expect(latex.startsWith('z(t)=(')).toBe(true);
    expect(latex.match(/e\^\{i\(/g)).toHaveLength(M);
    const z = evalLatex(latex);
    for (let i = 0; i <= 100; i++) {
      const t = i / 100, p = z(t), tip = chainAt(c0, terms, M, t)[M];
      expect(Math.hypot(p[0] - tip[0], p[1] - tip[1])).toBeLessThan(1e-3);
    }
  });

  it('writes k = ±1 as ±2πt and other k as 2k·πt', () => {
    const term = (k: number, phase: number): Term => ({ k, re: 0, im: 0, amp: 0.5, phase });
    const zero: Term = { k: 0, re: 0.25, im: -0.125, amp: 0, phase: 0 };
    expect(toLatex(zero, [term(1, 0.5), term(-1, -0.25), term(3, 0), term(-2, 1)], 4, 3))
      .toBe('z(t)=(0.250-0.125i)+0.500e^{i(2\\pi t+0.500)}+0.500e^{i(-2\\pi t-0.250)}+0.500e^{i(6\\pi t+0.000)}+0.500e^{i(-4\\pi t+1.000)}');
  });

  it('the preview shows a few terms and ⋯ when there are more', () => {
    expect(toLatexPreview(c0, terms, 3, 4).endsWith('\\cdots')).toBe(false);
    expect(toLatexPreview(c0, terms, 50, 4).endsWith('+\\cdots')).toBe(true);
    expect(toLatexPreview(c0, terms, 50, 4).match(/e\^\{i\(/g)).toHaveLength(4);
  });
});

describe('coefficients JSON (spec §8)', () => {
  it('holds every coefficient by k, the order, N, M, the source and the k in use', () => {
    const source = { type: 'random', generator: 'creature', seed: 42 };
    const file = JSON.parse(toCoefficientsJson(spectrum, terms, { M: 50, order: 'magnitude', source })) as CoefficientsFile;
    expect(file.format).toBe('line2fourier.coefficients');
    expect(file.N).toBe(N);
    expect(file.coefficients).toHaveLength(N);
    expect(file.coefficients.map(c => c.k)).toEqual(Array.from({ length: N }, (_, i) => i - N / 2));
    expect(file.used).toEqual(terms.slice(0, 50).map(c => c.k));
    expect(file.source).toEqual(source);
  });

  it('is enough to rebuild the approximation exactly', () => {
    const file = JSON.parse(toCoefficientsJson(spectrum, terms, { M: 50, order: 'magnitude', source: null })) as CoefficientsFile;
    const byK = new Map(file.coefficients.map(c => [c.k, c]));
    const re = new Float64Array(N), im = new Float64Array(N);
    for (const k of [0, ...file.used]) { const c = byK.get(k)!; re[(k + N) % N] = c.re; im[(k + N) % N] = c.im; }
    const approx = partialCurve(c0, terms, 50, N);
    // The JSON numbers are the doubles themselves, so this is the same inverse transform.
    for (let n = 0; n < N; n += 37) {
      let x = 0, y = 0;
      for (let m = 0; m < N; m++) {
        if (re[m] === 0 && im[m] === 0) continue;
        const k = m < N / 2 ? m : m - N, a = (2 * Math.PI * k * n) / N;
        x += re[m] * Math.cos(a) - im[m] * Math.sin(a);
        y += re[m] * Math.sin(a) + im[m] * Math.cos(a);
      }
      expect(Math.hypot(x - approx[n][0], y - approx[n][1])).toBeLessThan(1e-12);
    }
  });
});

describe('SVG (spec §8)', () => {
  function svgFor(strokes: Parameters<typeof buildPath>[0], M: number, widthMm = 120) {
    const path = buildPath(prepareStrokes(strokes));
    const spans = { jump: kindSpans(path, JUMP), closure: kindSpans(path, CLOSURE), fill: kindSpans(path, FILL) };
    const s = samplePath(path, N);
    const o = orderTerms(coefficients(s.pts));
    const approx = partialCurve(o.c0, o.terms, M, N);
    const ev = curveEvents(approx, spans, t => tipAt(o.c0, o.terms, M, t), path.fillWidth);
    return toSvg(ev, { widthMm, strokeMm: 0.3 });
  }

  it('is one path in millimetres with the requested width', () => {
    const svg = svgFor([generate('star', 7)], 100);
    expect(svg).toMatch(/<svg [^>]*width="120\.0000mm"/);
    expect(svg).toMatch(/height="[\d.]+mm"/);
    expect(svg.match(/<path /g)).toHaveLength(1);
    const d = svg.match(/ d="([^"]+)"/)![1];
    expect(d.startsWith('M')).toBe(true);
    expect(d.match(/M/g)).toHaveLength(1); // one closed stroke: the pen never lifts
  });

  it('lifts the pen for every jump between strokes', () => {
    const strokes = [
      { pts: [[0, 0], [1, 0], [1, 1]] as Pt[], closed: false },
      { pts: [[3, 0], [4, 1]] as Pt[], closed: false },
      { pts: [[0, 3], [1, 4], [2, 3]] as Pt[], closed: false },
    ];
    const d = svgFor(strokes, N - 1).match(/ d="([^"]+)"/)![1];
    expect(d.match(/M/g)).toHaveLength(3);
  });

  it('a painted area is a second path, under the lines, drawn with the wide pen (D42)', () => {
    const strokes = [
      { pts: [[0, 0], [4, 0], [4, 4], [0, 4]] as Pt[], closed: true },
      { pts: [[1, 1], [3, 1], [3, 3], [1, 3]] as Pt[], closed: true, fill: 0.5 },
    ];
    const svg = svgFor(strokes, N - 1);
    const widths = [...svg.matchAll(/<path [^>]*stroke-width="([\d.]+)"/g)].map(m => Number(m[1]));
    expect(widths).toHaveLength(2);
    expect(widths[0]).toBeCloseTo(0.5, 4); // the painted area first, so the lines stay on top
    expect(widths[1]).toBeLessThan(0.5);
  });

  it('flips y so that up in the drawing is up on paper', () => {
    const svg = svgFor([{ pts: [[0, 0], [1, 0], [0.5, 2]], closed: true }], N - 1, 100);
    const d = svg.match(/ d="([^"]+)"/)![1];
    const ys = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(m => Number(m[2]));
    // The apex (y = 2 in the drawing) is the smallest SVG y.
    expect(Math.min(...ys)).toBeCloseTo(-2, 3);
  });
});
