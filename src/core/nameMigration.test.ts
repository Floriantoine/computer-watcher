import { describe, expect, test } from 'vitest';
import {
  decideDirMove, MIGRATION_STEPS, migrationLines, nextSteps, parseMigrationState, serializeMigrationState, type MigrationReport, type MigrationState,
} from './nameMigration';

describe('décision pour un dossier', () => {
  test.each([
    [{ legacy: 'absent', next: 'absent' }, 'skip-absent'],
    [{ legacy: 'absent', next: 'non-empty' }, 'skip-absent'],
    [{ legacy: 'dir', next: 'absent' }, 'move'],
    [{ legacy: 'dir', next: 'empty' }, 'replace-empty'],
    [{ legacy: 'dir', next: 'non-empty' }, 'keep-both'],
    [{ legacy: 'link', next: 'absent' }, 'refuse'],
    [{ legacy: 'mount', next: 'absent' }, 'refuse'],
    [{ legacy: 'dir', next: 'link' }, 'refuse'],
    [{ legacy: 'dir', next: 'other' }, 'refuse'],
    [{ legacy: 'other', next: 'absent' }, 'refuse'],
  ] as const)('decideDirMove %j → %s', (o, d) => expect(decideDirMove(o)).toBe(d));
});

describe('étapes à faire', () => {
  test('ancienne instance vivante → différé ; rien d’ancien → rien ; reprise après échec', () => {
    expect(nextSteps(null, { legacyPresent: true, legacyInstanceAlive: true })).toBe('deferred');
    expect(nextSteps(null, { legacyPresent: false, legacyInstanceAlive: false })).toBe('nothing');
    expect(nextSteps(null, { legacyPresent: true, legacyInstanceAlive: false })).toEqual([...MIGRATION_STEPS]);
    expect(nextSteps({ version: 1, done: ['stop-legacy-service'], errors: { 'move-dirs': 'EBUSY' }, leftInPlace: [] }, { legacyPresent: true, legacyInstanceAlive: false }))
      .toEqual(['move-dirs', 'new-service', 'desktop', 'appimage']);
  });
  test('tout fait → rien, même si un ancien reste (laissé en place) ou qu’une ancienne instance tourne', () => {
    const all: MigrationState = { version: 1, done: [...MIGRATION_STEPS], errors: {}, leftInPlace: ['/c/proc-watch'] };
    expect(nextSteps(all, { legacyPresent: true, legacyInstanceAlive: true })).toBe('nothing');
  });
  test('l’ordre est toujours celui de la spécification', () => {
    expect(MIGRATION_STEPS).toEqual(['stop-legacy-service', 'move-dirs', 'new-service', 'desktop', 'appimage']);
    expect(nextSteps({ version: 1, done: ['desktop', 'stop-legacy-service'], errors: {}, leftInPlace: [] }, { legacyPresent: true, legacyInstanceAlive: false }))
      .toEqual(['move-dirs', 'new-service', 'appimage']);
  });
});

describe('état (migration.json)', () => {
  test('JSON invalide ou version inconnue → null (repart de zéro, idempotent)', () => {
    expect(parseMigrationState(null)).toBeNull();
    expect(parseMigrationState('{')).toBeNull();
    expect(parseMigrationState('{"version":2}')).toBeNull();
    expect(parseMigrationState('{"version":1,"done":["x"],"errors":{},"leftInPlace":[]}')).toBeNull();
    expect(parseMigrationState('{"version":1,"done":"stop-legacy-service","errors":{},"leftInPlace":[]}')).toBeNull();
  });
  test('aller-retour', () => {
    const s: MigrationState = { version: 1, done: ['stop-legacy-service', 'move-dirs'], errors: { desktop: 'refus' }, leftInPlace: ['/c/proc-watch'], skipped: { 'new-service': 'x' } };
    expect(parseMigrationState(serializeMigrationState(s))).toEqual(s);
  });
});

describe('texte (Réglages › À propos, boîte au démarrage)', () => {
  const r = (o: Partial<MigrationReport>): MigrationReport => ({ status: 'done', done: [], errors: {}, leftInPlace: [], skipped: {}, ...o });
  test('rien à migrer : aucune ligne', () => {
    expect(migrationLines(r({ status: 'nothing' }))).toEqual([]);
  });
  test('faite', () => {
    expect(migrationLines(r({ status: 'done' }))).toEqual(['Migration depuis proc-watch : faite.']);
  });
  test('partielle : chaque erreur et chaque élément laissé en place', () => {
    const l = migrationLines(r({ status: 'partial', errors: { 'stop-legacy-service': 'systemctl --user show a échoué' }, leftInPlace: ['/c/proc-watch'] }));
    expect(l[0]).toBe('Migration depuis proc-watch : partielle.');
    expect(l).toContain('Arrêt de l’ancien service : systemctl --user show a échoué');
    expect(l).toContain('Laissé en place : /c/proc-watch');
  });
  test('différée : ancienne version encore ouverte', () => {
    expect(migrationLines(r({ status: 'deferred' }))[0]).toMatch(/^Migration depuis proc-watch : différée/);
  });
});
