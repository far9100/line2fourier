import { defineConfig, type Plugin } from 'vitest/config';

// Spec §6: nothing but the site's own files. The policy goes into the built page only; the dev server
// needs its websocket and injected client.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'line2fourier-csp',
    apply: 'build',
    transformIndexHtml: html =>
      html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">`),
  };
}

export default defineConfig({
  // Relative asset paths, so the build works from any folder (GitHub Pages serves it under /<repo>/).
  base: './',
  plugins: [contentSecurityPolicy()],
  build: {
    target: 'es2022',
    // pdf-lib (~420 kB) and mediabunny (~690 kB) are their own chunks, loaded only when exporting.
    chunkSizeWarningLimit: 800,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
