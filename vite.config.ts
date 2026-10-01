import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Demo app lives in demo/; the library itself is src/ (imported via the "roadsystem" alias).
export default defineConfig({
  root: 'demo',
  resolve: {
    alias: { roadsystem: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
  },
  build: { outDir: '../dist-demo', emptyOutDir: true },
});
