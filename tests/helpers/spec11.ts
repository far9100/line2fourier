// The spec's §11 reference implementation, read from line2fourier-spec.md itself (not a copy), so
// the tests can check src/core/fourier.ts against exactly what the spec prints.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import type * as Fourier from '../../src/core/fourier.ts';

export type SpecReference = Pick<typeof Fourier,
  'resampleClosed' | 'fft' | 'coefficients' | 'orderTerms' | 'chainAt' | 'partialCurve' | 'metrics' | 'toDesmos' | 'mulberry32'>;

export function loadSpecReference(): SpecReference {
  const md = readFileSync(new URL('../../line2fourier-spec.md', import.meta.url), 'utf8');
  const section = md.slice(md.indexOf('## 11.'));
  const start = section.indexOf('```ts') + '```ts'.length;
  const code = section.slice(start, section.indexOf('```', start));
  const body = stripTypeScriptTypes(code).replace(/^export\s+/gm, '');
  const names = [...body.matchAll(/^function\s+(\w+)/gm)].map(m => m[1]);
  return new Function(`${body}\nreturn { ${names.join(', ')} };`)() as SpecReference;
}
