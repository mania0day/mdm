import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard talks to the SENTROID API. In dev, Vite proxies /api to the
// backend so the browser sees a single origin. In production the built SPA is
// served by the backend itself (see server/src/index.js).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
});
