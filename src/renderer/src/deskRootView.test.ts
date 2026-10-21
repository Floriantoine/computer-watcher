import { describe, expect, it } from 'vitest';
import { DESK_ROOT_DROPINS, deskRootContent, deskRootStatus, type DeskRootStatus } from '../../core/antigel/deskRoot';
import { deskRootSummary, deskRootToast } from './deskRootView';

const MiB = 1024 ** 2;
const st = (mb: number | null, lows: (number | null)[], target: number | null = 4771): DeskRootStatus =>
  deskRootStatus({ files: DESK_ROOT_DROPINS.map((d) => (mb === null ? null : deskRootContent(d.section, mb))), lows, targetMB: target, uid: 1000, recursiveprot: true });

describe('deskRootSummary', () => {
  it('absent : à activer', () => {
    const s = deskRootSummary(st(null, [0, 0, 0]));
    expect(s).toMatchObject({ tone: 'warn', action: 'install', canRemove: false });
    expect(s.text).toBe('Non activée : user.slice, user-1000.slice et user@1000.service n’ont aucune protection mémoire, celle du bureau reste donc sans effet. « Activer » y pose 4771 Mo (réserve du bureau).');
  });
  it('déjà assurée par le système sans nos fichiers : rien à faire', () => {
    expect(deskRootSummary(st(null, [MiB, MiB, MiB]))).toMatchObject({ tone: 'ok', action: null, canRemove: false });
  });
  it('active et vérifiée', () => {
    const s = deskRootSummary(st(4771, [4771 * MiB, 4771 * MiB, Infinity]));
    expect(s).toMatchObject({ tone: 'ok', action: null, canRemove: true });
    expect(s.text).toBe('Active : 4771 Mo protégés sur user.slice, user-1000.slice et user@1000.service (memory.low vérifié).');
  });
  it('fichiers en place sans effet', () => {
    expect(deskRootSummary(st(4771, [0, 0, 0])).text).toMatch(/memory\.low reste à 0 sur user\.slice, user-1000\.slice, user@1000\.service/);
  });
  it('obsolète : mise à jour', () => {
    const s = deskRootSummary(st(4096, [1, 1, 1]));
    expect(s).toMatchObject({ tone: 'warn', action: 'update', canRemove: true });
    expect(s.text).toMatch(/4096 Mo.*4771 Mo/);
  });
  it('réserve inconnue', () => {
    expect(deskRootSummary(st(null, [0, 0, 0], null))).toMatchObject({ action: null });
  });
  it('simulation signalée', () => {
    expect(deskRootSummary({ ...st(null, [0, 0, 0]), fake: true }).text).toMatch(/\(simulé\)$/);
  });
});

describe('deskRootToast', () => {
  it('succès en info, annulation en info, échec en erreur', () => {
    expect(deskRootToast({ ok: true, message: 'ok' })).toEqual({ message: 'ok', kind: 'info' });
    expect(deskRootToast({ ok: false, reason: 'cancelled', message: 'Annulé' })).toEqual({ message: 'Annulé', kind: 'info' });
    expect(deskRootToast({ ok: false, reason: 'failed', message: 'non' })).toEqual({ message: 'non', kind: 'error' });
  });
});
