// The approximation at the current M as one SVG path in real units (spec §8), for pen plotters and
// laser engravers: pen-up jumps become moves, so nothing is drawn where the drawing has no line.
import { traceCurve, type CurveEvents } from '../render/curve.ts';

export interface SvgOptions {
  /** Width of the drawing on paper, in millimetres; the height follows the drawing's proportions. */
  widthMm: number;
  /** Line width in millimetres. */
  strokeMm: number;
}

const fmt = (v: number) => {
  const s = v.toFixed(4);
  return s === '-0.0000' ? '0.0000' : s;
};

export function toSvg(ev: CurveEvents, opt: SvgOptions): string {
  // Collect the drawn pieces in world coordinates first: their extent sets the viewBox.
  const parts: string[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const sink = (cmd: 'M' | 'L') => (x: number, y: number) => {
    parts.push(`${cmd}${fmt(x)} ${fmt(-y)}`); // SVG's y points down
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (-y < minY) minY = -y;
    if (-y > maxY) maxY = -y;
  };
  const writer = { moveTo: sink('M'), lineTo: sink('L') };
  traceCurve(ev, 1, null, writer, writer);
  if (parts.length === 0) throw new Error('nothing to draw');

  const w = maxX - minX || 1, h = maxY - minY || 1;
  const pad = 0.02 * Math.max(w, h);
  const vbW = w + 2 * pad, vbH = h + 2 * pad;
  const mmPerUnit = opt.widthMm / vbW;
  const heightMm = vbH * mmPerUnit;
  const strokeUnits = opt.strokeMm / mmPerUnit;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(opt.widthMm)}mm" height="${fmt(heightMm)}mm" viewBox="${fmt(minX - pad)} ${fmt(minY - pad)} ${fmt(vbW)} ${fmt(vbH)}">`,
    `<path d="${parts.join('')}" fill="none" stroke="#000" stroke-width="${fmt(strokeUnits)}" stroke-linecap="round" stroke-linejoin="round"/>`,
    '</svg>',
    '',
  ].join('\n');
}
