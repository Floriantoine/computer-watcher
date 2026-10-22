import { defineConfig } from 'vitest/config';
import { createRunRoot } from './src/test/tmpRoot';

// Racine temporaire du lancement, sur disque (~/.cache/pw-vitest) : créée ici, au chargement de la config, avant que
// Vitest ne lise tmpdir() pour ses propres dossiers temporaires ; purge des orphelines et nettoyage : src/test/globalSetup.ts.
createRunRoot();

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['src/test/globalSetup.ts'],
    setupFiles: ['src/test/setup.ts'],
  },
});
