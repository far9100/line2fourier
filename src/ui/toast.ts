// One short message at a time at the bottom of the page (after line2func's viewer/app.js).
let timer: ReturnType<typeof setTimeout> | undefined;

export function toast(text: string, kind: '' | 'error' = '', sticky = false): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.className = kind;
  el.hidden = false;
  clearTimeout(timer);
  if (!sticky) timer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 7000 : 3500);
}

/** Take the message away now. */
export function hideToast(): void {
  clearTimeout(timer);
  const el = document.getElementById('toast');
  if (el) el.hidden = true;
}
