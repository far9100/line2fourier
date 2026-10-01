// All N coefficients as JSON (spec §8): enough to rebuild the approximation exactly, elsewhere.
import type { Order, Term } from '../core/fourier.ts';

export interface CoefficientsFile {
  format: 'line2fourier.coefficients';
  version: 1;
  N: number;
  M: number;
  order: Order;
  source: unknown;
  /** c_k for every k from -N/2 to N/2 - 1, c_0 included. */
  coefficients: { k: number; re: number; im: number }[];
  /** The k of the M terms in use, in the order they are chained. */
  used: number[];
}

export function toCoefficientsJson(spectrum: Term[], ordered: Term[], info: { M: number; order: Order; source: unknown }): string {
  const file: CoefficientsFile = {
    format: 'line2fourier.coefficients',
    version: 1,
    N: spectrum.length,
    M: info.M,
    order: info.order,
    source: info.source,
    coefficients: [...spectrum].sort((a, b) => a.k - b.k).map(({ k, re, im }) => ({ k, re, im })),
    used: ordered.slice(0, info.M).map(c => c.k),
  };
  return `${JSON.stringify(file, null, 1)}\n`;
}
