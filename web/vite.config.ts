import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8765',
      '/library.json': 'http://127.0.0.1:8765',
      '/prepare.json': 'http://127.0.0.1:8765',
      '/sets.json': 'http://127.0.0.1:8765',
      '/runtime.json': 'http://127.0.0.1:8765',
      '/audio': 'http://127.0.0.1:8765',
      '/stems': 'http://127.0.0.1:8765'
    }
  }
});
