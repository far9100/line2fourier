// DECISIONS.md D38: strokes whose ends nearly meet are joined pen-down.
import { describe, expect, it } from 'vitest';
import { BRIDGE_SHARE, bridgeEnds } from '../../src/core/bridge.ts';
import type { Pt } from '../../src/core/fourier.ts';
import type { Stroke } from '../../src/core/path.ts';

const open = (...pts: Pt[]): Stroke => ({ pts, closed: false });

describe('joining ends that nearly meet', () => {
  it('two strokes whose ends are closer than eps become one, in walking order', () => {
    const r = bridgeEnds([open([0, 0], [10, 0]), open([10.5, 0], [20, 0])], 1);
    expect(r.bridges).toBe(1);
    expect(r.length).toBeCloseTo(0.5, 12);
    expect(r.strokes).toEqual([open([0, 0], [10, 0], [10.5, 0], [20, 0])]);
  });

  it('a stroke can be walked backwards to join', () => {
    const r = bridgeEnds([open([0, 0], [10, 0]), open([20, 0], [10.4, 0])], 1);
    expect(r.strokes).toEqual([open([0, 0], [10, 0], [10.4, 0], [20, 0])]);
  });

  it('nothing wider than eps is crossed', () => {
    const strokes = [open([0, 0], [10, 0]), open([12, 0], [20, 0])];
    const r = bridgeEnds(strokes, 1);
    expect(r.bridges).toBe(0);
    expect(r.strokes).toEqual(strokes);
  });

  it('the nearest ends are paired first, and an end is used once', () => {
    // The end at (10, 0) has two candidates: (10.2, 0) is nearer than (10, 0.9).
    const r = bridgeEnds([open([0, 0], [10, 0]), open([10.2, 0], [20, 0]), open([10, 0.9], [10, 10])], 1);
    expect(r.bridges).toBe(1);
    expect(r.strokes).toHaveLength(2);
    expect(r.strokes[0].pts.slice(1, 3)).toEqual([[10, 0], [10.2, 0]]);
  });

  it('a chain does not close through a bridge; when its own ends meet it becomes a closed stroke', () => {
    // A triangle drawn as three strokes with small gaps at every corner.
    const r = bridgeEnds([open([0, 0], [9.8, 0]), open([10, 0.2], [5, 8.4]), open([4.8, 8.6], [0.1, 0.2])], 0.5);
    expect(r.bridges).toBe(2);
    expect(r.closed).toBe(1);
    expect(r.strokes).toHaveLength(1);
    expect(r.strokes[0].closed).toBe(true);
    expect(r.strokes[0].pts).toHaveLength(6);
  });

  it('a nearly closed single stroke is closed', () => {
    const r = bridgeEnds([open([0, 0], [5, 0], [5, 5], [0.3, 0.1])], 1);
    expect(r.closed).toBe(1);
    expect(r.strokes[0].closed).toBe(true);
  });

  it('closed strokes are left alone, and the result does not depend on chance', () => {
    const loop: Stroke = { pts: [[0, 0], [1, 0], [1, 1]], closed: true };
    const strokes = [loop, open([1.1, 1.1], [3, 3]), open([3.2, 3], [5, 5]), open([5.1, 5.1], [7, 7])];
    const a = bridgeEnds(strokes, 0.5), b = bridgeEnds(strokes, 0.5);
    expect(a).toEqual(b);
    expect(a.strokes[0]).toBe(loop);
    expect(a.strokes).toHaveLength(2);
  });

  it('eps is half a percent of the drawing', () => {
    expect(BRIDGE_SHARE).toBe(0.005);
    expect(bridgeEnds([open([0, 0], [1, 0])], 0).bridges).toBe(0);
  });
});
