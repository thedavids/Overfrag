import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: './',
  build: {
    rollupOptions: {
      input: 'mapEditor.html'
    },
    outDir: 'dist',
  },
  server: {
    open: '/mapEditor.html'
  },
  resolve: {
    alias: {
      shared: path.resolve(__dirname, './shared')
    }
  }
});
