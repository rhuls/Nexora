import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the Vite server proxies /api to the backend; in Docker nginx does the same.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: { '/api': { target: process.env.NEXORA_API_URL ?? 'http://127.0.0.1:4000', changeOrigin: true } },
  },
});
