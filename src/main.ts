// The page: state, the pipeline, the canvas and the controls, wired together.
import 'katex/dist/katex.min.css';
import './styles/main.css';
import { advance, cycleMs } from './app/clock.ts';
import { createPipeline, type Computed, type Ordered } from './app/pipeline.ts';
import { bytesToDataUrl, dataUrlToBytes, decodeImage } from './app/image.ts';
import { detectKind, finishImport, imageStrokes, prepareImport, sha256Hex, type Prepared } from './app/importer.ts';
import { parseProject, projectText, type ProjectFile } from './app/project.ts';
import { defaultState, normalizeState, type AppState, type ImportKind, type ImportedSource, type SourceSpec } from './app/state.ts';
import { createStore } from './app/store.ts';
import { partialCurve, type Pt } from './core/fourier.ts';
import { GENERATORS, newSeed, type GeneratorName } from './core/generators.ts';
import { PathError } from './core/path.ts';
import { N_CHOICES, SPEEDS, clampM, demoSequence, mTicks, sliderIndex, stepM, suggestM, type NSize } from './core/ticks.ts';
import { SLIDER_MIN_TERMS, toDesmos, toDesmosSlider } from './export/desmos.ts';
import { copyText, downloadText } from './export/download.ts';
import { toCoefficientsJson } from './export/json.ts';
import { toLatex, toLatexPreview } from './export/latex.ts';
import { toSvg } from './export/svg.ts';
import { detectLang, setLang, t, type Lang } from './i18n/index.ts';
import { CanvasView } from './render/canvasView.ts';
import { curveEvents, tipAt } from './render/curve.ts';
import { buildScene } from './render/scene.ts';
import { SpectrumView, autoRange } from './render/spectrumView.ts';
import { formatEnergy, formatShare } from './ui/format.ts';
import { renderMath } from './ui/formula.ts';
import { startFreehand } from './ui/freehand.ts';
import { bindKeys } from './ui/keyboard.ts';
import { mountOutputs } from './ui/outputs.ts';
import { toast } from './ui/toast.ts';
import { createWorkerClient } from './worker/client.ts';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T;
const LANG_KEY = 'line2fourier.lang';

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeLocal(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode: the choice just isn't remembered */ }
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------- state

function initialState(): AppState {
  // ?gen=star&seed=42&N=2048&M=100 reproduces a drawing (and lets the end-to-end tests pin one).
  const params = new URLSearchParams(location.search);
  const gen = params.get('gen');
  const generator: GeneratorName = GENERATORS.includes(gen as GeneratorName) ? (gen as GeneratorName) : 'creature';
  const seedText = params.get('seed');
  const seedValue = seedText === null ? NaN : Number(seedText);
  const seed = Number.isInteger(seedValue) && seedValue >= 0 && seedValue < 2 ** 32 ? seedValue : newSeed();
  const state = defaultState({ type: 'random', generator, seed }, detectLang(readLocal(LANG_KEY)), reducedMotion);
  const N = Number(params.get('N'));
  if ((N_CHOICES as readonly number[]).includes(N)) state.N = N as NSize;
  const M = Number(params.get('M'));
  if (params.has('M') && Number.isFinite(M)) state.M = M;
  if (params.get('play') === '0') state.playing = false;
  return state;
}

const store = createStore(initialState(), normalizeState);
const pipeline = createPipeline();
const view = new CanvasView($<HTMLCanvasElement>('#view'), () => {
  dirty = true;
  spectrumView.style = view.style;
  spectrumView.draw();
  outputs.update();
});
const spectrumView = new SpectrumView($<HTMLCanvasElement>('#spectrum'), view.style);
const worker = createWorkerClient();

let computed: Computed;
let tCycle = 0;
let firstCycleDone = reducedMotion;
let draft: Pt[] | null = null;
let dirty = true;
let lastFrame = performance.now();
/** Milliseconds: the last pipeline run, and a running average of drawing one frame (spec §6). */
const timings = { recompute: 0, render: 0 };

/** Run the pipeline; on a drawing that cannot be used, say why and keep the previous one. */
function recompute(s: AppState): boolean {
  let next: Computed;
  const started = performance.now();
  try {
    next = pipeline.compute(s);
  } catch (e) {
    if (e instanceof PathError) {
      toast(t(`error.path.${e.code}`), 'error');
      return false;
    }
    throw e;
  }
  timings.recompute = performance.now() - started;
  const changed = !computed || next.approx !== computed.approx || next.spans !== computed.spans;
  computed = next;
  if (changed) {
    const { c0, terms } = next.ordered;
    const scratch = new Float64Array(2 * next.M + 2);
    view.scene = buildScene(next, curveEvents(next.approx, next.spans, tt => tipAt(c0, terms, next.M, tt, scratch)));
  }
  dirty = true;
  return true;
}

// ---------------------------------------------------------------- animation

function cycleEnded(): void {
  const s = store.get();
  if (!s.demo) {
    firstCycleDone = true;
    return;
  }
  const steps = demoSequence(s.N);
  const next = s.demo.step + 1;
  if (next < steps.length) store.set({ demo: { ...s.demo, step: next }, M: steps[next] });
  else store.set({ demo: null, M: s.demo.returnM });
}

function frame(now: number): void {
  const s = store.get();
  const dt = now - lastFrame;
  lastFrame = now;
  const running = s.playing && s.mode === 'play' && !!view.scene;
  if (running) {
    const step = advance(tCycle, dt, cycleMs(s.speed, !!s.demo));
    tCycle = step.t;
    if (step.wrapped) cycleEnded();
  }
  if (running || dirty) {
    const started = performance.now();
    draw();
    timings.render = 0.9 * timings.render + 0.1 * (performance.now() - started);
    dirty = false;
  }
  outputs.frame();
  requestAnimationFrame(frame);
}

function draw(): void {
  const s = store.get();
  const drawing = s.mode === 'draw';
  let follow: Pt | null = null;
  if (s.view.follow && !drawing && computed) {
    const { c0, terms } = computed.ordered;
    follow = tipAt(c0, terms, computed.M, tCycle);
  }
  view.render({
    t: tCycle,
    camera: follow ? view.camera(follow, s.view.zoom) : view.baseCamera(),
    showCircles: s.view.showCircles,
    showOriginal: s.view.showOriginal || drawing,
    showFull: !s.demo && firstCycleDone,
    draft: drawing ? draft ?? [] : null,
    highlightK: s.selectedK,
  });
}

// ---------------------------------------------------------------- controls

const mRange = $<HTMLInputElement>('#m-range');
const mNumber = $<HTMLInputElement>('#m-number');
const speedRange = $<HTMLInputElement>('#speed');
const nSelect = $<HTMLSelectElement>('#n-select');
const generatorSelect = $<HTMLSelectElement>('#generator');
const seedInput = $<HTMLInputElement>('#seed');
const fileInput = $<HTMLInputElement>('#file-input');

speedRange.max = String(SPEEDS.length - 1);
for (const N of N_CHOICES) nSelect.append(new Option(String(N), String(N)));

function newDrawing(generator: GeneratorName, seed = newSeed()): void {
  const s = store.get();
  store.set({ source: { type: 'random', generator, seed }, mode: 'play', demo: null, M: s.demo ? s.demo.returnM : s.M, selectedK: null });
}

$('#new-drawing').addEventListener('click', () => newDrawing(generatorSelect.value as GeneratorName));
generatorSelect.addEventListener('change', () => newDrawing(generatorSelect.value as GeneratorName));
$('#seed-apply').addEventListener('click', applySeed);
seedInput.addEventListener('keydown', e => { if (e.key === 'Enter') applySeed(); });

function applySeed(): void {
  const text = seedInput.value.trim();
  const seed = Number(text);
  if (!/^\d+$/.test(text) || !(seed < 2 ** 32)) {
    toast(t('seed.invalid'), 'error');
    return;
  }
  newDrawing(generatorSelect.value as GeneratorName, seed);
}

$('#draw').addEventListener('click', () => enterDraw());
$('#draw-cancel').addEventListener('click', () => leaveDraw());
$('#play').addEventListener('click', () => store.set({ playing: !store.get().playing }));
$('#demo').addEventListener('click', toggleDemo);

function toggleDemo(): void {
  const s = store.get();
  if (s.demo) {
    store.set({ demo: null, M: s.demo.returnM });
    return;
  }
  tCycle = 0;
  store.set({ demo: { step: 0, returnM: s.M }, M: demoSequence(s.N)[0], mode: 'play', playing: true });
}

mRange.addEventListener('input', () => {
  const ticks = mTicks(store.get().N);
  store.set({ M: ticks[Number(mRange.value)] });
});
mNumber.addEventListener('change', () => {
  store.set({ M: clampM(Number(mNumber.value), store.get().N) });
  mNumber.value = String(store.get().M);
});
speedRange.addEventListener('input', () => store.set({ speed: SPEEDS[Number(speedRange.value)] }));
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="order"]')) {
  radio.addEventListener('change', () => { if (radio.checked) store.set({ order: radio.value as AppState['order'] }); });
}
$<HTMLInputElement>('#show-circles').addEventListener('change', e => {
  store.set({ view: { ...store.get().view, showCircles: (e.target as HTMLInputElement).checked } });
});
$<HTMLInputElement>('#show-original').addEventListener('change', e => {
  store.set({ view: { ...store.get().view, showOriginal: (e.target as HTMLInputElement).checked } });
});
nSelect.addEventListener('change', () => store.set({ N: Number(nSelect.value) as NSize }));

