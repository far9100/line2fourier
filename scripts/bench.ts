// Timing of the core against spec §6 ("N = 1024: recompute < 10 ms"; 60 fps animation at M ≤ 300).
// Run with Node ≥ 22.18 / 24 (type stripping): node scripts/bench.ts
import { chainInto, coefficients, metrics, orderTerms, partialCurve } from '../src/core/fourier.ts';
import { generate } from '../src/core/generators.ts';
import { buildPath, samplePath } from '../src/core/path.ts';

function time(run: () => void, budgetMs = 400): number {
  run(); // warm up
  const start = performance.now();
  let n = 0;
  while (performance.now() - start < budgetMs) { run(); n++; }
  return (performance.now() - start) / n;
}

const path = buildPath([generate('creature', 42)]);
for (const N of [1024, 4096, 8192]) {
  const ms = time(() => {
    const s = samplePath(path, N);
    const { c0, terms } = orderTerms(coefficients(s.pts));
    metrics(s.pts, partialCurve(c0, terms, 50, N), terms, 50);
  });
  console.log(`N = ${String(N).padEnd(4)}  resample + FFT + order + partial curve + metrics: ${ms.toFixed(3)} ms`);
}

const s = samplePath(path, 1024);
const { c0, terms } = orderTerms(coefficients(s.pts));
const joints = new Float64Array(2 * 300 + 2);
let frame = 0;
const us = 1000 * time(() => chainInto(c0, terms, 300, (frame++ % 480) / 480, joints));
console.log(`chain of M = 300 circles: ${us.toFixed(1)} µs per frame`);
