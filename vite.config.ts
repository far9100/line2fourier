import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths, so the build works from any folder (GitHub Pages serves it under /<repo>/).
  base: './',
  build: { target: 'es2022' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