// Following the pen (spec §6): the zoom slider is logarithmic, 1× to 50×.
const zoomRange = $<HTMLInputElement>('#zoom');
const zoomOf = (v: number) => 50 ** (v / 100);
$<HTMLInputElement>('#follow').addEventListener('change', e => {
  store.set({ view: { ...store.get().view, follow: (e.target as HTMLInputElement).checked } });
});
zoomRange.addEventListener('input', () => {
  store.set({ view: { ...store.get().view, zoom: Math.round(zoomOf(Number(zoomRange.value)) * 10) / 10 } });
});

// The spectrum panel: pick a term with the pointer or the arrow keys; Esc lets go of it.
const spectrumRange = $<HTMLSelectElement>('#spectrum-range');
spectrumRange.addEventListener('change', () => showSpectrum(store.get()));
spectrumView.canvas.addEventListener('click', e => {
  const k = spectrumView.kAt(e.clientX);
  store.set({ selectedK: k === store.get().selectedK ? null : k });
});
spectrumView.canvas.addEventListener('keydown', e => {
  const s = store.get(), K = spectrumK(s);
  const step = (k: number, dir: number) => { let next = k + dir; if (next === 0) next += dir; return Math.max(-K, Math.min(K, next)); };
  let next: number | null | undefined;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') next = step(s.selectedK ?? 0, e.key === 'ArrowRight' ? 1 : -1);
  else if (e.key === 'Home') next = -K;
  else if (e.key === 'End') next = K;
  else if (e.key === 'Escape') next = null;
  if (next === undefined) return;
  e.preventDefault();
  e.stopPropagation();
  store.set({ selectedK: next });
});

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-lang]')) {
  button.addEventListener('click', () => store.set({ lang: button.dataset.lang as Lang }));
}
const about = $<HTMLDialogElement>('#about');
$('#about-open').addEventListener('click', () => about.showModal());
$('#about-close').addEventListener('click', () => about.close());

