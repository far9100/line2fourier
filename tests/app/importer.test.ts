// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { detectKind, prepareImport, sha256Hex } from '../../src/app/importer.ts';
import { strokesBBox } from '../../src/core/path.ts';
import { optimizeTour } from '../../src/core/tour.ts';

const tour = async (s: Parameters<typeof optimizeTour>[0]) => optimizeTour(s);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <path d="M10 10 L60 10 L60 60 Z M100 10 L150 40 M180 90 L120 90 L150 60"/>
  <circle cx="40" cy="80" r="10"/>
</svg>`;

describe('opening files', () => {
  it('tells the kinds of file apart', () => {
    expect(detectKind('a.svg', 'whatever')).toBe('svg');
    expect(detectKind('a.txt', '  <svg/>')).toBe('svg');
    expect(detectKind('c.json', '{"format":"line2func.curves","version":1}')).toBe('line2func');
    expect(detectKind('p.json', '{"format":"line2fourier.project"}')).toBe('project');
    expect(detectKind('p.json', '{"version":1,"source":{}}')).toBe('project');
    expect(detectKind('x.json', '{"a":1}')).toBeNull();
    expect(detectKind('x.png', '\u0089PNG')).toBeNull();
  });

  it('an SVG with several subpaths becomes ordered strokes in [-1, 1]², with N for its length', async () => {
    const p = await prepareImport('svg', svg, tour);
    if ('error' in p) throw new Error(p.error);
    expect(p.strokeCount).toBe(4);
    expect(p.jumpRatio).toBeGreaterThan(0);
    expect(p.jumpRatio).toBeLessThanOrEqual(p.originalJumpRatio);
    const b = strokesBBox(p.strokes);
    expect(Math.max(b.maxX - b.minX, b.maxY - b.minY)).toBeCloseTo(2, 9);
    expect([1024, 2048, 4096, 8192]).toContain(p.N);
    expect(p.warnings).toEqual({});
  });

  it('says why a file cannot be used', async () => {
    expect(await prepareImport('svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', tour)).toEqual({ error: 'error.path.empty' });
    expect(await prepareImport('svg', 'not xml', tour)).toEqual({ error: 'import.error.svg' });
    expect(await prepareImport('line2func', '{"format":"line2func.curves","version":3}', tour)).toEqual({ error: 'import.error.curves.version' });
  });

  it('hashes the text with SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
