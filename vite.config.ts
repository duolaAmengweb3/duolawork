import { defineConfig } from 'vite';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(),tailwindcss()],
  resolve: { alias: {"@": path.resolve("ui/v1")} },
  root: 'ui',
  base: '/',
  build: { outDir: '../dist', emptyOutDir: true },
});
