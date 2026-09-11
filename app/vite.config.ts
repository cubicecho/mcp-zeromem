import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type PluginOption } from 'vite';

export default defineConfig({
  // The root workspace's vitest hoists vite 7, so the plugins' type declarations resolve against it
  // while the app itself runs vite 6. The hook shapes are runtime-compatible; only the types clash.
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true, routeFileIgnorePattern: '__tests__' }),
    react(),
    tailwindcss(),
  ] as PluginOption[],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://localhost:3001',
      '/mcp': 'http://localhost:3001',
    },
  },
});
