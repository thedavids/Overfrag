import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: './',
  build: {
    rollupOptions: {
      input: 'client.html'
    },
    outDir: 'dist',
  },
  server: {
    open: '/client.html'
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared') // adjust path if needed
    }
  },
  optimizeDeps: {
    include: ['three'],
    entries: [
      './main.js',
      '../shared/octree.js' // 👈 explicitly tell Vite to scan this file too
    ]
  }
});
