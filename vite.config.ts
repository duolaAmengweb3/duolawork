import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(rootDir, 'src/web'),
  publicDir: path.join(rootDir, 'src/web/public'),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.join(rootDir, 'dist/web'),
    emptyOutDir: true,
    assetsInlineLimit: 4096
  },
  server: {
    port: 5178,
    proxy: {
      '/api': 'http://127.0.0.1:8780'
    }
  }
});
