// The series as LaTeX (spec §8): z(t) = c_0 + Σ r_j e^{i(2π k_j t + φ_j)} with every number written out.
import type { Term } from '../core/fourier.ts';

const num = (v: number, digits: number) => (Math.abs(v) < 10 ** -digits ? 0 : v).toFixed(digits);

/** c_0 as a complex number, e.g. (0.01010-0.06391i). */
function complex(c: Term, digits: number): string {
  const re = num(c.re, digits), im = num(Math.abs(c.im), digits);
  return `(${re}${c.im < 0 && Number(im) !== 0 ? '-' : '+'}${im}i)`;
}

/** One term, e.g. +0.41230e^{i(-4\pi t+1.20345)}. */
function term(c: Term, digits: number): string {
  const freq = c.k === 1 ? '2\\pi t' : c.k === -1 ? '-2\\pi t' : `${2 * c.k}\\pi t`;
  const phase = num(c.phase, digits);
  const sign = phase.startsWith('-') ? '' : '+';
  return `+${num(c.amp, digits)}e^{i(${freq}${sign}${phase})}`;
}

/** The first M terms, in the current order. */
export function toLatex(c0: Term, terms: Term[], M: number, digits = 5): string {
  return `z(t)=${complex(c0, digits)}${terms.slice(0, M).map(c => term(c, digits)).join('')}`;
}

/** The first few terms and "+⋯" when there are more: for the formula panel. */
export function toLatexPreview(c0: Term, terms: Term[], M: number, shown = 4, digits = 3): string {
  const head = `z(t)=${complex(c0, digits)}${terms.slice(0, Math.min(M, shown)).map(c => term(c, digits)).join('')}`;
  return M > shown ? `${head}+\\cdots` : head;
}