// ---------------------------------------------------------------- drawing by hand

let stopFreehand: (() => void) | null = null;

function enterDraw(): void {
  const s = store.get();
  if (s.mode === 'draw') return;
  store.set({ mode: 'draw', demo: null, M: s.demo ? s.demo.returnM : s.M });
}

function leaveDraw(): void {
  draft = null;
  store.set({ mode: 'play' });
}

function setDrawing(on: boolean): void {
  $('#canvas-wrap').classList.toggle('drawing', on);
  $('#draw-overlay').hidden = !on;
  stopFreehand?.();
  stopFreehand = null;
  if (!on) return;
  draft = [];
  stopFreehand = startFreehand({
    target: view.canvas,
    toWorld: (x, y) => view.worldFromClient(x, y),
    onDraft: points => { draft = points; dirty = true; },
    onTooShort: () => toast(t('draw.tooShort'), 'error'),
    onDone: points => {
      draft = null;
      const source: SourceSpec = { type: 'freehand', points };
      store.set({ source, mode: 'play', playing: !reducedMotion, selectedK: null });
    },
  });
}

// ---------------------------------------------------------------- export

function currentTerms() {
  const { c0, terms } = computed.ordered;
  return { c0, terms, M: computed.M };
}

async function copy(text: string): Promise<void> {
  toast((await copyText(text)) ? t('toast.copied') : t('toast.copyFailed'), '');
}

