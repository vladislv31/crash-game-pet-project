import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dev server proxies the API and the WebSocket to the game server, so no CORS setup is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
      // The test dashboard's load generator (ADR-0008).
      '/generator': {
        target: 'http://localhost:3100',
        rewrite: path => path.replace(/^\/generator/, ''),
      },
    },
  },
});
