// 2D affine transforms in SVG's order: [a, b, c, d, e, f] maps (x, y) to (a·x + c·y + e, b·x + d·y + f).
import type { Pt } from './fourier.ts';

export type Affine = readonly [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** m·n: apply n first, then m. */
export function mul(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyPt(m: Affine, x: number, y: number): Pt {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/**
 * An SVG transform attribute: a list of matrix(), translate(), scale(), rotate() (degrees, with an
 * optional centre), skewX() and skewY(), applied right to left. null when it cannot be read.
 */
export function parseTransform(text: string | null | undefined): Affine | null {
  if (!text || !text.trim()) return IDENTITY;
  let m = IDENTITY;
  const re = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/gy;
  let pos = 0;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    pos = re.lastIndex;
    const args = (match[2].match(NUMBER) ?? []).map(Number);
    const rad = (deg: number) => (deg * Math.PI) / 180;
    let t: Affine | null = null;
    switch (match[1]) {
      case 'matrix':
        if (args.length === 6) t = args as unknown as Affine;
        break;
      case 'translate':
        if (args.length === 1 || args.length === 2) t = [1, 0, 0, 1, args[0], args[1] ?? 0];
        break;
      case 'scale':
        if (args.length === 1 || args.length === 2) t = [args[0], 0, 0, args[1] ?? args[0], 0, 0];
        break;
      case 'rotate':
        if (args.length === 1 || args.length === 3) {
          const a = rad(args[0]), cos = Math.cos(a), sin = Math.sin(a);
          const r: Affine = [cos, sin, -sin, cos, 0, 0];
          t = args.length === 3 ? mul(mul([1, 0, 0, 1, args[1], args[2]], r), [1, 0, 0, 1, -args[1], -args[2]]) : r;
        }
        break;
      case 'skewX':
        if (args.length === 1) t = [1, 0, Math.tan(rad(args[0])), 1, 0, 0];
        break;
      case 'skewY':
        if (args.length === 1) t = [1, Math.tan(rad(args[0])), 0, 1, 0, 0];
        break;
    }
    if (!t) return null;
    m = mul(m, t);
  }
  return text.slice(pos).trim() === '' ? m : null;
}
