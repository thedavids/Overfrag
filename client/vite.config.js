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
      shared: path.resolve(__dirname, './shared')
    }
  }
});
