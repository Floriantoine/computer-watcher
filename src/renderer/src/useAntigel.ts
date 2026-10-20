import { useEffect, useState } from 'react';
import type { AntigelView } from '../../core/antigel/state';

/** État du plafond de travail (anti-gel, écrit par le service), relu toutes les 5 s ; réutilisable (Réglages, Métriques). */
export function useAntigel(): AntigelView | null {
  const [v, setV] = useState<AntigelView | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => window.procWatch.antigel.state().then((x) => alive && setV(x), () => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return v;
}
