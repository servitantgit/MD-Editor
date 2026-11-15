import { defineConfig } from 'vite';

// Vite, phase 1: build only, zero behaviour change.
// js/vendor.js puts the npm libraries on window under the globals js/ already uses;
// no file in js/ is rewritten to imports. Minimal config: output to dist, relative base,
// no plugins, no code-splitting tweaks.
export default defineConfig({
  base: './',
  server: { port: 8080, strictPort: true },
  build: {
    outDir: 'dist',
  },
});
