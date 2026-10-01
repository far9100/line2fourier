// One cycle of the animation as a video (spec §8). Frames are drawn one by one at exact times and
// encoded with WebCodecs through mediabunny (MP4/H.264 where the browser can, else WebM/VP9 or VP8),
// so the file lasts exactly one cycle and seeks properly. A browser without VideoEncoder records
// the canvas in real time with MediaRecorder instead (DECISIONS.md D34).

/** F frames at times i·T/F, each T/F long: one cycle exactly, even when T·fps is not a whole number. */
export function videoPlan(seconds: number, fps: number): { frames: number; dt: number } {
  const frames = Math.max(1, Math.round(seconds * fps));
  return { frames, dt: seconds / frames };
}

export interface VideoOptions { width: number; height: number; fps: number; seconds: number }

export interface VideoResult { blob: Blob; extension: string; exact: boolean }

export async function exportVideo(
  draw: (ctx: CanvasRenderingContext2D, t: number) => void,
  o: VideoOptions,
  onProgress: (done: number) => void,
  signal?: AbortSignal,
): Promise<VideoResult> {
  const canvas = document.createElement('canvas');
  canvas.width = o.width;
  canvas.height = o.height;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  if (typeof VideoEncoder === 'function') {
    const mb = await import('mediabunny');
    const codec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9', 'vp8'], { width: o.width, height: o.height });
    if (codec) {
      const format = codec === 'avc' ? new mb.Mp4OutputFormat() : new mb.WebMOutputFormat();
      const output = new mb.Output({ format, target: new mb.BufferTarget() });
      const source = new mb.CanvasSource(canvas, { codec, quality: mb.QUALITY_HIGH, keyFrameInterval: 1 });
      output.addVideoTrack(source, { frameRate: o.fps });
      await output.start();
      const { frames, dt } = videoPlan(o.seconds, o.fps);
      for (let i = 0; i < frames; i++) {
        if (signal?.aborted) {
          await output.cancel();
          throw new DOMException('cancelled', 'AbortError');
        }
        draw(ctx, i / frames);
        await source.add(i * dt, dt);
        onProgress((i + 1) / frames);
      }
      await output.finalize();
      return { blob: new Blob([output.target.buffer!], { type: format.mimeType }), extension: format.fileExtension, exact: true };
    }
  }
  return record(canvas, ctx, draw, o, onProgress, signal);
}

/** The fallback: draw in real time and let MediaRecorder capture the canvas (length approximate). */
function record(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  draw: (ctx: CanvasRenderingContext2D, t: number) => void,
  o: VideoOptions,
  onProgress: (done: number) => void,
  signal?: AbortSignal,
): Promise<VideoResult> {
  const type = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  if (!type) return Promise.reject(new Error('no video encoder'));
  const stream = canvas.captureStream(o.fps);
  const recorder = new MediaRecorder(stream, { mimeType: type });
  const chunks: Blob[] = [];
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  return new Promise((resolve, reject) => {
    let start = 0;
    const tick = (now: number) => {
      if (signal?.aborted) { recorder.stop(); reject(new DOMException('cancelled', 'AbortError')); return; }
      if (!start) start = now;
      const t = (now - start) / 1000 / o.seconds;
      draw(ctx, Math.min(t, 1));
      onProgress(Math.min(t, 1));
      if (t < 1) requestAnimationFrame(tick);
      else recorder.stop();
    };
    recorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      if (!signal?.aborted) resolve({ blob: new Blob(chunks, { type }), extension: type.startsWith('video/mp4') ? '.mp4' : '.webm', exact: false });
    };
    recorder.start();
    requestAnimationFrame(tick);
  });
}
