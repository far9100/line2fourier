// UI text in Traditional Chinese and English (zh-TW.json, en.json), after line2func's viewer/i18n.js.
//
// Static text: elements carry data-i18n (text), data-i18n-title (tooltip) or data-i18n-aria-label;
// applyI18n() fills them in. Dynamic text: t(key, vars). A translation may be {one, other} for
// plurals, chosen by vars.n. Numbers passed as vars are formatted for the language; numbers in
// formulas are never localized (they are built elsewhere).
import en from './en.json';
import zhTW from './zh-TW.json';

export type Lang = 'zh-TW' | 'en';
export const LANGS: readonly Lang[] = ['zh-TW', 'en'];

type Entry = string | { one?: string; other: string };
const STRINGS: Record<Lang, Record<string, Entry>> = { 'zh-TW': zhTW, en };

let lang: Lang = 'zh-TW';
const listeners = new Set<(lang: Lang) => void>();
const pluralRules = new Map<Lang, Intl.PluralRules>();

/** The language to start with: the saved choice, else Traditional Chinese (spec §6). */
export function detectLang(saved: string | null | undefined): Lang {
  return LANGS.includes(saved as Lang) ? (saved as Lang) : 'zh-TW';
}

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  lang = LANGS.includes(next) ? next : 'zh-TW';
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
    applyI18n(document);
  }
  for (const listener of listeners) listener(lang);
}

export function onLangChange(listener: (lang: Lang) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function format(value: string | number): string {
  return typeof value === 'number' ? value.toLocaleString(lang) : String(value);
}

/**
 * Translate `key`, filling {name} placeholders from `vars`. Unknown keys return `fallback` (or the
 * key itself), so a missing translation never breaks the page.
 */
export function t(key: string, vars: Record<string, string | number> = {}, fallback?: string): string {
  let text = STRINGS[lang][key] ?? STRINGS.en[key];
  if (text === undefined) return fallback ?? key;
  if (typeof text === 'object') {
    let rules = pluralRules.get(lang);
    if (!rules) pluralRules.set(lang, (rules = new Intl.PluralRules(lang)));
    const form = rules.select(Number(vars.n ?? 0)) as 'one' | 'other';
    text = text[form] ?? text.other;
  }
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? format(vars[name]) : match));
}

export function applyI18n(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n!);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle!);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel!));
}

/** For tests: every key and its text in one language. */
export function strings(l: Lang): Readonly<Record<string, Entry>> {
  return STRINGS[l];
}
