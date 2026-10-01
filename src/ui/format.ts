// Numbers for the metrics card (spec §4.5; the energy ratio is no longer shown, DECISIONS.md D45).

/** A length as a share of the drawing's size: 3 significant digits, at most 2 decimals above 1%. */
export function formatShare(value: number, size: number): string {
  const p = size > 0 ? (100 * value) / size : 0;
  if (p === 0) return '0%';
  if (p >= 10) return `${p.toFixed(1)}%`;
  if (p >= 1) return `${p.toFixed(2)}%`;
  if (p >= 1e-4) return `${Number(p.toPrecision(3))}%`;
  return `${p.toExponential(1)}%`;
}
