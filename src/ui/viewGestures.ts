// Moving around the drawing (DECISIONS.md D45): the wheel (or a trackpad pinch) zooms about the
// pointer, dragging moves the view, two fingers pinch and move it, a double click shows the whole
// drawing again. Off while a line is being drawn by hand, which needs the pointer itself.

export interface ViewGestures {
  /** False while drawing by hand. */
  enabled(): boolean;
  /** Zoom by `factor` about the canvas point (x, y), in CSS pixels. */
  zoom(factor: number, x: number, y: number): void;
  /** Move the view by (dx, dy) CSS pixels. */
  pan(dx: number, dy: number): void;
  /** Show the whole drawing. */
  reset(): void;
  /** A drag starts or ends (for the cursor). */
  dragging(on: boolean): void;
}

/** How much one wheel notch (100 pixels of deltaY) zooms. */
const WHEEL_STEP = 1.25;

export function bindViewGestures(canvas: HTMLCanvasElement, g: ViewGestures): void {
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };

  canvas.addEventListener('wheel', e => {
    if (!g.enabled()) return;
    e.preventDefault();
    const pixels = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const [x, y] = local(e);
    g.zoom(WHEEL_STEP ** (-pixels / 100), x, y);
  }, { passive: false });

  const pointers = new Map<number, { x: number; y: number }>();
  const pair = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  canvas.addEventListener('pointerdown', e => {
    if (!g.enabled() || (e.pointerType === 'mouse' && e.button !== 0) || pointers.size >= 2) return;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = local(e);
    pointers.set(e.pointerId, { x, y });
    if (pointers.size === 1) g.dragging(true);
  });

  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p || !g.enabled()) return;
    const [x, y] = local(e);
    if (pointers.size === 1) {
      g.pan(x - p.x, y - p.y);
      p.x = x;
      p.y = y;
      return;
    }
    const before = pair();
    p.x = x;
    p.y = y;
    const after = pair();
    if (before.d > 0 && after.d > 0) g.zoom(after.d / before.d, after.x, after.y);
    g.pan(after.x - before.x, after.y - before.y);
  });

  const lift = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 0) g.dragging(false);
  };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);

  canvas.addEventListener('dblclick', e => {
    if (!g.enabled()) return;
    e.preventDefault();
    g.reset();
  });
}
