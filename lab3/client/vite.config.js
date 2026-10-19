import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// В режиме разработки (npm run dev) запросы /api проксируются на локальный сервер.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_URL || 'http://localhost:4000' },
  },
});
