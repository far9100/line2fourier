// The page: state, the pipeline, the canvas and the controls, wired together.
import 'katex/dist/katex.min.css';
import './styles/main.css';
import { advance, cycleMs } from './app/clock.ts';
import { createPipeline, type Computed, type Ordered } from './app/pipeline.ts';
import { bytesToDataUrl, dataUrlToBytes, decodeImage } from './app/image.ts';
import { detectKind, finishImport, imageStrokes, prepareImport, sha256Hex, type Prepared, type RouteFn } from './app/importer.ts';
import { parseProject, projectText, savedSource, type ProjectFile } from './app/project.ts';
import { ZOOM_MAX, defaultState, normalizeState, type AppState, type ImportKind, type ImportedSource, type SourceSpec } from './app/state.ts';
import { createStore } from './app/store.ts';
import { partialCurve, type Pt } from './core/fourier.ts';
import { GENERATORS, newSeed, type GeneratorName } from './core/generators.ts';
import { PathError } from './core/path.ts';
import { N_CHOICES, SPEEDS, clampM, demoSequence, mTicks, sliderIndex, stepM, suggestM, type NSize } from './core/ticks.ts';
import { DESMOS_LIST_MAX, SLIDER_MIN_TERMS, toDesmos, toDesmosSlider } from './export/desmos.ts';
import { copyText, downloadText } from './export/download.ts';
import { toCoefficientsJson } from './export/json.ts';
import { toLatex, toLatexPreview } from './export/latex.ts';
import { toSvg } from './export/svg.ts';
import { detectLang, setLang, t, type Lang } from './i18n/index.ts';
import { UNIT_BOX } from './render/camera.ts';
import { CanvasView } from './render/canvasView.ts';
import { curveEvents, tipAt, tipSampler } from './render/curve.ts';
import { buildScene } from './render/scene.ts';
import { SpectrumView, autoRange } from './render/spectrumView.ts';
import { formatShare } from './ui/format.ts';
import { renderMath } from './ui/formula.ts';
import { startFreehand } from './ui/freehand.ts';
import { bindKeys } from './ui/keyboard.ts';
import { mountOutputs } from './ui/outputs.ts';
import { hideToast, toast } from './ui/toast.ts';
import { bindViewGestures } from './ui/viewGestures.ts';
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
/** Just before the end of a cycle: the whole curve drawn, the pen back near its start. */
const WHOLE = 1 - 1e-9;

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
/** The kind of random drawing the page opened with: a seed typed later gives one of that kind. */
const opening = store.get().source;
const openingKind: GeneratorName = opening?.type === 'random' ? opening.generator : 'creature';
const pipeline = createPipeline();
const view = new CanvasView($<HTMLCanvasElement>('#view'), () => {
  dirty = true;
  spectrumView.style = view.style;
  spectrumView.draw();
  outputs.update();
});
const spectrumView = new SpectrumView($<HTMLCanvasElement>('#spectrum'), view.style);
const worker = createWorkerClient();

/** The drawing, worked out; null while the canvas is cleared (DECISIONS.md D51). */
let computed: Computed | null = null;
/** The drawing, where there has to be one: what is done with it cannot be reached without. */
function drawn(): Computed {
  if (!computed) throw new Error('no drawing');
  return computed;
}
let tCycle = 0;
let firstCycleDone = reducedMotion;
/** The drawing is done: the pen has been round once and stopped where it started (DECISIONS.md D50). */
let finished = false;
let draft: Pt[] | null = null;
let dirty = true;
let lastFrame = performance.now();
/** Milliseconds: the last pipeline run, building what is drawn from it, and a running average of drawing one frame (spec §6). */
const timings = { recompute: 0, scene: 0, render: 0 };

/** Above this many span edges × circles, the edges are read off a denser curve instead of summed one by one (DECISIONS.md D47). */
const EXACT_EDGE_WORK = 100_000;

