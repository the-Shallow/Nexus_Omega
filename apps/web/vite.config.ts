import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev server proxies the FastAPI twin (./scripts/twin.sh) so the app runs with live data.
const TWIN = process.env.TWIN_URL ?? 'http://127.0.0.1:8765';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': TWIN,
      '/metrics': TWIN,
      '/ws': { target: TWIN.replace(/^http/, 'ws'), ws: true },
    },
  },
  // Four pages: the product story at /, the live platform, the story simulation, and the results.
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
    rollupOptions: { input: { index: 'index.html', platform: 'platform.html', story: 'story.html', results: 'results.html' } },
  },
});
