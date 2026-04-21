import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

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
    proxy: {
      '/requests': 'http://localhost:3737',
      '/search':   'http://localhost:3737',
      '/people':   'http://localhost:3737',
      '/internal': 'http://localhost:3737',
      '/health':   'http://localhost:3737',
      '/topics':     'http://localhost:3737',
      '/discovery':  'http://localhost:3737',
    },
  },
});