/** Where the curve is at the edge of a span: the series summed there, or, for many edges, a curve sampled densely once. */
function edgeTip(c: Computed, N = c.N): (t: number) => Pt {
  const { c0, terms } = c.ordered, M = c.M;
  const edges = 2 * (c.spans.jump.length + c.spans.closure.length + c.spans.fill.length + c.spans.again.length);
  if (edges * M > EXACT_EDGE_WORK) return tipSampler(c0, terms, M, N);
  const scratch = new Float64Array(2 * M + 2);
  return t => tipAt(c0, terms, M, t, scratch);
}

/** Run the pipeline; on a drawing that cannot be used, say why and keep the previous one. */
function recompute(s: AppState): boolean {
  if (!s.source) {
    computed = null;
    view.scene = null;
    view.fitTo(UNIT_BOX);
    timings.recompute = timings.scene = 0;
    dirty = true;
    return true;
  }
  let next: Computed;
  const started = performance.now();
  try {
    next = pipeline.compute({ source: s.source, N: s.N, M: s.M, order: s.order });
  } catch (e) {
    if (e instanceof PathError) {
      toast(t(`error.path.${e.code}`), 'error');
      return false;
    }
    throw e;
  }
  timings.recompute = performance.now() - started;
  const changed = !computed || next.approx !== computed.approx || next.spans !== computed.spans;
  // A new drawing is shown whole; changing M, N or the order leaves the view where it is.
  if (!computed || next.strokes !== computed.strokes) view.fitTo(next.box);
  computed = next;
  if (changed) {
    const built = performance.now();
    view.scene = buildScene(next, curveEvents(next.approx, next.spans, edgeTip(next), next.path.fillWidth));
    timings.scene = performance.now() - built;
  }
  dirty = true;
  return true;
}

// ---------------------------------------------------------------- animation

/** Back to the start of a cycle, to be drawn from there. */
function rewind(): void {
  tCycle = 0;
  finished = false;
}

/**
 * The pen is back where it started. The demo goes on to its next count; otherwise the drawing is
 * done and the pen stops there, the whole line on screen, until it is played again (DECISIONS.md D50).
 */
function cycleEnded(): void {
  const s = store.get();
  const steps = demoSequence(s.N);
  if (s.demo && s.demo.step + 1 < steps.length) {
    store.set({ demo: { ...s.demo, step: s.demo.step + 1 }, M: steps[s.demo.step + 1] });
    return;
  }
  finished = true;
  tCycle = WHOLE;
  firstCycleDone = true;
  if (s.demo) store.set({ demo: null, M: s.demo.returnM });
}

