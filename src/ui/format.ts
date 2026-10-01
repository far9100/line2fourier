// Numbers for the metrics card (spec §4.5).

/**
 * The energy ratio as a percentage, with enough decimals that the first digit short of 100% shows
 * (99.985%, 99.99997%), and never rounded up to 100% unless it is exactly 1 (DECISIONS.md D12).
 */
export function formatEnergy(e: number): string {
  if (!(e < 1)) return '100%';
  const p = Math.max(0, e) * 100;
  const rest = 100 - p;
  const digits = Math.min(10, Math.max(1, Math.ceil(-Math.log10(rest)) + 1));
  const scale = 10 ** digits;
  return `${(Math.floor(p * scale) / scale).toFixed(digits)}%`;
}

/** A length as a share of the drawing's size: 3 significant digits, at most 2 decimals above 1%. */
export function formatShare(value: number, size: number): string {
  const p = size > 0 ? (100 * value) / size : 0;
  if (p === 0) return '0%';
  if (p >= 10) return `${p.toFixed(1)}%`;
  if (p >= 1) return `${p.toFixed(2)}%`;
  if (p >= 1e-4) return `${Number(p.toPrecision(3))}%`;
  return `${p.toExponential(1)}%`;
}
