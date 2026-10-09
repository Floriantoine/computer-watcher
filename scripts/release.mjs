// Prépare une version : `npm run release -- patch|minor|major [--dry-run]`. Ne pousse jamais (commande affichée à la fin).
// La logique (testée) est dans src/tooling/release.ts, exécuté directement par Node (types effacés, Node ≥ 22.18).
import { main } from '../src/tooling/release.ts';

process.exitCode = main(process.argv.slice(2));
