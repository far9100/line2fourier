// Reads the Desmos text this app exports (spec §8) back into a curve t ↦ (x, y), so tests can
// evaluate exactly what a user pastes. It accepts only the two forms the exporter writes:
//   (x0+\operatorname{total}(R\cos(2\pi Kt+P)),y0+\operatorname{total}(R\sin(2\pi Kt+P)))
// and the slider version, where R, K and P are R[1...M], K[1...M], P[1...M] and a line M=… sets M.
import type { Pt } from '../../src/core/fourier.ts';

export function parseDesmos(text: string): (t: number) => Pt {
  const lists = new Map<string, number[]>();
  const scalars = new Map<string, number>();
  let curve = '';
  for (const line of text.trim().split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^([A-Z])=\[([^\]]*)\]$/))) lists.set(m[1], m[2] === '' ? [] : m[2].split(',').map(Number));
    else if ((m = line.match(/^([A-Z])=(-?\d+(?:\.\d+)?)$/))) scalars.set(m[1], Number(m[2]));
    else if (line.startsWith('(')) curve = line;
    else throw new Error(`unexpected Desmos line: ${line}`);
  }
  const plain = String.raw`R\cos(2\pi Kt+P)`;
  const sliced = String.raw`R[1...M]\cos(2\pi K[1...M]t+P[1...M])`;
  const m = curve.match(/^\((-?\d+(?:\.\d+)?)\+\\operatorname\{total\}\((.*)\),(-?\d+(?:\.\d+)?)\+\\operatorname\{total\}\((.*)\)\)$/);
  if (!m) throw new Error(`unexpected Desmos curve: ${curve.slice(0, 80)}`);
  const [, x0, xs, y0, ys] = m;
  const slice = xs === sliced && ys === sliced.replace('cos', 'sin');
  if (!slice && !(xs === plain && ys === plain.replace('cos', 'sin'))) throw new Error('unexpected Desmos sums');

  const R = lists.get('R'), K = lists.get('K'), P = lists.get('P');
  if (!R || !K || !P || R.length !== K.length || R.length !== P.length) throw new Error('lists R, K, P missing or of different lengths');
  const count = slice ? scalars.get('M') ?? NaN : R.length;
  if (!(count >= 1 && count <= R.length && Number.isInteger(count))) throw new Error(`bad M: ${count}`);
  const cx = Number(x0), cy = Number(y0);
  return (t: number): Pt => {
    let x = cx, y = cy;
    for (let j = 0; j < count; j++) {
      const a = 2 * Math.PI * K[j] * t + P[j];
      x += R[j] * Math.cos(a);
      y += R[j] * Math.sin(a);
    }
    return [x, y];
  };
}
