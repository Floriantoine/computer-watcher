import { useEffect, useState } from 'react';
import type { Snapshot } from '../../core/types';

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  useEffect(() => window.procWatch.onSnapshot(setSnapshot), []);
  if (!snapshot) return <p>Chargement…</p>;
  return <p data-testid="snapshot-ready">{snapshot.groups.length} groupes</p>;
}
