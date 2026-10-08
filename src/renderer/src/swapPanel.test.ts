import { describe, expect, test } from 'vitest';
import type { SwapRow, SwapView } from '../../core/swap';
import type { GroupSummary, InstanceSummary } from '../../core/types';
import {
  CLAUDE_NOT_PROPOSED, freshSleepingKeys, parseSwapSleepMB, rowAction, sessionServiceIn, sleepLabel, sleepingInstances, stillAsleep, STOP_SLEEPING_HINT, stopOneCheck, stopSleepingLabel,
  swapRuleText, thresholdCommit,
} from './swapPanel';

const H = 3600_000;
const D = 24 * H;
const NOW = 100 * D;

const row = (over: Partial<SwapRow> = {}): SwapRow => ({
  key: 'app:spotify', groupId: 'app:spotify', label: 'Spotify', kind: 'app', category: null, project: null, swapKB: 400 * 1024, rssKB: 0,
  instanceKey: null, state: { kind: 'sleeping', sinceTs: NOW - 3 * D }, bulkEligible: false, protected: false, killable: true, children: [], ...over,
});

const inst = (key: string, groupId: string, over: Partial<InstanceSummary> = {}): InstanceSummary => ({
  key, groupId, project: 'acme', category: 'back', source: 'command', signature: 'nest', label: 'nest', rootPid: 1, rootStartTicks: 1, pids: [1], ports: [],
  ageSec: 0, rssKB: 0, swapKB: 0, cpuPercent: 0, duplicate: false, protected: false, ...over,
});

const grp = (id: string, kind: GroupSummary['kind'], instances: InstanceSummary[] = [], over: Partial<GroupSummary> = {}): GroupSummary => ({
  id, kind, label: id, tags: [], rootName: id, pids: [], procCount: 1, cpuPercent: 0, rssKB: 0, swapKB: 0, oldestAgeSec: 0, protected: false, killable: true,
  subgroups: [], categories: [], instances, ...over,
});

const view = (sleepingKeys: string[], rows: SwapRow[] = []): SwapView => ({ swapUsedKB: 0, swapTotalKB: 0, shmemKB: null, coveredFrom: NOW - 7 * D, activeCpu: 1, rows, sleepingKeys });

describe('sleepLabel', () => {
  test('actif, endormi depuis 3 j, depuis plus de 7 j (fenêtre lue), inconnu avec sa raison', () => {
    expect(sleepLabel({ kind: 'active' }, NOW, null)).toBe('actif');
    expect(sleepLabel({ kind: 'sleeping', sinceTs: NOW - 3 * D }, NOW, NOW - 7 * D)).toBe('endormi depuis 3 j');
    expect(sleepLabel({ kind: 'sleeping', sinceTs: NOW - 30 * H }, NOW, NOW - 7 * D)).toBe('endormi depuis 1 j');
    expect(sleepLabel({ kind: 'sleeping', sinceTs: null }, NOW, NOW - 7 * D)).toBe('endormi depuis plus de 7 j');
    expect(sleepLabel({ kind: 'sleeping', sinceTs: null }, NOW, NOW - 2 * D)).toBe('endormi depuis plus de 2 j');
    expect(sleepLabel({ kind: 'sleeping', sinceTs: null }, NOW, null)).toBe('endormi');
    expect(sleepLabel({ kind: 'unknown', reason: 'none' }, NOW, null)).toBe("inconnu (pas d'historique)");
    expect(sleepLabel({ kind: 'unknown', reason: 'stopped' }, NOW, null)).toBe("inconnu (service d'enregistrement arrêté)");
    expect(sleepLabel({ kind: 'unknown', reason: 'gap' }, NOW, null)).toBe("inconnu (trou dans l'historique)");
    expect(sleepLabel({ kind: 'unknown', reason: 'short' }, NOW, null)).toBe('inconnu (historique insuffisant)');
  });
});

test('swapRuleText : seuil de swap et seuil CPU appliqué', () => {
  expect(swapRuleText(100, 1)).toBe('Endormi : plus de 100 Mo de swap cumulé et aucun CPU ≥ 1 % depuis 1 jour.');
  expect(swapRuleText(250, 1.5)).toBe('Endormi : plus de 250 Mo de swap cumulé et aucun CPU ≥ 1,5 % depuis 1 jour.');
});

test('infobulles : le kill groupé ne propose ni protégées ni lancées par une session Claude ouverte', () => {
  expect(STOP_SLEEPING_HINT).toContain('instances de projets');
  expect(STOP_SLEEPING_HINT).toContain('Claude');
  expect(CLAUDE_NOT_PROPOSED).toBe('Non proposée : sa session Claude est encore ouverte');
});

test('stopSleepingLabel', () => {
  expect(stopSleepingLabel(0)).toBe('Arrêter les endormis (0)');
  expect(stopSleepingLabel(1)).toBe('Arrêter les endormis (1)');
  expect(stopSleepingLabel(3)).toBe('Arrêter les endormis (3)');
});

