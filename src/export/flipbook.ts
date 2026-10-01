// A printable flipbook (spec §8): one cycle in 32 frames, 8 cards on each of 4 A4 pages, to print
// at 100%, cut along the marks and bind at the left. The layout is pure arithmetic in millimetres
// (tested on its own); the PDF draws everything as vectors (DECISIONS.md D36).
import type { Pt } from '../core/fourier.ts';

export const MM_TO_PT = 72 / 25.4;

export interface Rect { x: number; y: number; w: number; h: number }

export interface Card {
  /** 0-based frame number; frame f shows the drawing at t = (f + 1) / frames, so the last one is complete. */
  frame: number;
  t: number;
  page: number;
  card: Rect;
  /** The strip on the left that is stapled or glued, with the frame number. */
  binding: Rect;
  /** Where the epicycles are drawn. */
  art: Rect;
}

export interface Layout {
  pageWidth: number;
  pageHeight: number;
  pages: number;
  cards: Card[];
  /** Short trim marks outside the cards: [x1, y1, x2, y2] in mm from the top-left corner. */
  marks: [number, number, number, number][];
  /** Dashed cut lines between and around the cards. */
  cuts: [number, number, number, number][];
  /** Where page 1's printing instruction goes. */
  note: Rect;
}

export const A4 = { width: 210, height: 297 };

export function flipbookLayout(frames = 32): Layout {
  const margin = { top: 12, left: 12, right: 12, bottom: 20 };
  const cols = 2, rows = 4, perPage = cols * rows;
  const cw = (A4.width - margin.left - margin.right) / cols; // 93
  const ch = (A4.height - margin.top - margin.bottom) / rows; // 66.25
  const bind = 18, pad = 4;
  const cards: Card[] = [];
  for (let f = 0; f < frames; f++) {
    const slot = f % perPage, col = slot % cols, row = Math.floor(slot / cols);
    const x = margin.left + col * cw, y = margin.top + row * ch;
    cards.push({
      frame: f,
      t: (f + 1) / frames,
      page: Math.floor(f / perPage),
      card: { x, y, w: cw, h: ch },
      binding: { x, y, w: bind, h: ch },
      art: { x: x + bind + pad, y: y + pad, w: cw - bind - 2 * pad, h: ch - 2 * pad },
    });
  }
  const xs = Array.from({ length: cols + 1 }, (_, i) => margin.left + i * cw);
  const ys = Array.from({ length: rows + 1 }, (_, i) => margin.top + i * ch);
  const top = ys[0], bottom = ys[rows], left = xs[0], right = xs[cols];
  const gap = 2, len = 5;
  const marks: Layout['marks'] = [];
  for (const x of xs) {
    marks.push([x, top - gap - len, x, top - gap]);
    marks.push([x, bottom + gap, x, bottom + gap + len]);
  }
  for (const y of ys) {
    marks.push([left - gap - len, y, left - gap, y]);
    marks.push([right + gap, y, right + gap + len, y]);
  }
  const cuts: Layout['cuts'] = [
    ...xs.map(x => [x, top, x, bottom] as [number, number, number, number]),
    ...ys.map(y => [left, y, right, y] as [number, number, number, number]),
  ];
  return {
    pageWidth: A4.width,
    pageHeight: A4.height,
    pages: Math.ceil(frames / perPage),
    cards,
    marks,
    cuts,
    note: { x: left, y: bottom + gap + len + 1, w: right - left, h: A4.height - (bottom + gap + len + 1) - 3 },
  };
}

/** What one frame shows, in world units: the trail so far (pen-down pieces), the circles, the arms and the pen. */
export interface FrameArt {
  trail: Pt[][];
  /** The pieces of the trail that paint an area, drawn fillWidth wide. */
  paint: Pt[][];
  fillWidth: number;
  circles: { x: number; y: number; r: number }[];
  arms: Pt[];
  tip: Pt;
}

