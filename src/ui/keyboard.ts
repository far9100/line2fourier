// Keys (spec §6): Space plays and pauses, ← / → change the number of circles (Shift: by one), D starts
// drawing, Esc cancels drawing or the demo, Ctrl/⌘+O opens a file.

export interface KeyActions {
  togglePlay(): void;
  step(dir: 1 | -1, fine: boolean): void;
  draw(): void;
  escape(): void;
  openFile(): void;
}

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
}

export function bindKeys(actions: KeyActions): void {
  document.addEventListener('keydown', e => {
    // An input method is composing (zh-TW users type through one): the keys are not ours.
    if (e.isComposing || e.key === 'Process') return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      actions.openFile();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') {
      actions.escape();
      return;
    }
    // Form controls keep their own keys (a range input's arrows, a button's Space).
    if (isEditable(e.target)) return;
    if (e.key === ' ') {
      if (e.repeat || (e.target instanceof HTMLElement && e.target.tagName === 'BUTTON')) return;
      e.preventDefault();
      actions.togglePlay();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      actions.step(e.key === 'ArrowRight' ? 1 : -1, e.shiftKey);
    } else if ((e.key === 'd' || e.key === 'D' || e.code === 'KeyD') && !e.repeat) {
      actions.draw();
    }
  });
}
