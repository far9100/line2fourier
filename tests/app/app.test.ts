import { describe, expect, it } from 'vitest';
import { advance, cycleMs, MAX_FRAME_MS } from '../../src/app/clock.ts';
import { createPipeline } from '../../src/app/pipeline.ts';
import { PROJECT_FORMAT, parseProject, projectText, toProject } from '../../src/app/project.ts';
import { defaultState, normalizeState, type AppState } from '../../src/app/state.ts';
import { createStore } from '../../src/app/store.ts';
import { PathError } from '../../src/core/path.ts';

const base = (): AppState => defaultState({ type: 'random', generator: 'creature', seed: 42 }, 'zh-TW', false);

describe('pipeline: only what changed is recomputed', () => {
  it('M touches the approximation and the metrics only', () => {
    const p = createPipeline();
    const s = base();
    p.compute(s);
    const before = { ...p.calls };
    p.compute({ ...s, M: 60 });
    expect(p.calls).toEqual({ ...before, approx: before.approx + 1, metrics: before.metrics + 1 });
  });

  it('the order recomputes from the ordering on; N from the samples on; the source everything', () => {
    const p = createPipeline();
    const s = base();
    p.compute(s);
    let before = { ...p.calls };
    p.compute({ ...s, order: 'frequency' });
    expect(p.calls).toEqual({ ...before, ordered: before.ordered + 1, approx: before.approx + 1, metrics: before.metrics + 1 });
    before = { ...p.calls };
    p.compute({ ...s, order: 'frequency', N: 2048 });
    expect(p.calls).toEqual({
      ...before, samples: before.samples + 1, spectrum: before.spectrum + 1, ordered: before.ordered + 1,
      approx: before.approx + 1, metrics: before.metrics + 1,
    });
    before = { ...p.calls };
    p.compute({ ...s, source: { type: 'random', generator: 'star', seed: 1 } });
    for (const k of Object.keys(before) as (keyof typeof before)[]) expect(p.calls[k]).toBe(before[k] + 1);
  });

  it('the same state twice costs nothing', () => {
    const p = createPipeline();
    const s = base();
    p.compute(s);
    const before = { ...p.calls };
    p.compute(s);
    expect(p.calls).toEqual(before);
  });

  it('reports the jump ratio, the drawing size and the largest circle in use', () => {
    const c = createPipeline().compute(base());
    expect(c.jumpRatio).toBe(0);
    expect(c.size).toBeCloseTo(2, 12);
    expect(c.largest).toBe(c.ordered.terms[0]);
    expect(c.approx).toHaveLength(1024);
  });

  it('rejects a freehand line without length (spec §13)', () => {
    const p = createPipeline();
    expect(() => p.compute({ ...base(), source: { type: 'freehand', points: [[0, 0], [0, 0], [0, 0]] } })).toThrow(PathError);
  });

  it('a freehand line keeps its own position and size', () => {
    const c = createPipeline().compute({ ...base(), source: { type: 'freehand', points: [[2, 2], [3, 2], [3, 3], [2.2, 3.1]] } });
    expect(c.path.poly[0]).toEqual([2, 2]);
    expect(c.ordered.c0.re).toBeGreaterThan(2);
  });
});

describe('clock', () => {
  it('advances by dt / cycle and wraps', () => {
    expect(advance(0, 80, 8000)).toEqual({ t: 0.01, wrapped: false });
    const w = advance(0.995, 80, 8000);
    expect(w.wrapped).toBe(true);
    expect(w.t).toBeCloseTo(0.005, 12);
  });

  it('a long pause (hidden tab) moves time by at most one short frame', () => {
    expect(advance(0.2, 60_000, 8000).t).toBeCloseTo(0.2 + MAX_FRAME_MS / 8000, 12);
    expect(advance(0.2, -5, 8000).t).toBe(0.2);
  });

  it('a cycle is 8 s at 1×, scaled by speed; a demo step is 3.5 s', () => {
    expect(cycleMs(1, false)).toBe(8000);
    expect(cycleMs(2, false)).toBe(4000);
    expect(cycleMs(0.25, false)).toBe(32000);
    expect(cycleMs(3, true)).toBe(3500);
  });
});

describe('state', () => {
  it('stays in range', () => {
    const s = normalizeState({ ...base(), N: 1000 as never, M: 99999, speed: 7, view: { ...base().view, zoom: 900 } });
    expect(s.N).toBe(1024);
    expect(s.M).toBe(1023);
    expect(s.speed).toBe(1);
    expect(s.view.zoom).toBe(50);
  });

  it('reduced motion starts paused (spec §6)', () => {
    expect(defaultState({ type: 'random', generator: 'star', seed: 1 }, 'en', true).playing).toBe(false);
  });

  it('the store notifies only real changes, with the previous state', () => {
    const store = createStore(base(), normalizeState);
    const seen: [number, number][] = [];
    store.subscribe((s, prev) => seen.push([s.M, prev.M]));
    store.set({ M: 50 });
    store.set({ M: 60 });
    store.set({ M: 5000 });
    expect(seen).toEqual([[60, 50], [1023, 60]]);
  });
});

describe('project file (spec §10)', () => {
  it('round-trips, and reloading gives the same numbers bit for bit', () => {
    const s = { ...base(), N: 2048 as const, M: 123, order: 'frequency' as const, speed: 1.5 };
    const parsed = parseProject(projectText(s));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.project).toEqual(toProject(s));
    expect(parsed.warnings).toEqual([]);
    const a = createPipeline().compute(s);
    const b = createPipeline().compute({ ...s, ...parsed.project });
    expect(b.spectrum).toEqual(a.spectrum);
    expect(b.approx).toEqual(a.approx);
  });

  it('accepts the spec’s example, which has no format field', () => {
    const parsed = parseProject(JSON.stringify({
      version: 1,
      source: { type: 'random', generator: 'creature', seed: 123456789 },
      N: 1024, M: 50, order: 'magnitude', speed: 1,
      view: { showCircles: true, showOriginal: true, follow: false, zoom: 1 },
    }));
    expect('project' in parsed && parsed.project.format).toBe(PROJECT_FORMAT);
  });

  it('keeps freehand points', () => {
    const s: AppState = { ...base(), source: { type: 'freehand', points: [[0, 0], [1, 0], [1, 1]] } };
    const parsed = parseProject(projectText(s));
    expect('project' in parsed && parsed.project.source).toEqual(s.source);
  });

  it('says what is wrong with a bad file', () => {
    expect(parseProject('{nope')).toEqual({ error: 'json' });
    expect(parseProject('[]')).toEqual({ error: 'format' });
    expect(parseProject(JSON.stringify({ format: 'line2func.curves', version: 1 }))).toEqual({ error: 'format' });
    expect(parseProject(JSON.stringify({ version: 2, source: {} }))).toEqual({ error: 'version' });
    expect(parseProject(JSON.stringify({ version: 1, source: { type: 'random', generator: 'dragon', seed: 1 } }))).toEqual({ error: 'source' });
    expect(parseProject(JSON.stringify({ version: 1, source: { type: 'random', generator: 'star', seed: -1 } }))).toEqual({ error: 'source' });
  });

  it('fixes values out of range and says so', () => {
    const parsed = parseProject(JSON.stringify({ version: 1, source: { type: 'random', generator: 'star', seed: 5 }, N: 333, M: 5000 }));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.project.N).toBe(1024);
    expect(parsed.project.M).toBe(1023);
    expect(parsed.warnings).toEqual(['project.fixedValues']);
  });
});
