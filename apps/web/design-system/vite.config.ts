import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  base: './',
  server: { host: '127.0.0.1', port: 8797, strictPort: true, fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] } },
  preview: { host: '127.0.0.1', port: 8798, strictPort: true },
  build: { outDir: '../../../data/design-system-dist', emptyOutDir: true, target: 'es2022' },
});
