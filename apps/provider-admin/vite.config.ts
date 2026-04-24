import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Yantra platform admin ("provider cockpit"). Cross-operator surface for
// Yantra-staff users only. Runs on port 3103 (3100=game-client,
// 3101=operator-portal, 3102=mock-operator, 3103=provider-admin).
// Proxies REST calls under /v1 to the rgs-server on port 4500.

// Dev middleware: serve the repo-wide docs/par-sheet.json at /docs/par-sheet.json
// so the PAR-sheet viewer can fetch and hash it without a build step.
// In production, deploys should mirror docs/par-sheet.json into public/.
function docsProxy(): Plugin {
  return {
    name: 'yantra-docs-proxy',
    configureServer(server) {
      const root = path.resolve(__dirname, '../../docs');
      server.middlewares.use('/docs', (req, res, next) => {
        const rel = (req.url ?? '').split('?')[0]!;
        if (!rel || rel === '/' || rel.includes('..')) return next();
        const file = path.join(root, rel);
        if (!file.startsWith(root) || !fs.existsSync(file)) return next();
        res.setHeader('content-type', 'application/json');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), docsProxy()],
  server: {
    port: 3103,
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