export interface FlipbookOptions {
  /** World units per millimetre are chosen so [-half, half] fits the shorter side of a card's art box. */
  half: number;
  /** Page 1's printing instruction as a PNG (rendered by the page in its own fonts), or none. */
  notePng?: Uint8Array;
  title?: string;
}

export async function exportFlipbook(artAt: (t: number) => FrameArt, layout: Layout, opt: FlipbookOptions): Promise<Uint8Array> {
  const { LineCapStyle, PDFDocument, PrintScaling, StandardFonts, rgb } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.setTitle(opt.title ?? 'line2fourier flipbook');
  doc.setProducer('line2fourier');
  doc.setCreator('line2fourier');
  doc.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = Array.from({ length: layout.pages }, () => doc.addPage([layout.pageWidth * MM_TO_PT, layout.pageHeight * MM_TO_PT]));
  const H = layout.pageHeight;
  const pt = (mm: number) => mm * MM_TO_PT;
  const grey = rgb(0.55, 0.6, 0.68), ink = rgb(0.12, 0.17, 0.27), brass = rgb(0.72, 0.47, 0.12);

  for (const page of pages) {
    for (const [x1, y1, x2, y2] of layout.marks) {
      page.drawLine({ start: { x: pt(x1), y: pt(H - y1) }, end: { x: pt(x2), y: pt(H - y2) }, thickness: 0.5, color: ink });
    }
    for (const [x1, y1, x2, y2] of layout.cuts) {
      page.drawLine({ start: { x: pt(x1), y: pt(H - y1) }, end: { x: pt(x2), y: pt(H - y2) }, thickness: 0.3, color: grey, dashArray: [3, 3] });
    }
  }
  if (opt.notePng) {
    const image = await doc.embedPng(opt.notePng);
    const n = layout.note, w = Math.min(n.w, (n.h * image.width) / image.height);
    pages[0].drawImage(image, { x: pt(n.x), y: pt(H - n.y - (w * image.height) / image.width), width: pt(w), height: pt((w * image.height) / image.width) });
  }

  for (const c of layout.cards) {
    const page = pages[c.page];
    const label = String(c.frame + 1);
    page.drawText(label, { x: pt(c.binding.x + 3), y: pt(H - c.binding.y - 7), size: 9, font, color: grey });
    const a = c.art, s = Math.min(a.w, a.h) / 2 / opt.half;
    const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
    const X = (x: number) => cx + s * x, Y = (y: number) => cy - s * y; // mm, y down (as SVG paths are)
    const path = (pts: Pt[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(3)} ${Y(p[1]).toFixed(3)}`).join('');
    const art = artAt(c.t);
    const svg = { x: 0, y: pt(H), scale: MM_TO_PT };
    for (const circle of art.circles) {
      if (s * circle.r < 0.3) continue; // smaller than 0.3 mm on paper
      const x = X(circle.x), y = Y(circle.y);
      if (x + s * circle.r < a.x || x - s * circle.r > a.x + a.w || y + s * circle.r < a.y || y - s * circle.r > a.y + a.h) continue;
      page.drawCircle({ x: pt(x), y: pt(H - y), size: pt(s * circle.r), borderColor: grey, borderWidth: 0.25 });
    }
    if (art.arms.length > 1) page.drawSvgPath(path(art.arms), { ...svg, borderColor: ink, borderWidth: 0.3 });
    const paintWidth = Math.max(0.8, s * art.fillWidth); // mm: drawSvgPath scales the line width too
    for (const piece of art.paint) if (piece.length > 1) page.drawSvgPath(path(piece), { ...svg, borderColor: brass, borderWidth: paintWidth, borderLineCap: LineCapStyle.Round });
    for (const piece of art.trail) if (piece.length > 1) page.drawSvgPath(path(piece), { ...svg, borderColor: brass, borderWidth: 0.8 });
    page.drawCircle({ x: pt(X(art.tip[0])), y: pt(H - Y(art.tip[1])), size: 1.6, color: brass });
  }
  return doc.save({ useObjectStreams: false });
}
