import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev server for the player-facing iframe. The RGS backend runs on :4500
// in this monorepo (see root CLAUDE.md). We proxy /api and /socket.io to
// the backend so the iframe can be loaded from :3100 without CORS noise.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3100,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:4500',
      '/socket.io': {
        target: 'http://localhost:4500',
        ws: true,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
