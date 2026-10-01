// Desmos text (spec §8): three lists R, K, P and one parametric curve, one expression per line.
import { toDesmos, type Term } from '../core/fourier.ts';

export { toDesmos };

/** How many terms the slider version carries when M is small, so the slider has room to move. */
export const SLIDER_MIN_TERMS = 300;

/**
 * The version with a slider: a line M=… and the sums over R[1...M], K[1...M], P[1...M]. The lists
 * hold max(M, 300) terms (all of them if there are fewer), in the current order.
 */
export function toDesmosSlider(c0: Term, terms: Term[], M: number, digits = 5): string {
  const count = Math.min(terms.length, Math.max(M, SLIDER_MIN_TERMS));
  const [R, K, P, curve] = toDesmos(c0, terms, count, digits).split('\n');
  const sliced = curve
    .replace(/R\\cos\(2\\pi Kt\+P\)/, 'R[1...M]\\cos(2\\pi K[1...M]t+P[1...M])')
    .replace(/R\\sin\(2\\pi Kt\+P\)/, 'R[1...M]\\sin(2\\pi K[1...M]t+P[1...M])');
  return [`M=${M}`, R, K, P, sliced].join('\n');
}
