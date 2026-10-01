// The approximation at the current M as an SVG path in real units (spec §8), for pen plotters and
// laser engravers: pen-up jumps become moves, so nothing is drawn where the drawing has no line.
// Painted areas are a second path, drawn with the wide pen (DECISIONS.md D42); a plotter that
// draws them with its own pen still paints them solid if that pen is at least a third as wide.
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
  const lines: string[] = [], paint: string[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const sink = (parts: string[], cmd: 'M' | 'L') => (x: number, y: number) => {
    parts.push(`${cmd}${fmt(x)} ${fmt(-y)}`); // SVG's y points down
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (-y < minY) minY = -y;
    if (-y > maxY) maxY = -y;
  };
  const writer = { moveTo: sink(lines, 'M'), lineTo: sink(lines, 'L') };
  const painter = { moveTo: sink(paint, 'M'), lineTo: sink(paint, 'L') };
  traceCurve(ev, 1, null, writer, writer, painter);
  if (lines.length === 0 && paint.length === 0) throw new Error('nothing to draw');

  const w = maxX - minX || 1, h = maxY - minY || 1;
  const pad = Math.max(0.02 * Math.max(w, h), ev.fillWidth / 2);
  const vbW = w + 2 * pad, vbH = h + 2 * pad;
  const mmPerUnit = opt.widthMm / vbW;
  const heightMm = vbH * mmPerUnit;
  const strokeUnits = opt.strokeMm / mmPerUnit;
  const path = (parts: string[], width: number) =>
    `<path d="${parts.join('')}" fill="none" stroke="#000" stroke-width="${fmt(width)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(opt.widthMm)}mm" height="${fmt(heightMm)}mm" viewBox="${fmt(minX - pad)} ${fmt(minY - pad)} ${fmt(vbW)} ${fmt(vbH)}">`,
    ...(paint.length ? [path(paint, Math.max(ev.fillWidth, strokeUnits))] : []),
    ...(lines.length ? [path(lines, strokeUnits)] : []),
    '</svg>',
    '',
  ].join('\n');
}