describe('sleepingInstances', () => {
  test('instances des clés présentes au snapshot (sous-groupes compris), clé disparue ignorée', () => {
    const a = inst('project:/a#1:1', 'project:/a');
    const b = inst('deleted:/b#2:2', 'deleted:/b');
    const groups = [grp('project:/a', 'project', [a]), grp('others', 'others', [], { subgroups: [grp('deleted:/b', 'deleted', [b])] })];
    expect(sleepingInstances(view([a.key, 'project:/x#9:9', b.key]), groups)).toEqual([a, b]);
    expect(sleepingInstances(null, groups)).toEqual([]);
  });

  test('défense : jamais une instance protégée, lancée par Claude, ni hors projet / dossier supprimé', () => {
    const p = inst('project:/a#1:1', 'project:/a', { protected: true });
    const c = inst('project:/a#2:2', 'project:/a', { launchedBy: 'claude' });
    const app = inst('app:pg#3:3', 'app:pg');
    const groups = [grp('project:/a', 'project', [p, c]), grp('app:pg', 'app', [app])];
    expect(sleepingInstances(view([p.key, c.key, app.key]), groups)).toEqual([]);
  });
});

describe('rowAction', () => {
  test('appli endormie tuable → stop-one ; instance de projet endormie → none (arrêt groupé) ; inconnu / actif → none', () => {
    expect(rowAction(row())).toBe('stop-one');
    expect(rowAction(row({ kind: 'project', key: 'project:/a#1:1', killable: false, bulkEligible: true }))).toBe('none');
    expect(rowAction(row({ kind: 'project', key: 'project:/a', killable: false }))).toBe('none');
    expect(rowAction(row({ state: { kind: 'unknown', reason: 'gap' } }))).toBe('none');
    expect(rowAction(row({ state: { kind: 'active' } }))).toBe('none');
  });

  test('jamais un groupe « command » (démons de session, processus regroupés par nom), Claude, protégé ou non tuable', () => {
    expect(rowAction(row({ kind: 'command' }))).toBe('none');
    expect(rowAction(row({ kind: 'claude', killable: false }))).toBe('none');
    expect(rowAction(row({ kind: 'claude', killable: true }))).toBe('none');
    expect(rowAction(row({ protected: true }))).toBe('none');
    expect(rowAction(row({ killable: false }))).toBe('none');
  });
});

describe('stopOneCheck (garde du clic « Arrêter »)', () => {
  test('groupe présent, appli non protégée et tuable → ok', () => {
    expect(stopOneCheck(row(), grp('app:spotify', 'app'))).toEqual({ ok: true });
  });
  test('groupe disparu, devenu protégé, Claude, command ou non tuable → refus avec message', () => {
    expect(stopOneCheck(row(), undefined)).toEqual({ ok: false, message: '« Spotify » a disparu' });
    for (const g of [grp('app:spotify', 'app', [], { protected: true }), grp('app:spotify', 'app', [], { killable: false }), grp('app:spotify', 'claude'), grp('app:spotify', 'command')])
      expect(stopOneCheck(row(), g).ok).toBe(false);
    expect(stopOneCheck(row({ state: { kind: 'active' } }), grp('app:spotify', 'app')).ok).toBe(false);
  });
});

describe('re-vérification au clic (vue relue)', () => {
  test('stillAsleep : la ligne doit encore être endormie et arrêtable dans la vue fraîche', () => {
    expect(stillAsleep(view([], [row()]), row())).toBe(true);
    expect(stillAsleep(view([], [row({ state: { kind: 'active' } })]), row())).toBe(false);
    expect(stillAsleep(view([], [row({ state: { kind: 'unknown', reason: 'stopped' } })]), row())).toBe(false);
    expect(stillAsleep(view([], []), row())).toBe(false);
    expect(stillAsleep(null, row())).toBe(false);
  });
  test('freshSleepingKeys : seulement les clés encore proposées par la vue fraîche', () => {
    expect(freshSleepingKeys(view(['a', 'c']), ['a', 'b', 'c'])).toEqual(['a', 'c']);
    expect(freshSleepingKeys(null, ['a'])).toEqual([]);
  });
  test('sessionServiceIn : premier service de session parmi les processus du groupe', () => {
    expect(sessionServiceIn([{ name: 'spotify' }, { name: 'pipewire-pulse' }])).toBe('pipewire-pulse');
    expect(sessionServiceIn([{ name: 'spotify' }])).toBeNull();
  });
});

test('parseSwapSleepMB : entier de 1 à 65 536 (mêmes bornes que la config)', () => {
  expect(parseSwapSleepMB('100')).toBe(100);
  expect(parseSwapSleepMB(' 500 ')).toBe(500);
  expect(parseSwapSleepMB('65536')).toBe(65_536);
  for (const bad of ['', '0', '-5', '1.5', '65537', 'abc', '1e3x']) expect(parseSwapSleepMB(bad)).toBeNull();
});

describe('thresholdCommit (champ du seuil, Entrée ou sortie du champ)', () => {
  test('valeur valide et différente → enregistrée', () => {
    expect(thresholdCommit('250', 100, 'enter')).toEqual({ save: 250, text: '250', error: null });
    expect(thresholdCommit(' 250 ', 100, 'blur')).toEqual({ save: 250, text: '250', error: null });
  });
  test('inchangée → rien', () => {
    expect(thresholdCommit('100', 100, 'blur')).toEqual({ save: null, text: '100', error: null });
  });
  test('invalide : Entrée garde la saisie avec l\'erreur ; sortie du champ revient à la valeur enregistrée', () => {
    expect(thresholdCommit('0', 100, 'enter')).toEqual({ save: null, text: '0', error: 'Un entier de 1 à 65 536' });
    expect(thresholdCommit('abc', 100, 'blur')).toEqual({ save: null, text: '100', error: null });
  });
});
