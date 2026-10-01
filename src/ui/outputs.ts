// The "make something" card (spec §8, M3): a video of one cycle, a printable flipbook and
// oscilloscope audio with a live XY preview.
import type { Ordered, Computed } from '../app/pipeline.ts';
import type { AppState } from '../app/state.ts';
import { chainInto, type Pt } from '../core/fourier.ts';
import { CYCLE_SECONDS } from '../core/ticks.ts';
import { DEFAULT_F0, F0_CHOICES, SAMPLE_RATE, WAV_SECONDS, encodeWav, synthesizePeriod, type Period } from '../export/audio.ts';
import { downloadBlob } from '../export/download.ts';
import { exportFlipbook, flipbookLayout, type FrameArt } from '../export/flipbook.ts';
import { exportVideo } from '../export/video.ts';
import { t } from '../i18n/index.ts';
import { VIEW_HALF, makeCamera } from '../render/camera.ts';
import { traceCurve } from '../render/curve.ts';
import { drawFrame, type Scene } from '../render/scene.ts';
import type { Style } from '../render/theme.ts';
import { AudioPlayer, drawXY } from './audioPlayer.ts';
import { toast } from './toast.ts';

export interface OutputDeps {
  state(): Readonly<AppState>;
  computed(): Computed;
  scene(): Scene | null;
  style(): Style;
}

const VIDEO_SIZE = 1080;
const VIDEO_FPS = 30;
const FLIPBOOK_FRAMES = 32;

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector(selector) as T;
const pct = (v: number) => `${(100 * v).toFixed(v < 0.001 ? 3 : 1)}%`;

