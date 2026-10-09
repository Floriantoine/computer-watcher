import { describe, expect, test } from 'vitest';
import { DEFAULT_ALERTS, type AlertEvent, type AlertsConfig } from '../../core/alerts';
import { badgeCount, clickTarget, MAX_VISIBLE, notificationTarget, pendingPopups, popupAction, popupSnooze, popupStack, sameUnseen, seenAfterClose } from './alertPopups';

const ev = (id: number, ts: number, type: AlertEvent['type'] = 'leak', groupKey: string | null = null): AlertEvent =>
  ({ id, ts, type, groupKey, groupLabel: null, detail: {} });
const cfg = (o: Partial<AlertsConfig> = {}): AlertsConfig => ({ ...DEFAULT_ALERTS, seenUpTo: 1000, ...o });

describe('pendingPopups', () => {
  test('après seenUpTo seulement, canal ≠ none, non fermées, plus récentes d’abord', () => {
    const events = [ev(1, 900), ev(2, 1000), ev(3, 1100), ev(4, 1200, 'pressure'), ev(5, 1300, 'tmpfs'), ev(6, 1400)];
    const c = cfg({ channels: { ...DEFAULT_ALERTS.channels, tmpfs: 'none' } });
    expect(pendingPopups(events, c, new Set([6])).map((e) => e.id)).toEqual([4, 3]);
  });

  test('pression (pop-up seulement) : affichée dans l’app', () => {
    expect(pendingPopups([ev(1, 2000, 'pressure')], cfg(), new Set())).toHaveLength(1);
  });

  test('aucune alerte avant le chargement (events undefined)', () => {
    expect(pendingPopups(undefined, cfg(), new Set())).toEqual([]);
  });
});

describe('popupStack', () => {
  test(`au plus ${MAX_VISIBLE} cartes, le reste regroupé en « + n autres »`, () => {
    const p = [5, 4, 3, 2, 1].map((i) => ev(i, 1000 + i));
    const s = popupStack(p);
    expect(s.visible.map((e) => e.id)).toEqual([5, 4, 3]);
    expect(s.more).toBe(2);
    expect(popupStack(p.slice(0, 3)).more).toBe(0);
    expect(popupStack([])).toEqual({ visible: [], more: 0 });
  });
});

describe('fermeture = vue', () => {
  const events = [ev(1, 1100), ev(2, 1200), ev(3, 1300)];
  test('fermer la plus ancienne : seenUpTo avance jusqu’à elle', () => {
    expect(seenAfterClose(events, cfg(), new Set([1]))).toBe(1100);
  });
  test('fermer la plus récente seule : seenUpTo ne bouge pas (les plus anciennes restent à voir)', () => {
    expect(seenAfterClose(events, cfg(), new Set([3]))).toBe(1000);
  });
  test('fermer la plus ancienne après la plus récente : avance par-dessus les fermées', () => {
    expect(seenAfterClose(events, cfg(), new Set([3, 1]))).toBe(1100);
    expect(seenAfterClose(events, cfg(), new Set([3, 1, 2]))).toBe(1300);
  });
  test('types sans pop-up (canal none) : ne bloquent pas l’avance', () => {
    const c = cfg({ channels: { ...DEFAULT_ALERTS.channels, leak: 'none' } });
    expect(seenAfterClose([ev(1, 1100), ev(2, 1200, 'tmpfs')], c, new Set([2]))).toBe(1200);
  });
  test('deux alertes au même instant : il faut fermer les deux', () => {
    const same = [ev(1, 1100), ev(2, 1100)];
    expect(seenAfterClose(same, cfg(), new Set([1]))).toBe(1000);
    expect(seenAfterClose(same, cfg(), new Set([1, 2]))).toBe(1100);
  });
  test('ids déjà fermés (config seenIds) : comptés comme fermés', () => {
    expect(seenAfterClose(events, cfg({ seenIds: [2] }), new Set([1]))).toBe(1200);
  });
});