$('#copy-desmos').addEventListener('click', () => {
  const { c0, terms, M } = currentTerms();
  void copy(toDesmos(c0, terms, M));
});
$('#copy-desmos-slider').addEventListener('click', async () => {
  const { c0, terms, M } = currentTerms();
  // Pasted text cannot set a slider's range: Desmos starts it at -10, so say how to fix it.
  const ok = await copyText(toDesmosSlider(c0, terms, M));
  const n = Math.min(terms.length, Math.max(M, SLIDER_MIN_TERMS));
  toast(ok ? t('toast.copiedSlider', { n: String(n) }) : t('toast.copyFailed'), '', ok);
});
$('#copy-latex').addEventListener('click', () => {
  const { c0, terms, M } = currentTerms();
  void copy(toLatex(c0, terms, M));
});
$('#download-json').addEventListener('click', () => {
  const s = store.get();
  const text = toCoefficientsJson(computed.spectrum, computed.ordered.terms, { M: computed.M, order: s.order, source: s.source });
  downloadText(text, 'line2fourier-coefficients.json', 'application/json');
});
$('#download-svg').addEventListener('click', () => {
  const widthMm = Number($<HTMLInputElement>('#svg-width').value);
  const strokeMm = Number($<HTMLInputElement>('#svg-stroke').value);
  if (!(widthMm >= 10 && widthMm <= 3000) || !(strokeMm >= 0.05 && strokeMm <= 10)) {
    toast(t('export.svgInvalid'), 'error');
    return;
  }
  // Sample the curve 8192 times (exact trigonometric interpolation), smoother than N points.
  const { c0, terms, M } = currentTerms();
  const fine = partialCurve(c0, terms, M, Math.max(computed.N, 8192));
  const scratch = new Float64Array(2 * M + 2);
  const events = curveEvents(fine, computed.spans, tt => tipAt(c0, terms, M, tt, scratch));
  downloadText(toSvg(events, { widthMm, strokeMm }), 'line2fourier.svg', 'image/svg+xml');
});
$('#project-save').addEventListener('click', () => {
  const embed = $<HTMLInputElement>('#embed-source').checked;
  downloadText(projectText(store.get(), embed), 'line2fourier-project.json', 'application/json');
});
$('#project-open').addEventListener('click', () => fileInput.click());
$('#upload').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (file) void openFile(file);
});

// ---------------------------------------------------------------- opening files (spec §5.3, §5.4, §10)

type Settings = Pick<ProjectFile, 'N' | 'M' | 'order' | 'speed' | 'view'>;

/** A project whose imported drawing was not embedded: the next such file opened is taken as that drawing. */
let relink: { kind: ImportKind; sha256: string; settings: Settings } | null = null;

