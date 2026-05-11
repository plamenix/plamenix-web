import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
    // pnpm + `link:` protocol leaves each repo with its own `react` /
    // `react-dom` resolution. Without dedupe, the bundle ends up with
    // two React copies and React 19 panics with
    // `S.H.useCallback is null` when the dispatcher is set on the
    // other copy.
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    target: 'es2024',
    outDir: 'dist',
  },
});
