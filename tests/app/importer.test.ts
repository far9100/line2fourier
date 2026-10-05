// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { detectKind, prepareImport, sha256Hex, type RouteFn } from '../../src/app/importer.ts';
import { AGAIN, JUMP, buildPath, strokesBBox } from '../../src/core/path.ts';
import { routeStrokes } from '../../src/core/route.ts';

const route: RouteFn = async (strokes, reach) => routeStrokes(strokes, reach);

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
    expect(detectKind('x.png', '\u0089PNG')).toBe('image');
    expect(detectKind('photo', '', 'image/jpeg')).toBe('image');
    expect(detectKind('drawing', '<svg/>', 'image/svg+xml')).toBe('svg');
    expect(detectKind('notes.txt', 'hello')).toBeNull();
  });

  it('an SVG with several subpaths becomes one walk in [-1, 1]², with N for its length', async () => {
    const p = await prepareImport('svg', svg, route);
    if ('error' in p) throw new Error(p.error);
    expect(p.strokeCount).toBe(4);
    expect(p.penDownStrokes).toBe(4); // the shapes are far apart: nothing to join
    expect(p.lifts).toBeGreaterThan(0);
    expect(p.jumpRatio).toBeGreaterThan(0);
    expect(p.jumpRatio).toBeLessThanOrEqual(p.originalJumpRatio);
    expect(p.jumpRatio).toBe(buildPath(p.strokes).lengths[JUMP] / buildPath(p.strokes).total);
    const b = strokesBBox(p.strokes);
    expect(Math.max(b.maxX - b.minX, b.maxY - b.minY)).toBeCloseTo(2, 9);
    expect([1024, 2048, 4096, 8192]).toContain(p.N);
    expect(p.warnings).toEqual({});
  });

  it('strokes whose ends nearly meet are joined into one pen-down stroke (D38)', async () => {
    const twoLines = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M10 10 L60 10 M60.2 10 L100 50"/></svg>`;
    const p = await prepareImport('svg', twoLines, route);
    if ('error' in p) throw new Error(p.error);
    expect(p.strokeCount).toBe(2);
    expect(p.penDownStrokes).toBe(1);
    expect(p.warnings).toEqual({ 'import.bridged': 1 });
    expect(p.jumpRatio).toBeLessThan(p.originalJumpRatio);
    // One open line now: the pen walks back along it rather than jump from its end to its start.
    expect(p.lifts).toBe(0);
    expect(p.strokes.map(s => !!s.again)).toEqual([false, true]);
  });

  it('strokes that nearly touch along their length are joined there, and the pen walks back instead of jumping (D46)', async () => {
    // A T whose stem stops 0.6 short of the bar: 0.375% of the drawing, which is 160 wide.
    const tee = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M20 40 H180 M100 40.6 V180"/></svg>`;
    const p = await prepareImport('svg', tee, route);
    if ('error' in p) throw new Error(p.error);
    expect(p.strokeCount).toBe(2);
    expect(p.penDownStrokes).toBe(2); // not end to end: nothing for D38 to join
    expect(p.warnings).toEqual({ 'import.linked': 1 });
    expect(p.lifts).toBe(0);
    expect(p.jumpRatio).toBe(0);
    expect(p.originalJumpRatio).toBeGreaterThan(0.3);
    const path = buildPath(p.strokes);
    expect(path.lengths[AGAIN]).toBeCloseTo(path.total / 2, 9); // out along both lines and the link, and back
  });

  it('if no walk is found the drawing still opens, chained in the file’s order, and says so', async () => {
    const failing: RouteFn = async () => { throw new Error('no walk'); };
    const p = await prepareImport('svg', svg, failing);
    if ('error' in p) throw new Error(p.error);
    expect(p.warnings).toEqual({ 'import.unrouted': 1 });
    expect(p.strokes).toHaveLength(4);
    expect(p.jumpRatio).toBe(p.originalJumpRatio);
  });

  it('says why a file cannot be used', async () => {
    expect(await prepareImport('svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', route)).toEqual({ error: 'error.path.empty' });
    expect(await prepareImport('svg', 'not xml', route)).toEqual({ error: 'import.error.svg' });
    expect(await prepareImport('line2func', '{"format":"line2func.curves","version":3}', route)).toEqual({ error: 'import.error.curves.version' });
  });

  it('hashes the text with SHA-256', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