async function openFile(file: File): Promise<void> {
  if (detectKind(file.name, '', file.type) === 'image') {
    await openImage(file.name, new Uint8Array(await file.arrayBuffer()), file.type);
    return;
  }
  const text = await file.text();
  const kind = detectKind(file.name, text, file.type);
  if (kind === 'project') {
    relink = null;
    await openProject(text);
  } else if (kind === 'svg' || kind === 'line2func') {
    const settings = await takeRelink(kind, text);
    await importDrawing({ kind, name: file.name, sha256: await sha256Hex(text), content: text }, () => prepareImport(kind, text, s => worker.tour(s)), settings);
  } else {
    toast(t('import.error.unknown'), 'error');
  }
}

/** The settings of a project waiting for this file, if it is the kind it waits for (the hash is checked, not required). */
async function takeRelink(kind: ImportKind, data: string | Uint8Array): Promise<Settings | undefined> {
  const pending = relink;
  relink = null;
  if (!pending || pending.kind !== kind) return undefined;
  if ((await sha256Hex(data)) !== pending.sha256) toast(t('project.hashMismatch'), 'error');
  return pending.settings;
}

/** Spec §5.5: the browser decodes the image; thinning and tracing run in the worker. */
async function openImage(name: string, bytes: Uint8Array, mime: string, settings?: Settings): Promise<void> {
  settings ??= await takeRelink('image', bytes);
  const sha256 = await sha256Hex(bytes);
  await importDrawing({ kind: 'image', name, sha256, content: bytesToDataUrl(bytes, mime) }, async () => {
    let img;
    try {
      img = await decodeImage(bytes, mime);
    } catch {
      return { error: 'import.error.image' };
    }
    const traced = await worker.raster(img.data, img.width, img.height);
    return finishImport(imageStrokes(traced.strokes, traced.h), { ...traced.warnings }, s => worker.tour(s));
  }, settings);
}

let importing = 0;

interface Incoming { kind: ImportKind; name: string; sha256: string; content: string }

async function importDrawing(file: Incoming, prepare: () => Promise<Prepared | { error: string }>, settings?: Settings): Promise<void> {
  const ticket = ++importing;
  toast(t('import.working'), '', true);
  const prepared = await prepare();
  if (ticket !== importing) return; // a later file was opened meanwhile
  if ('error' in prepared) {
    toast(t(prepared.error), 'error');
    return;
  }
  const source: ImportedSource = {
    type: file.kind, name: file.name, sha256: file.sha256, content: file.content,
    strokes: prepared.strokes, originalJumpRatio: prepared.originalJumpRatio,
  };
  tCycle = 0;
  if (settings) {
    store.set({ source, ...settings, mode: 'play', demo: null, selectedK: null });
  } else {
    // N for the path's length, then the fewest circles within 0.25% of the drawing's size (DECISIONS.md D28).
    const N = prepared.N;
    const probe = pipeline.compute({ source, N, M: N - 1, order: store.get().order });
    store.set({ source, N, M: suggestM(probe.ordered.energy.dropped, N), mode: 'play', demo: null, selectedK: null });
  }
  const s = store.get();
  const notes = Object.entries(prepared.warnings).map(([key, n]) => t(key, { n }));
  toast([t('import.done', { name: file.name, strokes: prepared.strokeCount, N: String(s.N), M: String(s.M) }), ...notes].join(' '), '');
}

