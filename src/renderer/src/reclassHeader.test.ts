import { expect, test } from 'vitest';
import type { GroupKind, GroupSummary, InstanceSummary } from '../../core/types';
import { headerReclassTarget } from './reclassHeader';

const inst = (groupId: string, extra: Partial<InstanceSummary> = {}): InstanceSummary => ({
  key: `${groupId}#10:100`, groupId, project: null, category: 'unknown', source: 'name', signature: 'x', label: 'x', rootPid: 10, rootStartTicks: 100,
  pids: [10], ports: [], ageSec: 100, rssKB: 1000, swapKB: 0, cpuPercent: 0, duplicate: false, protected: false, ...extra,
});
const grp = (id: string, kind: GroupKind, instances: InstanceSummary[]): GroupSummary => ({
  id, kind, label: id, tags: [], rootName: 'x', pids: [10], procCount: 1, cpuPercent: 0, rssKB: 0, swapKB: 0, oldestAgeSec: 0,
  protected: false, killable: true, subgroups: [], categories: instances.map((i) => i.category), instances,
});

test('groupes app / commande / Claude : leur instance unique', () => {
  const chrome = inst('app:chrome', { category: 'browser' });
  expect(headerReclassTarget(grp('app:chrome', 'app', [chrome]))).toBe(chrome);
  const gs = inst('command:gitstatusd');
  expect(headerReclassTarget(grp('command:gitstatusd', 'command', [gs]))).toBe(gs);
  const claude = inst('claude', { category: 'ai' });
  expect(headerReclassTarget(grp('claude', 'claude', [claude]))).toBe(claude);
});

test('projet, dossier supprimé, « Autres » : pas de menu dans l\'en-tête', () => {
  expect(headerReclassTarget(grp('project:/x', 'project', [inst('project:/x', { project: '/x' })]))).toBeNull();
  expect(headerReclassTarget(grp('deleted', 'deleted', [inst('deleted')]))).toBeNull();
  expect(headerReclassTarget(grp('others', 'others', []))).toBeNull();
});

test('groupe app sans instance (sous-groupe de « Autres » pas encore classé) : null', () => {
  expect(headerReclassTarget(grp('app:x', 'app', []))).toBeNull();
});
