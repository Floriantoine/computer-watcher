import { expect, test } from 'vitest';
import { hasService } from './serviceRestart';

const g = (kind: 'app' | 'others' | 'project', pids: number[]) => ({ kind, pids });

test('hasService : carte ou ligne qui contient le processus du service, jamais « Autres »', () => {
  expect(hasService(g('app', [10, 42, 7]), 42)).toBe(true);
  expect(hasService(g('project', [10]), 42)).toBe(false);
  // « Autres » repliée regroupe les pids de ses sous-groupes : pas de bouton (son pied de carte est « Déplier »)
  expect(hasService(g('others', [42]), 42)).toBe(false);
  // service arrêté ou statut périmé : aucun bouton
  expect(hasService(g('app', [42]), null)).toBe(false);
});
