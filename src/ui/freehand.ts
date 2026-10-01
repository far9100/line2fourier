// "自己畫" (spec §5.2): one stroke with a mouse, a finger or a pen. Points closer than 2 px to the
// previous one are skipped; fewer than 8 points or less than 60 px of line is rejected.
import type { Pt } from '../core/fourier.ts';

export const MIN_STEP_PX = 2;
export const MIN_POINTS = 8;
export const MIN_LENGTH_PX = 60;

/** Whether a stroke, in screen pixels, is long enough to draw with circles. */
export function longEnough(screen: Pt[]): boolean {
  if (screen.length < MIN_POINTS) return false;
  let length = 0;
  for (let i = 1; i < screen.length; i++) length += Math.hypot(screen[i][0] - screen[i - 1][0], screen[i][1] - screen[i - 1][1]);
  return length >= MIN_LENGTH_PX;
}

export interface FreehandOptions {
  target: HTMLElement;
  toWorld(clientX: number, clientY: number): Pt;
  /** The stroke so far in world units, or null when it is thrown away. */
  onDraft(points: Pt[] | null): void;
  onDone(points: Pt[]): void;
  onTooShort(): void;
}

/** Start listening; the returned function stops. Only the first pointer counts (no multi-touch). */
export function startFreehand(o: FreehandOptions): () => void {
  let active: number | null = null;
  let screen: Pt[] = [];
  let world: Pt[] = [];

  const add = (e: PointerEvent) => {
    const last = screen[screen.length - 1];
    if (last && Math.hypot(e.clientX - last[0], e.clientY - last[1]) <= MIN_STEP_PX) return;
    screen.push([e.clientX, e.clientY]);
    world.push(o.toWorld(e.clientX, e.clientY));
  };
  const down = (e: PointerEvent) => {
    if (active !== null || !e.isPrimary || e.button !== 0) return;
    active = e.pointerId;
    try { o.target.setPointerCapture(e.pointerId); } catch { /* the pointer may already be gone */ }
    screen = [];
    world = [];
    add(e);
    o.onDraft(world);
    e.preventDefault();
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== active) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) add(ev);
    o.onDraft(world);
    e.preventDefault();
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== active) return;
    active = null;
    if (longEnough(screen)) {
      o.onDone(world.slice());
    } else {
      o.onDraft(null);
      o.onTooShort();
    }
    screen = [];
    world = [];
  };
  const target = o.target;
  target.addEventListener('pointerdown', down);
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
  return () => {
    target.removeEventListener('pointerdown', down);
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
    active = null;
  };
}