async function openProject(text: string): Promise<void> {
  const parsed = parseProject(text);
  if ('error' in parsed) {
    toast(t(`project.error.${parsed.error}`), 'error');
    return;
  }
  const p = parsed.project;
  const settings: Settings = { N: p.N, M: p.M, order: p.order, speed: p.speed, view: p.view };
  const src = p.source;
  if (src.type === 'random' || src.type === 'freehand') {
    tCycle = 0;
    store.set({ source: src, ...settings, mode: 'play', demo: null, selectedK: null });
    toast([t('project.loaded'), ...parsed.warnings.map(w => t(w))].join(' '), '');
    return;
  }
  if (src.content === undefined) {
    relink = { kind: src.type, sha256: src.sha256, settings };
    toast(t('project.needFile', { name: src.name }), '', true);
    return;
  }
  if (src.type === 'image') {
    const decoded = dataUrlToBytes(src.content);
    if (!decoded) {
      toast(t('project.error.source'), 'error');
      return;
    }
    if ((await sha256Hex(decoded.bytes)) !== src.sha256) toast(t('project.hashMismatch'), 'error');
    await openImage(src.name, decoded.bytes, decoded.mime, settings);
    return;
  }
  const kind = src.type, content = src.content;
  if ((await sha256Hex(content)) !== src.sha256) toast(t('project.hashMismatch'), 'error');
  await importDrawing({ kind, name: src.name, sha256: src.sha256, content }, () => prepareImport(kind, content, s => worker.tour(s)), settings);
}

// Files dropped anywhere on the page, or pasted (after line2func's viewer/app.js).
const dropOverlay = $('#drop-overlay');
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
window.addEventListener('dragover', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dropOverlay.hidden = false;
});
window.addEventListener('dragleave', e => { if (e.relatedTarget === null) dropOverlay.hidden = true; });
window.addEventListener('drop', e => {
  e.preventDefault();
  dropOverlay.hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (file) void openFile(file);
});
window.addEventListener('paste', e => {
  const target = e.target as HTMLElement | null;
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
  const file = e.clipboardData?.files?.[0];
  if (file) {
    e.preventDefault();
    void openFile(file);
  }
});

bindKeys({
  togglePlay: () => store.set({ playing: !store.get().playing }),
  step: (dir, fine) => { const s = store.get(); store.set({ M: stepM(s.M, s.N, dir, fine) }); },
  draw: () => enterDraw(),
  escape: () => {
    const s = store.get();
    if (s.mode === 'draw') leaveDraw();
    else if (s.demo) toggleDemo();
  },
  openFile: () => fileInput.click(),
});

// ---------------------------------------------------------------- showing the state

const GENERATOR_KEYS: Record<GeneratorName, string> = { creature: 'gen.creature', scribble: 'gen.scribble', star: 'gen.star' };
let formulaFor: { ordered: Ordered; M: number; lang: Lang } | null = null;

function showControls(s: AppState): void {
  $('#play').setAttribute('aria-pressed', String(s.playing));
  $('#play-label').dataset.i18n = s.playing ? 'ctrl.pause' : 'ctrl.play';
  $('#play-label').textContent = t(s.playing ? 'ctrl.pause' : 'ctrl.play');
  $('#demo').setAttribute('aria-pressed', String(!!s.demo));
  $('#draw').setAttribute('aria-pressed', String(s.mode === 'draw'));
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === s.lang));

  const ticks = mTicks(s.N);
  mRange.max = String(ticks.length - 1);
  mRange.value = String(sliderIndex(s.M, ticks));
  mRange.setAttribute('aria-valuetext', t('m.valuetext', { n: s.M }));
  mNumber.max = String(s.N - 1);
  if (document.activeElement !== mNumber) mNumber.value = String(s.M);
  speedRange.value = String(SPEEDS.indexOf(s.speed));
  $('#speed-out').textContent = `${s.speed}×`;
  speedRange.setAttribute('aria-valuetext', `${s.speed}×`);
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="order"]')) r.checked = r.value === s.order;
  $<HTMLInputElement>('#show-circles').checked = s.view.showCircles;
  $<HTMLInputElement>('#show-original').checked = s.view.showOriginal;
  $<HTMLInputElement>('#follow').checked = s.view.follow;
  $('#zoom-field').hidden = !s.view.follow;
  zoomRange.value = String(Math.round((100 * Math.log(s.view.zoom)) / Math.log(50)));
  $('#zoom-out').textContent = `${s.view.zoom.toFixed(1)}×`;
  zoomRange.setAttribute('aria-valuetext', `${s.view.zoom.toFixed(1)}×`);
  nSelect.value = String(s.N);
  if (s.source.type === 'random') {
    generatorSelect.value = s.source.generator;
    if (document.activeElement !== seedInput) seedInput.value = String(s.source.seed);
  }
  $('#embed-row').hidden = s.source.type === 'random' || s.source.type === 'freehand';

  const src = s.source;
  const status = src.type === 'random'
    ? t('status.random', { M: String(s.M), N: String(s.N), kind: t(GENERATOR_KEYS[src.generator]), seed: String(src.seed) })
    : src.type === 'freehand'
      ? t('status.freehand', { M: String(s.M), N: String(s.N) })
      : t('status.import', { kind: t(`kind.${src.type}`), name: src.name, strokes: src.strokes.length, M: String(s.M), N: String(s.N) });
  $('#status').textContent = s.demo ? `${status} · ${t('status.demo', { step: s.demo.step + 1, steps: demoSequence(s.N).length })}` : status;
  view.canvas.setAttribute('aria-label', t('canvas.label', { n: s.M }));
}

