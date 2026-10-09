// electron.vite.config.ts
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // diskScanWorker : processus enfant du parcours du dossier personnel (page Disque)
        input: { index: resolve('src/main/index.ts'), recorder: resolve('src/recorder/index.ts'), diskScanWorker: resolve('src/main/diskScanWorker.ts') },
        // module intégré d'Electron (fs sans la réécriture des archives .asar), fourni à l'exécution
        external: ['original-fs'],
      },
    },
  },
  preload: {},
  renderer: { plugins: [react()] },
});