/** The text under the frames of page 1, drawn by the page itself (in its own fonts) at 600 dpi. */
async function notePng(text: string, color: string): Promise<Uint8Array> {
  const pxPerMm = 600 / 25.4;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(186 * pxPerMm);
  canvas.height = Math.round(6 * pxPerMm);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.font = `${Math.round(3 * pxPerMm)}px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, canvas.height / 2, canvas.width);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** One flipbook frame: the trail drawn so far, the circles and arms, and the pen. */
export function frameArt(scene: Scene, t: number): FrameArt {
  const { c0, terms } = scene.computed.ordered;
  const M = scene.computed.M;
  const joints = new Float64Array(2 * M + 2);
  chainInto(c0, terms, M, t, joints);
  const tip: Pt = [joints[2 * M], joints[2 * M + 1]];
  const trail: Pt[][] = [], paint: Pt[][] = [];
  const into = (pieces: Pt[][]) => ({
    moveTo: (x: number, y: number) => { pieces.push([[x, y]]); },
    lineTo: (x: number, y: number) => { pieces[pieces.length - 1].push([x, y]); },
  });
  traceCurve(scene.events, t, tip, into(trail), into(trail), into(paint));
  const arms: Pt[] = [[0, 0]];
  for (let j = 0; j <= M; j++) arms.push([joints[2 * j], joints[2 * j + 1]]);
  const circles = terms.slice(0, M).map((c, j) => ({ x: joints[2 * j], y: joints[2 * j + 1], r: c.amp }));
  return { trail, paint, fillWidth: scene.events.fillWidth, circles, arms, tip };
}

export function mountOutputs(deps: OutputDeps): { frame(): void; update(): void } {
  const player = new AudioPlayer();
  const f0Select = $<HTMLSelectElement>('#f0');
  const volume = $<HTMLInputElement>('#volume');
  const xy = $<HTMLCanvasElement>('#xy');
  for (const f of F0_CHOICES) f0Select.append(new Option(`${f} Hz`, String(f)));
  f0Select.value = String(DEFAULT_F0);

  let period: Period | null = null;
  let periodFor: { ordered: Ordered; M: number; f0: number } | null = null;
  let staticDrawn = false;
  const xs = new Float32Array(2048), ys = new Float32Array(2048);

  const currentPeriod = (): Period => {
    const c = deps.computed(), f0 = Number(f0Select.value);
    if (!period || !periodFor || periodFor.ordered !== c.ordered || periodFor.M !== c.M || periodFor.f0 !== f0) {
      period = synthesizePeriod(c.ordered.terms, c.M, f0);
      periodFor = { ordered: c.ordered, M: c.M, f0 };
      staticDrawn = false;
      if (player.playing) void player.play(period, Number(volume.value) / 100);
    }
    return period;
  };

  const showNote = () => {
    const p = currentPeriod(), f0 = Number(f0Select.value);
    $('#scope-note').textContent = p.dropped > 0
      ? t('scope.note', { kept: p.kept, dropped: p.dropped, nyquist: String(SAMPLE_RATE / 2), energy: pct(p.droppedEnergy) })
      : t('scope.noteAll', { kept: p.kept, max: String(Math.floor((SAMPLE_RATE / 2 - 1) / f0)) });
  };

  const setPlaying = (on: boolean) => {
    $('#audio-toggle').setAttribute('aria-pressed', String(on));
    const label = $('#audio-label');
    label.dataset.i18n = on ? 'scope.stop' : 'scope.play';
    label.textContent = t(on ? 'scope.stop' : 'scope.play');
  };

  $('#audio-toggle').addEventListener('click', async () => {
    if (player.playing) {
      player.stop();
      staticDrawn = false;
    } else {
      await player.play(currentPeriod(), Number(volume.value) / 100);
    }
    setPlaying(player.playing);
  });
  volume.addEventListener('input', () => player.setVolume(Number(volume.value) / 100));
  f0Select.addEventListener('change', () => { currentPeriod(); showNote(); });

  $('#wav-export').addEventListener('click', () => {
    const p = currentPeriod(), f0 = Number(f0Select.value);
    const wav = encodeWav(p.x, p.y, WAV_SECONDS * f0);
    downloadBlob(new Blob([wav], { type: 'audio/wav' }), `line2fourier-${f0}Hz.wav`);
  });

  // Video: a second click while encoding cancels it.
  let abort: AbortController | null = null;
  const videoButton = $('#video-export');
  const progress = $('#video-progress');
  videoButton.addEventListener('click', async () => {
    if (abort) { abort.abort(); return; }
    const scene = deps.scene();
    if (!scene) return;
    const s = deps.state(), style = deps.style();
    abort = new AbortController();
    videoButton.textContent = t('video.cancel');
    progress.hidden = false;
    const camera = makeCamera(VIDEO_SIZE, VIDEO_SIZE);
    try {
      const result = await exportVideo(
        (ctx, time) => drawFrame(ctx, scene, {
          t: time, width: VIDEO_SIZE, height: VIDEO_SIZE, dpr: 1, camera, style,
          showCircles: s.view.showCircles, showOriginal: s.view.showOriginal, showJumps: s.view.showJumps,
          showFull: false, draft: null, highlightK: null,
        }),
        { width: VIDEO_SIZE, height: VIDEO_SIZE, fps: VIDEO_FPS, seconds: CYCLE_SECONDS / s.speed },
        done => { progress.textContent = t('video.progress', { p: String(Math.round(100 * done)) }); },
        abort.signal,
      );
      downloadBlob(result.blob, `line2fourier${result.extension}`);
      toast(result.exact ? t('video.done') : t('video.approx'), '');
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) toast(t('video.failed', { reason: e instanceof Error ? e.message : String(e) }), 'error');
    } finally {
      abort = null;
      videoButton.textContent = t('video.export');
      progress.hidden = true;
    }
  });

  $('#flipbook-export').addEventListener('click', async () => {
    const scene = deps.scene();
    if (!scene) return;
    const note = await notePng(t('flipbook.note'), '#56647C').catch(() => undefined);
    const pdf = await exportFlipbook(time => frameArt(scene, time), flipbookLayout(FLIPBOOK_FRAMES), { half: VIEW_HALF, notePng: note });
    downloadBlob(new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }), 'line2fourier-flipbook.pdf');
    toast(t('flipbook.done'), '');
  });

  return {
    /** Every animation frame: the live XY trace while playing, otherwise the period drawn once. */
    frame() {
      const style = deps.style();
      const colors = { paper: style.paper, trace: style.brass, grid: style.orbit };
      if (player.read(xs, ys)) {
        drawXY(xy, xs, ys, colors);
        staticDrawn = false;
      } else if (!staticDrawn) {
        const p = currentPeriod();
        drawXY(xy, p.x, p.y, colors);
        staticDrawn = true;
      }
    },
    update() {
      currentPeriod();
      showNote();
      staticDrawn = false;
    },
  };
}
