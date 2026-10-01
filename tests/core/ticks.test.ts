import { describe, expect, it } from 'vitest';
import { N_CHOICES, autoN, clampM, demoSequence, mTicks, sliderIndex, stepM } from '../../src/core/ticks.ts';

describe('circle-count ticks (spec §3)', () => {
  it('follow the spec’s scale and end at N − 1', () => {
    expect(mTicks(1024)).toEqual([1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 150, 200, 300, 500, 1000, 1023]);
    expect(mTicks(512).slice(-3)).toEqual([300, 500, 511]);
    expect(mTicks(8192).slice(-3)).toEqual([3000, 5000, 8191]);
    for (const N of N_CHOICES) {
      const t = mTicks(N);
      expect(t[0]).toBe(1);
      expect(t[t.length - 1]).toBe(N - 1);
      t.slice(1).forEach((m, i) => expect(m).toBeGreaterThan(t[i]));
    }
  });

  it('M is clamped to a whole number in [1, N − 1] (spec §13)', () => {
    expect(clampM(5000, 1024)).toBe(1023);
    expect(clampM(0, 1024)).toBe(1);
    expect(clampM(7.4, 1024)).toBe(7);
    expect(clampM(NaN, 1024)).toBe(1);
  });

  it('the slider thumb sits on the largest tick at or below M', () => {
    const t = mTicks(1024);
    expect(t[sliderIndex(50, t)]).toBe(50);
    expect(t[sliderIndex(7, t)]).toBe(6);
    expect(t[sliderIndex(1023, t)]).toBe(1023);
    expect(sliderIndex(1, t)).toBe(0);
  });

  it('← and → move to the neighbouring tick, Shift moves by one', () => {
    expect(stepM(50, 1024, 1)).toBe(60);
    expect(stepM(50, 1024, -1)).toBe(40);
    expect(stepM(7, 1024, 1)).toBe(8);
    expect(stepM(7, 1024, -1)).toBe(6);
    expect(stepM(1023, 1024, 1)).toBe(1023);
    expect(stepM(1, 1024, -1)).toBe(1);
    expect(stepM(50, 1024, 1, true)).toBe(51);
    expect(stepM(1, 1024, -1, true)).toBe(1);
  });
});

describe('demo and automatic N', () => {
  it('the demo steps stop at N − 1 without repeating', () => {
    expect(demoSequence(1024)).toEqual([1, 2, 3, 5, 10, 20, 50, 100, 300, 1000]);
    expect(demoSequence(512)).toEqual([1, 2, 3, 5, 10, 20, 50, 100, 300, 511]);
  });

  it('imports get the smallest N with samples at most 0.01 apart, within 1024–8192', () => {
    expect(autoN(4)).toBe(1024);
    expect(autoN(10.24)).toBe(1024);
    expect(autoN(10.25)).toBe(2048);
    expect(autoN(80.9)).toBe(8192);
    expect(autoN(500)).toBe(8192);
  });
});
