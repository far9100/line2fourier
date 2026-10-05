// Everything the page can change, in one object (spec §10 is a subset of it).
import type { Order, Pt } from '../core/fourier.ts';
import type { GeneratorName } from '../core/generators.ts';
import type { Stroke } from '../core/path.ts';
import { DEFAULT_M, DEFAULT_N, N_CHOICES, SPEEDS, clampM, type NSize } from '../core/ticks.ts';
import type { Lang } from '../i18n/index.ts';

export type { Lang };

export type ImportKind = 'svg' | 'line2func' | 'image';

/** An imported file, already prepared: its strokes are cleaned, normalized and cut into the pieces of one walk. */
export interface ImportedSource {
  type: ImportKind;
  name: string;
  sha256: string;
  /** The file's text (an image's as a data: URL), kept so a project can embed it. */
  content: string;
  /** The pieces of the walk over the drawing, in walking order (core/route.ts): many more than its strokes. */
  strokes: Stroke[];
  /** The drawing's strokes, ends that nearly meet joined: what the page counts. */
  strokeCount: number;
  /** Jump length / path length had the strokes been chained in the file's order (spec §4.6). */
  originalJumpRatio: number;
}

export type SourceSpec =
  | { type: 'random'; generator: GeneratorName; seed: number }
  /** One stroke in world units (the fixed view scale of render/camera.ts), y up, left open. */
  | { type: 'freehand'; points: Pt[] }
  | ImportedSource;

export interface ViewState {
  showCircles: boolean;
  showOriginal: boolean;
  /** Draw the pen-up moves between strokes, in their own colour (DECISIONS.md D44). */
  showJumps: boolean;
  /** Keep the pen tip in the middle of the canvas, magnified `zoom` times. */
  follow: boolean;
  zoom: number;
}

export interface DemoState {
  /** Index into demoSequence(N) of the circle count being shown. */
  step: number;
  /** The M to go back to when the demo ends. */
  returnM: number;
}

export interface AppState {
  source: SourceSpec;
  N: NSize;
  M: number;
  order: Order;
  speed: number;
  view: ViewState;
  /** 'draw': the canvas collects a freehand stroke; 'play': the epicycles run. */
  mode: 'play' | 'draw';
  /** False while paused. A drawing that is done stops by itself, and this stays true (DECISIONS.md D50). */
  playing: boolean;
  demo: DemoState | null;
  /** The k picked in the spectrum panel, highlighted on the canvas (spec §6). */
  selectedK: number | null;
  lang: Lang;
}

export const ZOOM_MAX = 50;

export function defaultState(source: SourceSpec, lang: Lang, reducedMotion: boolean): AppState {
  return {
    source,
    N: DEFAULT_N,
    M: DEFAULT_M,
    order: 'magnitude',
    speed: 1,
    view: { showCircles: true, showOriginal: false, showJumps: true, follow: false, zoom: 8 },
    mode: 'play',
    playing: !reducedMotion,
    demo: null,
    selectedK: null,
    lang,
  };
}

/** Keeps every field in range; the store runs it on every change. */
export function normalizeState(s: AppState): AppState {
  const N = (N_CHOICES as readonly number[]).includes(s.N) ? s.N : DEFAULT_N;
  const M = clampM(s.M, N);
  const speed = SPEEDS.includes(s.speed) ? s.speed : 1;
  const zoom = Math.min(ZOOM_MAX, Math.max(1, Number.isFinite(s.view.zoom) ? s.view.zoom : 8));
  const view = zoom === s.view.zoom ? s.view : { ...s.view, zoom };
  if (N === s.N && M === s.M && speed === s.speed && view === s.view) return s;
  return { ...s, N, M, speed, view };
}
