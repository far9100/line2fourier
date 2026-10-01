// The formula panel's maths, typeset by KaTeX (spec §6, §7). KaTeX is loaded after the first frame;
// its stylesheet and fonts come with the page, never from a CDN.
type Katex = typeof import('katex').default;
let katex: Promise<Katex> | null = null;

export async function renderMath(el: HTMLElement, latex: string): Promise<void> {
  katex ??= import('katex').then(m => m.default);
  const k = await katex;
  k.render(latex, el, { throwOnError: false, displayMode: false, output: 'htmlAndMathml', strict: 'ignore' });
}
