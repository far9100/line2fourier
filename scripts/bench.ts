// Timing of the core against spec §6 ("N = 1024: recompute < 10 ms"; 60 fps animation at M ≤ 300),
// and of what an opened drawing needs: 16384 samples, thousands of circles, the span edges read
// off a denser curve (DECISIONS.md D1, D47).
// Run with Node ≥ 22.18 / 24 (type stripping): node scripts/bench.ts
import { chainInto, coefficients, metrics, orderTerms, partialCurve } from '../src/core/fourier.ts';
import { generate } from '../src/core/generators.ts';
import { buildPath, samplePath } from '../src/core/path.ts';
import { tipAt, tipSampler } from '../src/render/curve.ts';

function time(run: () => void, budgetMs = 400): number {
  run(); // warm up
  const start = performance.now();
  let n = 0;
  while (performance.now() - start < budgetMs) { run(); n++; }
  return (performance.now() - start) / n;
}

const path = buildPath([generate('creature', 42)]);
for (const N of [1024, 4096, 8192, 16384]) {
  const ms = time(() => {
    const s = samplePath(path, N);
    const { c0, terms } = orderTerms(coefficients(s.pts));
    metrics(s.pts, partialCurve(c0, terms, 50, N), terms, 50);
  });
  console.log(`N = ${String(N).padEnd(5)}  resample + FFT + order + partial curve + metrics: ${ms.toFixed(3)} ms`);
}

const s = samplePath(path, 1024);
const { c0, terms } = orderTerms(coefficients(s.pts));
for (const M of [300, 1000]) {
  const joints = new Float64Array(2 * M + 2);
  let frame = 0;
  const us = 1000 * time(() => chainInto(c0, terms, M, (frame++ % 480) / 480, joints));
  console.log(`chain of M = ${M} circles: ${us.toFixed(1)} µs per frame`);
}

// An opened drawing: N = 16384, M = 5000, and 2,000 span edges (1,000 stretches that are not plain ink).
{
  const N = 16384, M = 5000, edges = 2000;
  const big = samplePath(path, N), o = orderTerms(coefficients(big.pts));
  const joints = new Float64Array(2 * M + 2), scratch = new Float64Array(2 * M + 2);
  let frame = 0;
  console.log(`N = ${N}, M = ${M}: moving the slider (partial curve + metrics) ${time(() => { metrics(big.pts, partialCurve(o.c0, o.terms, M, N), o.terms, M); }).toFixed(2)} ms`);
  console.log(`  chain: ${(1000 * time(() => chainInto(o.c0, o.terms, M, (frame++ % 480) / 480, joints))).toFixed(0)} µs per frame`);
  console.log(`  ${edges} span edges, each summed: ${time(() => { for (let i = 0; i < edges; i++) tipAt(o.c0, o.terms, M, i / edges, scratch); }, 1500).toFixed(1)} ms`);
  console.log(`  ${edges} span edges, read off a curve sampled 4 × N times: ${time(() => { const at = tipSampler(o.c0, o.terms, M, N); for (let i = 0; i < edges; i++) at(i / edges); }).toFixed(1)} ms`);
}
