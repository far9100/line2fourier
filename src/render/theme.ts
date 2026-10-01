// The canvas takes its colours from the same CSS custom properties as the page (spec §7), so the
// light and dark themes stay in one place: src/styles/main.css.

export interface Style {
  paper: string;
  ink: string;
  orbit: string;
  brass: string;
  select: string;
  warn: string;
  /** The pen-up moves between strokes. */
  jump: string;
}

export function readStyle(el: Element = document.documentElement): Style {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    paper: v('--paper', '#EEF2F6'),
    ink: v('--ink', '#1E2B44'),
    orbit: v('--orbit', '#93A1B8'),
    brass: v('--brass', '#B7791F'),
    select: v('--select', '#2A9D8F'),
    warn: v('--warn', '#C8423B'),
    jump: v('--jump', '#7B5CC4'),
  };
}