function frame(now: number): void {
  const s = store.get();
  const dt = now - lastFrame;
  lastFrame = now;
  const running = s.playing && !finished && s.mode === 'play' && !!view.scene;
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

/** Following the pen: it stays in the middle, at the zoom kept for following. */
const following = (s: AppState) => s.view.follow && s.mode !== 'draw';

function draw(): void {
  const s = store.get();
  const drawing = s.mode === 'draw';
  // Paused for reduced motion and not started: the whole curve, as the spec asks.
  const t = reducedMotion && !s.playing && tCycle === 0 ? WHOLE : tCycle;
  let camera = view.freeCamera();
  if (following(s) && computed) {
    const { c0, terms } = computed.ordered;
    camera = view.followCamera(tipAt(c0, terms, computed.M, t), s.view.zoom);
  }
  showZoom(following(s) ? s.view.zoom : view.zoom);
  view.render({
    t,
    camera,
    showCircles: s.view.showCircles,
    showOriginal: s.view.showOriginal || drawing,
    showJumps: s.view.showJumps,
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
const seedInput = $<HTMLInputElement>('#seed');
const fileInput = $<HTMLInputElement>('#file-input');

speedRange.max = String(SPEEDS.length - 1);
for (const N of N_CHOICES) nSelect.append(new Option(String(N), String(N)));

/** Take the drawing off the canvas: nothing is shown until a line is drawn or a file opened (DECISIONS.md D51). */
function clearDrawing(): void {
  const s = store.get();
  importing++; // a file still being read is not shown when it is ready
  hideToast(); // nor is anything still said about the drawing that was there
  draft = null;
  store.set({ source: null, mode: 'play', demo: null, M: s.demo ? s.demo.returnM : s.M, selectedK: null });
}

$('#clear').addEventListener('click', clearDrawing);
$('#seed-apply').addEventListener('click', applySeed);
seedInput.addEventListener('keydown', e => { if (e.key === 'Enter') applySeed(); });

function applySeed(): void {
  const text = seedInput.value.trim();
  const seed = Number(text);
  if (!/^\d+$/.test(text) || !(seed < 2 ** 32)) {
    toast(t('seed.invalid'), 'error');
    return;
  }
  // A random drawing of the kind on the canvas, or of the kind the page opened with.
  const s = store.get();
  const generator = s.source?.type === 'random' ? s.source.generator : openingKind;
  store.set({ source: { type: 'random', generator, seed }, mode: 'play', demo: null, M: s.demo ? s.demo.returnM : s.M, selectedK: null });
}

$('#draw').addEventListener('click', () => enterDraw());
$('#draw-cancel').addEventListener('click', () => leaveDraw());
$('#replay').addEventListener('click', replay);
$('#demo').addEventListener('click', toggleDemo);

/** Draw the line again from the start, whether it is done, under way or paused. */
function replay(): void {
  if (!computed) return;
  rewind();
  dirty = true;
  if (!store.get().playing) store.set({ playing: true });
}

/** The Space key: pause and go on; once the drawing is done, draw it again. */
function togglePlay(): void {
  if (!computed) return;
  if (finished) replay();
  else store.set({ playing: !store.get().playing });
}

function toggleDemo(): void {
  const s = store.get();
  if (!computed) return;
  if (s.demo) {
    store.set({ demo: null, M: s.demo.returnM });
    return;
  }
  rewind();
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
$<HTMLInputElement>('#show-jumps').addEventListener('change', e => {
  store.set({ view: { ...store.get().view, showJumps: (e.target as HTMLInputElement).checked } });
});
nSelect.addEventListener('change', () => store.set({ N: Number(nSelect.value) as NSize }));

// ---------------------------------------------------------------- moving around the drawing (DECISIONS.md D45)

// Following the pen (spec §6) keeps its own zoom, 1× to 50× the whole drawing, saved with the project;
// the free view zooms from ½× to 64× and is not saved.
$<HTMLInputElement>('#follow').addEventListener('change', e => {
  store.set({ view: { ...store.get().view, follow: (e.target as HTMLInputElement).checked } });
});

const zoomOut = $<HTMLOutputElement>('#view-zoom');
let zoomShown = '';
function showZoom(zoom: number): void {
  const text = `${zoom < 10 ? zoom.toFixed(1).replace(/\.0$/, '') : Math.round(zoom)}×`;
  if (text !== zoomShown) zoomOut.textContent = zoomShown = text;
}

function zoomView(factor: number, x = view.width / 2, y = view.height / 2): void {
  const s = store.get();
  if (following(s)) {
    const zoom = Math.min(ZOOM_MAX, Math.max(1, Math.round(s.view.zoom * factor * 100) / 100));
    store.set({ view: { ...s.view, zoom } });
  } else {
    view.zoomBy(factor, x, y);
  }
  dirty = true;
}

function panView(dx: number, dy: number): void {
  const s = store.get();
  if (following(s)) {
    // Taking hold of the view stops following, without a jump.
    if (view.lastCamera) view.takeView(view.lastCamera);
    store.set({ view: { ...s.view, follow: false } });
  }
  view.panBy(dx, dy);
  dirty = true;
}

function fitView(): void {
  const s = store.get();
  if (s.view.follow) store.set({ view: { ...s.view, follow: false } });
  view.fit();
  dirty = true;
}

const canvasWrap = $('#canvas-wrap');
const fullscreenButton = $<HTMLButtonElement>('#view-fullscreen');
fullscreenButton.hidden = !document.fullscreenEnabled;
function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  else if (document.fullscreenEnabled) void canvasWrap.requestFullscreen().catch(() => undefined);
}
document.addEventListener('fullscreenchange', () => {
  const on = document.fullscreenElement === canvasWrap;
  fullscreenButton.setAttribute('aria-pressed', String(on));
  const key = on ? 'view.exitFullscreen' : 'view.fullscreen';
  fullscreenButton.dataset.i18nAriaLabel = fullscreenButton.dataset.i18nTitle = key;
  fullscreenButton.setAttribute('aria-label', t(key));
  fullscreenButton.title = t(key);
});

$('#view-zoom-in').addEventListener('click', () => zoomView(1.5));
$('#view-zoom-out').addEventListener('click', () => zoomView(1 / 1.5));
$('#view-fit').addEventListener('click', fitView);
fullscreenButton.addEventListener('click', toggleFullscreen);
bindViewGestures(view.canvas, {
  enabled: () => store.get().mode !== 'draw',
  zoom: zoomView,
  pan: panView,
  reset: fitView,
  dragging: on => canvasWrap.classList.toggle('panning', on),
});

// The spectrum panel: pick a term with the pointer or the arrow keys; Esc lets go of it.
const spectrumRange = $<HTMLSelectElement>('#spectrum-range');
spectrumRange.addEventListener('change', () => showSpectrum(store.get()));
spectrumView.canvas.addEventListener('click', e => {
  const k = spectrumView.kAt(e.clientX);
  store.set({ selectedK: k === store.get().selectedK ? null : k });
});
spectrumView.canvas.addEventListener('keydown', e => {
  const s = store.get(), K = spectrumK(s, drawn());
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
  const c = drawn();
  return { c0: c.ordered.c0, terms: c.ordered.terms, M: c.M };
}

async function copy(text: string): Promise<void> {
  toast((await copyText(text)) ? t('toast.copied') : t('toast.copyFailed'), '');
}

$('#copy-desmos').addEventListener('click', () => {
  const { c0, terms, M } = currentTerms();
  void copy(toDesmos(c0, terms, Math.min(M, DESMOS_LIST_MAX)));
});
$('#copy-desmos-slider').addEventListener('click', async () => {
  const { c0, terms, M } = currentTerms();
  // Pasted text cannot set a slider's range: Desmos starts it at -10, so say how to fix it.
  const ok = await copyText(toDesmosSlider(c0, terms, M));
  const n = Math.min(terms.length, DESMOS_LIST_MAX, Math.max(M, SLIDER_MIN_TERMS));
  toast(ok ? t('toast.copiedSlider', { n: String(n) }) : t('toast.copyFailed'), '', ok);
});
$('#copy-latex').addEventListener('click', () => {
  const { c0, terms, M } = currentTerms();
  void copy(toLatex(c0, terms, M));
});
$('#download-json').addEventListener('click', () => {
  const s = store.get(), c = drawn();
  if (!s.source) return;
  // The source as a project names it: an opened file by name and hash, not its contents and every piece of the walk.
  const text = toCoefficientsJson(c.spectrum, c.ordered.terms, { M: c.M, order: s.order, source: savedSource(s.source, false) });
  downloadText(text, 'line2fourier-coefficients.json', 'application/json');
});
$('#download-svg').addEventListener('click', () => {
  const widthMm = Number($<HTMLInputElement>('#svg-width').value);
  const strokeMm = Number($<HTMLInputElement>('#svg-stroke').value);
  if (!(widthMm >= 10 && widthMm <= 3000) || !(strokeMm >= 0.05 && strokeMm <= 10)) {
    toast(t('export.svgInvalid'), 'error');
    return;
  }
  // Sample the curve at least 8192 times (exact trigonometric interpolation): smoother than N points when N is less.
  const c = drawn();
  const { c0, terms, M } = currentTerms();
  const fine = partialCurve(c0, terms, M, Math.max(c.N, 8192));
  const events = curveEvents(fine, c.spans, edgeTip(c, fine.length), c.path.fillWidth);
  downloadText(toSvg(events, { widthMm, strokeMm }), 'line2fourier.svg', 'image/svg+xml');
});
$('#project-save').addEventListener('click', () => {
  if (!store.get().source) return;
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

/** The walk over an opened drawing's strokes is found in the worker (core/route.ts). */
const route: RouteFn = (strokes, reach) => worker.route(strokes, reach);

/** A project whose imported drawing was not embedded: the next such file opened is taken as that drawing. */
let relink: { kind: ImportKind; sha256: string; settings: Settings; notes: string[] } | null = null;

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
    const project = await takeRelink(kind, text);
    await importDrawing({ kind, name: file.name, sha256: await sha256Hex(text), content: text }, () => prepareImport(kind, text, route), project?.settings, project?.notes);
  } else {
    toast(t('import.error.unknown'), 'error');
  }
}

/** A project waiting for this file, if it is the kind it waits for (the hash is checked, not required). */
async function takeRelink(kind: ImportKind, data: string | Uint8Array): Promise<{ settings: Settings; notes: string[] } | undefined> {
  const pending = relink;
  relink = null;
  if (!pending || pending.kind !== kind) return undefined;
  const notes = [...pending.notes];
  if ((await sha256Hex(data)) !== pending.sha256) notes.push(t('project.hashMismatch'));
  return { settings: pending.settings, notes };
}

/** Spec §5.5: the browser decodes the image; thinning and tracing run in the worker. */
async function openImage(name: string, bytes: Uint8Array, mime: string, settings?: Settings, notes: string[] = []): Promise<void> {
  if (!settings) {
    const project = await takeRelink('image', bytes);
    settings = project?.settings;
    notes = project?.notes ?? notes;
  }
  const sha256 = await sha256Hex(bytes);
  await importDrawing({ kind: 'image', name, sha256, content: bytesToDataUrl(bytes, mime) }, async () => {
    let img;
    try {
      img = await decodeImage(bytes, mime);
    } catch {
      return { error: 'import.error.image' };
    }
    const traced = await worker.raster(img.data, img.width, img.height);
    return finishImport(imageStrokes(traced.strokes, traced.h), { ...traced.warnings }, route);
  }, settings, notes);
}

let importing = 0;

interface Incoming { kind: ImportKind; name: string; sha256: string; content: string }

async function importDrawing(file: Incoming, prepare: () => Promise<Prepared | { error: string }>, settings?: Settings, projectNotes: string[] = []): Promise<void> {
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
    strokes: prepared.strokes, strokeCount: prepared.penDownStrokes, originalJumpRatio: prepared.originalJumpRatio,
  };
  rewind();
  if (settings) {
    store.set({ source, ...settings, mode: 'play', demo: null, selectedK: null });
  } else {
    // N for the path's length, then the fewest circles within 0.08% of the drawing's size (DECISIONS.md D47).
    const N = prepared.N;
    const probe = pipeline.compute({ source, N, M: N - 1, order: store.get().order });
    store.set({ source, N, M: suggestM(probe.ordered.energy.dropped, N), mode: 'play', demo: null, selectedK: null });
  }
  const s = store.get();
  const notes = Object.entries(prepared.warnings).map(([key, n]) => t(key, { n }));
  toast([t('import.done', { name: file.name, strokes: prepared.strokeCount, N: String(s.N), M: String(s.M) }), ...notes, ...projectNotes].join(' '), '');
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
    rewind();
    store.set({ source: src, ...settings, mode: 'play', demo: null, selectedK: null });
    toast([t('project.loaded'), ...parsed.warnings.map(w => t(w))].join(' '), '');
    return;
  }
  const notes = parsed.warnings.map(w => t(w));
  if (src.content === undefined) {
    relink = { kind: src.type, sha256: src.sha256, settings, notes };
    toast(t('project.needFile', { name: src.name }), '', true);
    return;
  }
  if (src.type === 'image') {
    const decoded = dataUrlToBytes(src.content);
    if (!decoded) {
      toast(t('project.error.source'), 'error');
      return;
    }
    if ((await sha256Hex(decoded.bytes)) !== src.sha256) notes.push(t('project.hashMismatch'));
    await openImage(src.name, decoded.bytes, decoded.mime, settings, notes);
    return;
  }
  const kind = src.type, content = src.content;
  if ((await sha256Hex(content)) !== src.sha256) notes.push(t('project.hashMismatch'));
  await importDrawing({ kind, name: src.name, sha256: src.sha256, content }, () => prepareImport(kind, content, route), settings, notes);
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
  togglePlay,
  step: (dir, fine) => { const s = store.get(); store.set({ M: stepM(s.M, s.N, dir, fine) }); },
  draw: () => enterDraw(),
  escape: () => {
    const s = store.get();
    if (s.mode === 'draw') leaveDraw();
    else if (s.demo) toggleDemo();
  },
  openFile: () => fileInput.click(),
  zoom: dir => zoomView(dir > 0 ? 1.5 : 1 / 1.5),
  fit: fitView,
  fullscreen: toggleFullscreen,
});

// ---------------------------------------------------------------- showing the state

const GENERATOR_KEYS: Record<GeneratorName, string> = { creature: 'gen.creature', scribble: 'gen.scribble', star: 'gen.star' };
let formulaFor: { ordered: Ordered; M: number; lang: Lang } | null = null;

function showControls(s: AppState): void {
  // With the canvas cleared there is nothing to clear, to replay, to measure or to save (DECISIONS.md D51).
  const none = !s.source, drawing = s.mode === 'draw';
  $<HTMLButtonElement>('#clear').disabled = none && !drawing;
  $<HTMLButtonElement>('#replay').disabled = none || drawing;
  $<HTMLButtonElement>('#demo').disabled = none;
  $<HTMLButtonElement>('#project-save').disabled = none;
  $('#empty-hint').hidden = !none || drawing;
  $('.app').classList.toggle('no-drawing', none);
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
  $<HTMLInputElement>('#show-jumps').checked = s.view.showJumps;
  $<HTMLInputElement>('#follow').checked = s.view.follow;
  nSelect.value = String(s.N);
  const src = s.source;
  if (src?.type === 'random' && document.activeElement !== seedInput) seedInput.value = String(src.seed);
  $('#embed-row').hidden = !src || src.type === 'random' || src.type === 'freehand';

  const status = !src
    ? t('status.empty')
    : src.type === 'random'
      ? t('status.random', { M: String(s.M), N: String(s.N), kind: t(GENERATOR_KEYS[src.generator]), seed: String(src.seed) })
      : src.type === 'freehand'
        ? t('status.freehand', { M: String(s.M), N: String(s.N) })
        : t('status.import', { kind: t(`kind.${src.type}`), name: src.name, strokes: src.strokeCount, M: String(s.M), N: String(s.N) });
  $('#status').textContent = s.demo ? `${status} · ${t('status.demo', { step: s.demo.step + 1, steps: demoSequence(s.N).length })}` : status;
  view.canvas.setAttribute('aria-label', src ? t('canvas.label', { n: s.M }) : t('canvas.empty'));
}

function showMetrics(): void {
  if (!computed) return;
  const c = computed;
  $('#metric-rms').textContent = formatShare(c.metrics.rmsError, c.size);
  // Spec §4.6: the share of the path that is pen-up jumps, against the file's own order.
  const src = store.get().source;
  $('#metric-jumps-row').hidden = c.jumpRatio === 0;
  $('#metric-jumps').textContent = src && src.type !== 'random' && src.type !== 'freehand'
    ? t('metrics.jumpsValue', { p: formatShare(c.jumpRatio, 1), q: formatShare(src.originalJumpRatio, 1) })
    : formatShare(c.jumpRatio, 1);
}

/** The k range of the spectrum panel: every term in use, unless a range was picked. */
function spectrumK(s: AppState, drawing: Computed): number {
  const v = spectrumRange.value;
  if (v === 'all') return s.N / 2;
  if (v !== 'auto') return Math.min(Number(v), s.N / 2);
  return autoRange(new Set(drawing.ordered.terms.slice(0, drawing.M).map(c => c.k)), s.N);
}

function showSpectrum(s: AppState): void {
  if (!computed) return;
  const used = new Set(computed.ordered.terms.slice(0, computed.M).map(c => c.k));
  spectrumView.set({ spectrum: computed.spectrum, used, selected: s.selectedK, K: spectrumK(s, computed) });
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
  const notes = [
    M > DESMOS_LIST_MAX ? t('desmos.limit') : M > 1000 ? t('desmos.slow') : '',
    computed.jumpRatio > 0 ? t('desmos.jumps') : '',
  ].filter(Boolean);
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
      rewind();
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
      const cam = view.lastCamera ?? view.freeCamera();
      const src = s.source;
      const base = {
        state: {
          ...s,
          source: !src ? null
            : src.type === 'random' ? src
              : src.type === 'freehand' ? { type: src.type, points: src.points.length }
                : { type: src.type, name: src.name, sha256: src.sha256, strokes: src.strokeCount, originalJumpRatio: src.originalJumpRatio },
        },
        /** The canvas is cleared (DECISIONS.md D51): what describes a drawing is then left out. */
        empty: !computed,
        t: tCycle,
        firstCycleDone,
        finished,
        /** The free view's zoom (1: the whole drawing) and the scale in pixels per world unit. */
        viewZoom: view.zoom,
        scale: cam.s,
        camera: { ...cam },
        frame: view.last,
        calls: { ...pipeline.calls },
        timings: { ...timings },
      };
      const c = computed;
      if (!c || !src) return base;
      const joints = view.scene?.joints;
      const circles = c.ordered.terms.slice(0, c.M).map((term, j) => ({
        k: term.k,
        r: term.amp * cam.s,
        x: joints ? cam.ox + cam.s * (joints[2 * j] - cam.cx) : NaN,
        y: joints ? cam.oy - cam.s * (joints[2 * j + 1] - cam.cy) : NaN,
      }));
      return {
        ...base,
        M: c.M,
        N: c.N,
        size: c.size,
        metrics: c.metrics,
        jumpRatio: c.jumpRatio,
        used: c.ordered.terms.slice(0, c.M).map(term => term.k),
        /** The drawing's strokes; an opened drawing is walked in more pieces than that (DECISIONS.md D46). */
        strokes: src.type === 'random' || src.type === 'freehand' ? c.strokes.length : src.strokeCount,
        pieces: c.strokes.length,
        /** Lengths of the path by kind: 0 ink, 1 closure, 2 jump, 3 fill, 4 walked again. */
        lengths: Array.from(c.path.lengths),
        highlight: view.last?.highlight
          ? { x: cam.ox + cam.s * (view.last.highlight.x - cam.cx), y: cam.oy - cam.s * (view.last.highlight.y - cam.cy), r: view.last.highlight.r * cam.s, j: view.last.highlight.j }
          : null,
        spectrumK: spectrumK(s, c),
        fillWidth: c.path.fillWidth,
        /** Midpoints of the original path's segments of each kind, on screen (0 ink, 1 closure, 2 jump, 3 fill, 4 walked again). */
        mids: (kind: number) => Array.from(c.path.kinds).flatMap((k, i) => {
          if (k !== kind) return [];
          const a = c.path.poly[i], b = c.path.poly[(i + 1) % c.path.poly.length];
          return [[cam.ox + cam.s * ((a[0] + b[0]) / 2 - cam.cx), cam.oy - cam.s * ((a[1] + b[1]) / 2 - cam.cy)]];
        }),
        tipScreen: view.last ? [cam.ox + cam.s * (view.last.tip[0] - cam.cx), cam.oy - cam.s * (view.last.tip[1] - cam.cy)] : null,
        spectrumUsed: [...(spectrumView.input?.used ?? [])],
        spectrumX: (k: number) => spectrumView.clientXOf(k),
        circles,
      };
    },
  }),
});

setLang(store.get().lang);
document.documentElement.classList.remove('i18n-pending');
if (!recompute(store.get())) throw new Error('the first drawing failed');
showAll(store.get());
requestAnimationFrame(t0 => { lastFrame = t0; requestAnimationFrame(frame); });
