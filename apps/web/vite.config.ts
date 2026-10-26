import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * The console is served by the iCamify server in production, from the same
 * origin as the API. During `npm run web:dev` Vite proxies API and WebSocket
 * traffic to the running backend, so cookies and MSE sockets keep working
 * without CORS.
 */
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8060', changeOrigin: false, ws: true },
      '/ws': { target: 'ws://127.0.0.1:8060', ws: true },
      '/health': { target: 'http://127.0.0.1:8060' },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
