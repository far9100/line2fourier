// source → strokes → path → samples(N) → spectrum → ordered(order) → approximation(M) + metrics.
// Each stage remembers its last inputs and only runs again when one of them is a different
// object or value, so moving the M slider costs one inverse FFT and nothing upstream.
import {
  coefficients, energyTable, metrics, orderTerms, partialCurve,
  type EnergyTable, type Metrics, type Order, type Pt, type Term,
} from '../core/fourier.ts';
import { generate } from '../core/generators.ts';
import {
  JUMP, buildPath, prepareStrokes, samplePath, spansOf, strokesBBox,
  type BBox, type PathResult, type Samples, type Spans, type Stroke,
} from '../core/path.ts';
import type { SourceSpec } from './state.ts';

export interface Ordered { c0: Term; terms: Term[]; energy: EnergyTable }

export interface Computed {
  strokes: Stroke[];
  path: PathResult;
  spans: Spans;
  /** The drawing's size: the long side of its bounding box. Errors are shown relative to it (DECISIONS.md D11). */
  size: number;
  /** Its bounding box, which the view is fitted to (DECISIONS.md D45). */
  box: BBox;
  /** Jump length / path length (spec §4.6). */
  jumpRatio: number;
  samples: Samples;
  spectrum: Term[];
  ordered: Ordered;
  M: number;
  N: number;
  approx: Pt[];
  metrics: Metrics;
}

export function strokesFor(source: SourceSpec): Stroke[] {
  if (source.type === 'random') return [generate(source.generator, source.seed)];
  if (source.type === 'freehand') return [{ pts: source.points, closed: false }];
  return source.strokes;
}

function memo<A extends unknown[], R>(fn: (...args: A) => R, count: () => void): (...args: A) => R {
  let lastArgs: A | null = null;
  let last!: R;
  return (...args: A) => {
    if (lastArgs && args.every((a, i) => a === lastArgs![i])) return last;
    count();
    last = fn(...args);
    lastArgs = args;
    return last;
  };
}

export type StageName = 'strokes' | 'path' | 'samples' | 'spectrum' | 'ordered' | 'approx' | 'metrics';

export function createPipeline() {
  const calls: Record<StageName, number> = { strokes: 0, path: 0, samples: 0, spectrum: 0, ordered: 0, approx: 0, metrics: 0 };
  const counter = (name: StageName) => () => { calls[name]++; };

  const strokes = memo((source: SourceSpec) => prepareStrokes(strokesFor(source)), counter('strokes'));
  const path = memo((s: Stroke[]) => {
    const p = buildPath(s);
    const b = strokesBBox(s);
    return {
      path: p,
      spans: spansOf(p),
      size: Math.max(b.maxX - b.minX, b.maxY - b.minY),
      box: b,
    };
  }, counter('path'));
  const samples = memo((p: PathResult, N: number) => samplePath(p, N), counter('samples'));
  const spectrum = memo((s: Samples) => coefficients(s.pts), counter('spectrum'));
  const ordered = memo((sp: Term[], order: Order): Ordered => {
    const { c0, terms } = orderTerms(sp, order);
    return { c0, terms, energy: energyTable(terms) };
  }, counter('ordered'));
  const approx = memo((o: Ordered, M: number, N: number) => partialCurve(o.c0, o.terms, M, N), counter('approx'));
  const measure = memo((s: Samples, a: Pt[], o: Ordered, M: number) => metrics(s.pts, a, o.terms, M), counter('metrics'));

  return {
    calls,
    /** Throws PathError when the source cannot be drawn (spec §13). */
    compute(state: { source: SourceSpec; N: number; M: number; order: Order }): Computed {
      const st = strokes(state.source);
      const p = path(st);
      const sm = samples(p.path, state.N);
      const sp = spectrum(sm);
      const o = ordered(sp, state.order);
      const M = Math.min(state.M, o.terms.length);
      const a = approx(o, M, state.N);
      const m = measure(sm, a, o, M);
      return {
        strokes: st, path: p.path, spans: p.spans, size: p.size, box: p.box, jumpRatio: p.path.lengths[JUMP] / p.path.total,
        samples: sm, spectrum: sp, ordered: o, M, N: state.N, approx: a, metrics: m,
      };
    },
  };
}

export type Pipeline = ReturnType<typeof createPipeline>;
