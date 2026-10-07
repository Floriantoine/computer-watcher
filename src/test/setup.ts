// Ferme toute base SQLite ouverte par un test (ou par le code testé) : après le test pour celles ouvertes
// pendant un test, après le fichier pour celles ouvertes au chargement ou dans un beforeAll.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { afterAll, afterEach, beforeEach } from 'vitest';

type Db = { isOpen: boolean; close(): void };
const sqlite = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (...a: unknown[]) => Db; __tracked?: boolean };
const inTest = new Set<Db>();
const inFile = new Set<Db>();
let running = false;

if (!sqlite.__tracked) {
  const Base = sqlite.DatabaseSync;
  sqlite.DatabaseSync = class extends Base {
    constructor(...a: unknown[]) {
      super(...a);
      (running ? inTest : inFile).add(this);
    }
  };
  sqlite.__tracked = true;
  syncBuiltinESMExports();
}

const closeAll = (s: Set<Db>) => {
  for (const db of s) {
    try {
      if (db.isOpen) db.close();
    } catch {
      // déjà fermée
    }
  }
  s.clear();
};

beforeEach(() => {
  running = true;
});
afterEach(() => {
  running = false;
  closeAll(inTest);
});
afterAll(() => closeAll(inFile));
