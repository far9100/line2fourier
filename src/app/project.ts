// The project file (spec §10). Coefficients are never stored: loading recomputes them, and the same
// file gives the same result bit for bit (DECISIONS.md D4). `format` tells a project apart from other
// JSON dropped on the page; `engine` is bumped whenever the generators or the path code change what
// a saved source turns into.
import type { Order, Pt } from '../core/fourier.ts';
import { GENERATORS, type GeneratorName } from '../core/generators.ts';
import { N_CHOICES, SPEEDS, type NSize } from '../core/ticks.ts';
import { ZOOM_MAX, type AppState, type ImportKind, type ViewState } from './state.ts';

export const PROJECT_FORMAT = 'line2fourier.project';
/** 2: imports join near ends (D38); images outline solid areas and walk Euler trails (D39, D40). */
export const ENGINE = 2;

/**
 * The source as saved: an imported file is kept by name and SHA-256, and its text only when the
 * user asks to embed it (spec §10); opening the project prepares it again.
 */
export type SavedSource =
  | { type: 'random'; generator: GeneratorName; seed: number }
  | { type: 'freehand'; points: Pt[] }
  | { type: ImportKind; name: string; sha256: string; content?: string };

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: 1;
  engine: number;
  source: SavedSource;
  N: NSize;
  M: number;
  order: Order;
  speed: number;
  view: ViewState;
}

export function savedSource(s: AppState['source'], embed: boolean): SavedSource {
  if (s.type === 'random' || s.type === 'freehand') return s;
  return embed ? { type: s.type, name: s.name, sha256: s.sha256, content: s.content } : { type: s.type, name: s.name, sha256: s.sha256 };
}

export function toProject(s: AppState, embed = false): ProjectFile {
  return {
    format: PROJECT_FORMAT,
    version: 1,
    engine: ENGINE,
    source: savedSource(s.source, embed),
    N: s.N,
    M: s.M,
    order: s.order,
    speed: s.speed,
    view: { ...s.view },
  };
}

export function projectText(s: AppState, embed = false): string {
  return `${JSON.stringify(toProject(s, embed), null, 1)}\n`;
}

export type ProjectError = 'json' | 'format' | 'version' | 'source';

export interface ParsedProject {
  project: ProjectFile;
  /** i18n keys of things that were off but could be fixed. */
  warnings: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPt = (v: unknown): v is Pt => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n));

function parseSource(v: unknown): SavedSource | null {
  if (!isObj(v)) return null;
  if (v.type === 'random') {
    const seed = v.seed;
    if (!GENERATORS.includes(v.generator as GeneratorName)) return null;
    if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) return null;
    return { type: 'random', generator: v.generator as GeneratorName, seed };
  }
  if (v.type === 'freehand') {
    if (!Array.isArray(v.points) || v.points.length < 2 || !v.points.every(isPt)) return null;
    return { type: 'freehand', points: (v.points as Pt[]).map(([x, y]) => [x, y]) };
  }
  if (v.type === 'svg' || v.type === 'line2func' || v.type === 'image') {
    if (typeof v.name !== 'string' || typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256)) return null;
    if (v.content !== undefined && typeof v.content !== 'string') return null;
    return { type: v.type, name: v.name, sha256: v.sha256, ...(typeof v.content === 'string' ? { content: v.content } : {}) };
  }
  return null;
}

export function parseProject(text: string): ParsedProject | { error: ProjectError } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'json' };
  }
  if (!isObj(data)) return { error: 'format' };
  // The spec's own example (§10) has no `format` field: accept it when the rest looks right.
  if (data.format !== undefined && data.format !== PROJECT_FORMAT) return { error: 'format' };
  if (data.version !== 1) return { error: 'version' };
  const source = parseSource(data.source);
  if (!source) return { error: 'source' };

  const warnings: string[] = [];
  const engine = typeof data.engine === 'number' ? data.engine : ENGINE;
  if (engine > ENGINE) warnings.push('project.newerEngine');
  // Random and hand-drawn sources come out the same in every engine so far; imports do not.
  if (engine < ENGINE && source.type !== 'random' && source.type !== 'freehand') warnings.push('project.olderEngine');
  const N = (N_CHOICES as readonly unknown[]).includes(data.N) ? (data.N as NSize) : 1024;
  if (N !== data.N) warnings.push('project.fixedValues');
  const M = typeof data.M === 'number' && Number.isFinite(data.M) ? Math.min(N - 1, Math.max(1, Math.round(data.M))) : 50;
  if (M !== data.M) warnings.push('project.fixedValues');
  const order: Order = data.order === 'frequency' ? 'frequency' : 'magnitude';
  const speed = SPEEDS.includes(data.speed as number) ? (data.speed as number) : 1;
  const v = isObj(data.view) ? data.view : {};
  const zoom = typeof v.zoom === 'number' && Number.isFinite(v.zoom) ? Math.min(ZOOM_MAX, Math.max(1, v.zoom)) : 8;
  const view: ViewState = {
    showCircles: v.showCircles !== false,
    showOriginal: v.showOriginal !== false,
    follow: v.follow === true,
    zoom,
  };
  return {
    project: { format: PROJECT_FORMAT, version: 1, engine, source, N, M, order, speed, view },
    warnings: [...new Set(warnings)],
  };
}