describe('badge', () => {
  test('total SQL (sans plafond) moins les fermetures pas encore enregistrées', () => {
    const loaded = [1, 2, 3].map((i) => ev(i, 1000 + i));
    expect(badgeCount(250, loaded, new Set())).toBe(250);
    expect(badgeCount(250, loaded, new Set([2, 99]))).toBe(249);
    expect(badgeCount(1, loaded, new Set([1, 2]))).toBe(0);
  });
  test('pendingPopups exclut les ids déjà fermés (seenIds)', () => {
    expect(pendingPopups([ev(1, 2000), ev(2, 2100)], cfg({ seenIds: [2] }), new Set()).map((e) => e.id)).toEqual([1]);
  });
});

describe('sameUnseen (pas de nouveau tableau si rien n’a changé)', () => {
  test('même total et mêmes ids dans le même ordre → identique', () => {
    const a = { total: 2, alerts: [ev(2, 1200), ev(1, 1100)] };
    expect(sameUnseen(a, { total: 2, alerts: [ev(2, 1200), ev(1, 1100)] })).toBe(true);
    expect(sameUnseen(a, { total: 3, alerts: [ev(2, 1200), ev(1, 1100)] })).toBe(false);
    expect(sameUnseen(a, { total: 2, alerts: [ev(3, 1300), ev(2, 1200)] })).toBe(false);
    expect(sameUnseen(undefined, a)).toBe(false);
  });
});

describe('popupAction', () => {
  test('tmpfs → « Voir /tmp » ; fuite d’un groupe présent → « Voir le groupe » ; sinon « Voir l’instant »', () => {
    const present = (k: string) => k === 'project:/home/u/acme';
    expect(popupAction(ev(1, 1, 'tmpfs'), present)).toEqual({ kind: 'tmp', label: 'Voir /tmp' });
    expect(popupAction(ev(1, 1, 'leak', 'project:/home/u/acme'), present)).toEqual({ kind: 'group', label: 'Voir le groupe', groupKey: 'project:/home/u/acme' });
    expect(popupAction(ev(1, 5, 'leak', 'project:/home/u/gone'), present)).toEqual({ kind: 'instant', label: 'Voir l’instant', ts: 5 });
    expect(popupAction(ev(1, 7, 'earlyoom_kill'), present)).toEqual({ kind: 'instant', label: 'Voir l’instant', ts: 7 });
  });
});

describe('clickTarget (action choisie au clic)', () => {
  test('groupe présent → détail ; groupe disparu depuis l’affichage → Métriques à l’instant ; tmpfs → page /tmp', () => {
    const e = ev(1, 4242, 'leak', 'project:/home/u/acme');
    expect(clickTarget(e, () => true)).toEqual({ view: 'detail', groupId: 'project:/home/u/acme' });
    expect(clickTarget(e, () => false)).toEqual({ view: 'metrics', at: 4242 });
    expect(clickTarget(ev(2, 7, 'tmpfs'), () => true)).toEqual({ view: 'tmp' });
    expect(clickTarget(ev(3, 9, 'earlyoom_kill'), () => true)).toEqual({ view: 'metrics', at: 9 });
  });
});

describe('notificationTarget (notification du bureau « Ouvrir »)', () => {
  test('tmpfs → page /tmp ; prévision → « Libérer… » ; autre alerte → Métriques à l’instant', () => {
    expect(notificationTarget(ev(1, 4242, 'tmpfs'))).toEqual({ view: 'tmp' });
    expect(notificationTarget(ev(2, 7, 'forecast'))).toBe('free');
    expect(notificationTarget(ev(3, 9, 'leak', 'project:/home/u/acme'))).toEqual({ view: 'metrics', at: 9 });
    expect(notificationTarget(ev(4, 11, 'earlyoom_kill'))).toEqual({ view: 'metrics', at: 11 });
  });
});

describe('prévision ② : « Libérer… »', () => {
  test('action « Libérer… » qui ouvre le kill groupé', () => {
    expect(popupAction(ev(1, 1, 'forecast'), () => true)).toEqual({ kind: 'free', label: 'Libérer…' });
    expect(clickTarget(ev(1, 1, 'forecast'), () => true)).toBe('free');
  });
});

test('popupSnooze : « Ignorer 30 min » seulement pour la prévision', () => {
  expect(popupSnooze(ev(1, 1, 'forecast'))).toBe('Ignorer 30 min');
  expect(popupSnooze(ev(1, 1, 'leak'))).toBeNull();
});
