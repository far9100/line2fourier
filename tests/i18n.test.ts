// The rules line2func's tests/test_i18n.py keeps, for this project: both languages have the same
// keys and placeholders, every key is used, every used key exists, and no Chinese text is written
// anywhere but the string files (so nothing on the page escapes translation).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { strings } from '../src/i18n/index.ts';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const zh = strings('zh-TW'), en = strings('en');
const CJK = /[　-〿㐀-鿿豈-﫿＀-￯]/;

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(name) ? [p] : [];
  });
}

/** Source text with comments removed (string literals kept). */
function code(path: string): string {
  return readFileSync(path, 'utf8').replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_match, str: string | undefined) => str ?? '',
  );
}

const sources = files(join(root, 'src'), /\.ts$/);
const html = readFileSync(join(root, 'index.html'), 'utf8');
const placeholders = (e: unknown) =>
  [...new Set(JSON.stringify(e).match(/\{\w+\}/g) ?? [])].sort();

describe('i18n', () => {
  it('both languages have the same keys and the same placeholders', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const key of Object.keys(zh)) expect(placeholders(en[key]), key).toEqual(placeholders(zh[key]));
  });

  it('plural entries always have an `other` form', () => {
    for (const table of [zh, en]) {
      for (const [key, v] of Object.entries(table)) if (typeof v === 'object') expect(v.other, key).toBeTypeOf('string');
    }
  });

  it('every key is used, and every key used exists', () => {
    const literals = new Set<string>();
    const prefixes: string[] = [];
    for (const f of sources) {
      const c = code(f);
      for (const m of c.matchAll(/'([\w.-]+)'|"([\w.-]+)"/g)) literals.add(m[1] ?? m[2]);
      for (const m of c.matchAll(/`([\w.-]+)\.\$\{/g)) prefixes.push(`${m[1]}.`);
    }
    const inHtml = [...html.matchAll(/data-i18n(?:-title|-aria-label)?="([\w.-]+)"/g)].map(m => m[1]);
    for (const k of inHtml) expect(zh[k], `index.html uses ${k}`).toBeDefined();
    const used = new Set([...inHtml, ...[...literals].filter(k => k in zh)]);
    const unused = Object.keys(zh).filter(k => !used.has(k) && !prefixes.some(p => k.startsWith(p)));
    expect(unused).toEqual([]);
  });

  it('no Chinese outside the string files (but the 中文 button), and none in en.json', () => {
    for (const f of [...sources, ...files(join(root, 'src'), /\.css$/)]) {
      expect(CJK.test(code(f)), f).toBe(false);
    }
    expect(CJK.test(html.replace('>中文</button>', '></button>'))).toBe(false);
    expect(CJK.test(JSON.stringify(en))).toBe(false);
  });
});
