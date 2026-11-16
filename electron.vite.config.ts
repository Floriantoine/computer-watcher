// electron.vite.config.ts
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    // Empreinte du build, commune à l'app et au service (src/core/buildId.ts)
    define: { __CW_BUILD_ID__: JSON.stringify(`${Date.now().toString(36)}-${process.pid}`) },
    build: {
      rollupOptions: {
        // diskScanWorker : processus enfant du parcours du dossier personnel (page Disque)
        // cli : `computer-watcher run -- <commande>` (anti-gel, lot 4), Node pur
        input: { index: resolve('src/main/index.ts'), recorder: resolve('src/recorder/index.ts'), diskScanWorker: resolve('src/main/diskScanWorker.ts'), cli: resolve('src/cli/index.ts') },
        // module intégré d'Electron (fs sans la réécriture des archives .asar), fourni à l'exécution
        external: ['original-fs'],
      },
    },
  },
  preload: {},
  renderer: { plugins: [react()] },
});
