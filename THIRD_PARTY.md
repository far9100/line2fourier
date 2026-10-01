# Third-party software

The built page includes the following, unchanged. Their licences are compatible with line2fourier's
GNU GPL v3 or later.

| Package | Version | Used for | Licence |
|---|---|---|---|
| [KaTeX](https://github.com/KaTeX/KaTeX) | 0.18.10 | Typesetting the series in the formula panel, with its stylesheet and fonts | MIT, © Khan Academy and other contributors; the fonts come from [katex-fonts](https://github.com/KaTeX/katex-fonts), MIT |
| [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | The flipbook PDF (loaded only when it is made) | MIT |
| ↳ @pdf-lib/standard-fonts, @pdf-lib/upng | 1.0.0, 1.0.1 | Helvetica metrics; PNG embedding | MIT |
| ↳ [pako](https://github.com/nodeca/pako) | 1.0.11 | Compression inside the PDF | MIT and Zlib |
| ↳ tslib | 1.14.1 | TypeScript helpers | 0BSD |
| [mediabunny](https://github.com/Vanilagy/mediabunny) | 1.61.0 | Writing the video file (loaded only when a video is made) | MPL-2.0; its source is at the link, unmodified |

Development tools (Vite, Vitest, TypeScript, Playwright, jsdom) are not part of the built page; see
`package.json`.
