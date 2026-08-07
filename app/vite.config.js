import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // The wallets-kit dependency chain references Node's `global` at import
  // time. Without this polyfill the production build silently breaks every
  // wallet-connect click (this was a real bug found via a headless-browser
  // click-through in the original build, not caught by `vite build` alone).
  define: {
    global: 'globalThis',
  },
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      // Multi-page build: the worker console (index.html) and the
      // read-only buyer dashboard (dashboard.html) are separate front
      // doors for separate audiences, but ship from the same static site.
      input: {
        main: resolve(__dirname, 'index.html'),
        dashboard: resolve(__dirname, 'dashboard.html'),
      },
    },
  },
});