function showMetrics(): void {
  if (!computed) return;
  const c = computed, size = c.size;
  $('#metric-energy').textContent = formatEnergy(c.metrics.energy);
  $('#metric-rms').textContent = formatShare(c.metrics.rmsError, size);
  $('#metric-mean').textContent = formatShare(c.metrics.meanDeviation, size);
  const big = c.largest;
  $('#metric-largest').textContent = big
    ? t(big.k > 0 ? 'metrics.largestCcw' : 'metrics.largestCw', { r: formatShare(big.amp, size), n: Math.abs(big.k) })
    : '—';
  // Spec §4.6: the share of the path that is pen-up jumps, against the file's own order.
  const src = store.get().source;
  $('#metric-jumps-row').hidden = c.jumpRatio === 0;
  $('#metric-jumps').textContent = src.type === 'svg' || src.type === 'line2func'
    ? t('metrics.jumpsValue', { p: formatShare(c.jumpRatio, 1), q: formatShare(src.originalJumpRatio, 1) })
    : formatShare(c.jumpRatio, 1);
}

/** The k range of the spectrum panel: every term in use, unless a range was picked. */
function spectrumK(s: AppState): number {
  const v = spectrumRange.value;
  if (v === 'all') return s.N / 2;
  if (v !== 'auto') return Math.min(Number(v), s.N / 2);
  return autoRange(new Set(computed.ordered.terms.slice(0, computed.M).map(c => c.k)), s.N);
}

function showSpectrum(s: AppState): void {
  if (!computed) return;
  const used = new Set(computed.ordered.terms.slice(0, computed.M).map(c => c.k));
  spectrumView.set({ spectrum: computed.spectrum, used, selected: s.selectedK, K: spectrumK(s) });
  const readout = $('#spectrum-readout');
  const c = s.selectedK === null ? undefined : computed.spectrum.find(x => x.k === s.selectedK);
  if (!c) {
    readout.textContent = t('spectrum.hint');
    return;
  }
  const deg = (c.phase * 180) / Math.PI;
  readout.textContent = `${t('spectrum.readout', { k: String(c.k), amp: c.amp.toPrecision(4), arg: c.phase.toFixed(4), deg: deg.toFixed(1) })}${used.has(c.k) ? '' : ` ${t('spectrum.unused')}`}`;
}

function showFormula(s: AppState): void {
  if (!computed) return;
  const f = formulaFor;
  if (f && f.ordered === computed.ordered && f.M === computed.M && f.lang === s.lang) return;
  formulaFor = { ordered: computed.ordered, M: computed.M, lang: s.lang };
  const { c0, terms, M } = currentTerms();
  void renderMath($('#formula'), toLatexPreview(c0, terms, M));
  $('#formula-count').textContent = t('formula.count', { n: M });
  const note = $('#desmos-note');
  const notes = [M > 1000 ? t('desmos.slow') : '', computed.jumpRatio > 0 ? t('desmos.jumps') : ''].filter(Boolean);
  note.hidden = notes.length === 0;
  note.textContent = notes.join(' ');
}

