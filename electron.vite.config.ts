// electron.vite.config.ts
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts'), recorder: resolve('src/recorder/index.ts') },
      },
    },
  },
  preload: {},
  renderer: { plugins: [react()] },
});
