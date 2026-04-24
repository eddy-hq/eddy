import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { API_PREFIXES } from './src/api-prefixes';

const API_PROXY = 'http://localhost:3737';

export default defineConfig({
  plugins: [react()],
  root: 'src/pwa',
  resolve: {
    alias: {},
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/pwa'),
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    proxy: Object.fromEntries(API_PREFIXES.map((p) => [p, API_PROXY])),
  },
});