function showAll(s: AppState): void {
  showControls(s);
  showMetrics();
  showFormula(s);
  showSpectrum(s);
  outputs.update();
}

const outputs = mountOutputs({ state: () => store.get(), computed: () => computed, scene: () => view.scene, style: () => view.style });

store.subscribe((s, prev) => {
  if (s.lang !== prev.lang) {
    setLang(s.lang);
    writeLocal(LANG_KEY, s.lang);
  }
  if (s.source !== prev.source || s.N !== prev.N || s.M !== prev.M || s.order !== prev.order) {
    if (!recompute(s)) {
      // Keep the drawing that works; this set() does not fail again.
      store.set({ source: prev.source, N: prev.N, M: prev.M, order: prev.order });
      return;
    }
    if (s.source !== prev.source) {
      tCycle = 0;
      firstCycleDone = reducedMotion;
    }
  }
  if (s.mode !== prev.mode) setDrawing(s.mode === 'draw');
  dirty = true;
  showAll(s);
});

// ---------------------------------------------------------------- start

// Read-only state for the end-to-end tests and for curious people with a console.
Object.defineProperty(window, '__l2f', {
  value: Object.freeze({
    debug() {
      const s = store.get();
      const cam = view.lastCamera ?? view.baseCamera();
      const joints = view.scene?.joints;
      const circles = computed.ordered.terms.slice(0, computed.M).map((c, j) => ({
        k: c.k,
        r: c.amp * cam.s,
        x: joints ? cam.ox + cam.s * (joints[2 * j] - cam.cx) : NaN,
        y: joints ? cam.oy - cam.s * (joints[2 * j + 1] - cam.cy) : NaN,
      }));
      return {
        state: {
          ...s,
          source: s.source.type === 'random' ? s.source
            : s.source.type === 'freehand' ? { type: s.source.type, points: s.source.points.length }
              : { type: s.source.type, name: s.source.name, sha256: s.source.sha256, strokes: s.source.strokes.length, originalJumpRatio: s.source.originalJumpRatio },
        },
        t: tCycle,
        firstCycleDone,
        M: computed.M,
        N: computed.N,
        size: computed.size,
        metrics: computed.metrics,
        jumpRatio: computed.jumpRatio,
        used: computed.ordered.terms.slice(0, computed.M).map(c => c.k),
        strokes: computed.strokes.length,
        highlight: view.last?.highlight
          ? { x: cam.ox + cam.s * (view.last.highlight.x - cam.cx), y: cam.oy - cam.s * (view.last.highlight.y - cam.cy), r: view.last.highlight.r * cam.s, j: view.last.highlight.j }
          : null,
        spectrumK: spectrumK(s),
        /** Midpoints of the original path's segments of each kind, on screen (0 ink, 1 closure, 2 jump). */
        mids: (kind: number) => Array.from(computed.path.kinds).flatMap((k, i) => {
          if (k !== kind) return [];
          const a = computed.path.poly[i], b = computed.path.poly[(i + 1) % computed.path.poly.length];
          return [[cam.ox + cam.s * ((a[0] + b[0]) / 2 - cam.cx), cam.oy - cam.s * ((a[1] + b[1]) / 2 - cam.cy)]];
        }),
        tipScreen: view.last ? [cam.ox + cam.s * (view.last.tip[0] - cam.cx), cam.oy - cam.s * (view.last.tip[1] - cam.cy)] : null,
        spectrumUsed: [...(spectrumView.input?.used ?? [])],
        spectrumX: (k: number) => spectrumView.clientXOf(k),
        circles,
        frame: view.last,
        calls: { ...pipeline.calls },
        timings: { ...timings },
      };
    },
  }),
});

setLang(store.get().lang);
document.documentElement.classList.remove('i18n-pending');
if (!recompute(store.get())) throw new Error('the first drawing failed');
showAll(store.get());
requestAnimationFrame(t0 => { lastFrame = t0; requestAnimationFrame(frame); });
