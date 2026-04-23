import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Operator back-office portal. Runs on port 3101 locally, proxies
// REST calls under /v1 to the rgs-server on port 4500.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3101,
    strictPort: true,
    proxy: {
      '/v1': {
        target: 'http://localhost:4500',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
