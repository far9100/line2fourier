import { describe, expect, it } from 'vitest';
import { formatEnergy, formatShare } from '../../src/ui/format.ts';
import { longEnough, MIN_LENGTH_PX, MIN_POINTS } from '../../src/ui/freehand.ts';
import type { Pt } from '../../src/core/fourier.ts';

describe('metric formatting', () => {
  it('shows the energy ratio down to the first digit short of 100%, never rounding up to 100%', () => {
    expect(formatEnergy(1)).toBe('100%');
    expect(formatEnergy(0.99985)).toBe('99.985%');
    expect(formatEnergy(0.9999996)).toBe('99.999960%');
    expect(formatEnergy(0.95)).toBe('95.0%');
    expect(formatEnergy(0.5)).toBe('50.0%');
    expect(formatEnergy(0.99999999999)).not.toBe('100%');
  });

  it('shows lengths as a share of the drawing size', () => {
    expect(formatShare(0.2, 2)).toBe('10.0%');
    expect(formatShare(0.0071, 2)).toBe('0.355%');
    expect(formatShare(0.03, 2)).toBe('1.50%');
    expect(formatShare(0, 2)).toBe('0%');
    expect(formatShare(1e-9, 2)).toBe('5.0e-8%');
  });
});

describe('freehand (spec §5.2)', () => {
  const line = (n: number, step: number): Pt[] => Array.from({ length: n }, (_, i) => [i * step, 0]);

  it('needs 8 points and 60 px of line', () => {
    expect(MIN_POINTS).toBe(8);
    expect(MIN_LENGTH_PX).toBe(60);
    expect(longEnough(line(8, 10))).toBe(true);
    expect(longEnough(line(7, 20))).toBe(false); // long, but too few points
    expect(longEnough(line(20, 3))).toBe(false); // 57 px
    expect(longEnough(line(21, 3))).toBe(true); // 60 px
  });
});
