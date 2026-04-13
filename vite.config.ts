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
    port: 5173,
    proxy: {
      '/requests': 'http://localhost:3737',
    },
  },
});
