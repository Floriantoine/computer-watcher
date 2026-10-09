import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HardDrive, RefreshCw, Trash2 } from 'lucide-react';
import { FAMILIES, familyDef, type FamiliesFile, type FamilyId } from '../../../core/disk/families';
import type { SunNode } from '../../../core/disk/sunTree';
import { badgeText, breadcrumb, familyOfPath, freedToast, highlighted, measuredAt, selectedTotal, type FamilyPaths } from '../disk';
import { formatKB } from '../format';
import { createSingleFlight } from '../tmpClean';
import { ipcErrorMessage } from '../viewModel';
import { SunburstChart } from './SunburstChart';

interface Props {
  onToast?: (message: string, kind: 'info' | 'error') => void;
}

interface Band { mount: string; sizeKB: number; availKB: number; reclaimKB: number }
interface FamiliesView { file: FamiliesFile | null; refusals: Partial<Record<FamilyId, string>>; lastRefusals: Partial<Record<FamilyId, string>>; paths: FamilyPaths; home: string; measuring: boolean }
type Scan = { state: 'running'; kb: number } | { state: 'done'; tree: SunNode; truncated: boolean; at: number } | { state: 'error'; message: string };

const hm = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Bande d'une partition : utilisé / libre, place récupérable des familles qui s'y trouvent. */
function PartitionBand({ b }: { b: Band }) {
  const used = Math.max(0, b.sizeKB - b.availKB);
  return (
    <section className="chart-panel disk-band" data-testid="disk-band">
      <div className="disk-band-head">
        <b>
          {b.mount} · {formatKB(b.availKB)} libres sur {formatKB(b.sizeKB)}
        </b>
        <span className="sub">{b.reclaimKB > 0 ? `≈ ${formatKB(b.reclaimKB)} récupérables` : 'rien de récupérable mesuré'}</span>
      </div>
      <div className="disk-bar" role="img" aria-label={`${formatKB(used)} utilisés, ${formatKB(b.availKB)} libres`}>
        <div className="used" style={{ flex: used }}>{used / Math.max(1, b.sizeKB) > 0.12 && `utilisé ${formatKB(used)}`}</div>
        <div className="free" style={{ flex: b.availKB }}>{b.availKB / Math.max(1, b.sizeKB) > 0.12 && `libre ${formatKB(b.availKB)}`}</div>
      </div>
    </section>
  );
}

/**
 * Page Disque (lot 1) : bandes des partitions, soleil du dossier personnel (parcours à l'ouverture, en arrière-plan),
 * familles récupérables à cocher. La suppression passe par les familles seulement : le main recalcule les chemins, fait
 * confirmer et revérifie tout.
 */
export function DiskPage({ onToast }: Props) {
  const [bands, setBands] = useState<Band[] | null>(null);
  const [view, setView] = useState<FamiliesView | null>(null);
  const [famError, setFamError] = useState<string | null>(null);
  const [scan, setScan] = useState<Scan>({ state: 'running', kb: 0 });
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<FamilyId>>(new Set());
  const [busy, setBusy] = useState(false);
  const flight = useRef(createSingleFlight()).current;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // page quittée : le parcours en cours est annulé 30 s plus tard, sauf retour d'ici là
      void window.procWatch.disk.leaveScan().catch(() => {});
    };
  }, []);

  const loadBands = useCallback(() => {
    window.procWatch.disk.partitions().then((b) => alive.current && setBands(b), () => alive.current && setBands([]));
  }, []);
  const loadFamilies = useCallback((force = false) => {
    setFamError(null);
    window.procWatch.disk.families(force).then(
      (v) => {
        if (!alive.current) return;
        setView(v);
        const ok = new Set((v.file?.families ?? []).filter((m) => !v.refusals[m.id]).map((m) => m.id));
        setSelected((s) => new Set([...s].filter((id) => ok.has(id))));
        loadBands();
      },
      (e: unknown) => alive.current && setFamError(ipcErrorMessage(e)),
    );
  }, [loadBands]);
  const loadScan = useCallback((force = false) => {
    setScan({ state: 'running', kb: 0 });
    window.procWatch.disk.scan(force).then(
      (r) => {
        if (!alive.current) return;
        setScan({ state: 'done', tree: r.tree, truncated: r.truncated, at: r.at });
        setCurrent((c) => c ?? r.tree.path);
      },
      (e: unknown) => alive.current && setScan({ state: 'error', message: ipcErrorMessage(e) }),
    );
  }, []);
  useEffect(() => {
    const off = window.procWatch.disk.onScanProgress((kb) => setScan((s) => (s.state === 'running' ? { state: 'running', kb } : s)));
    loadBands();
    loadFamilies();
    loadScan();
    return off;
  }, [loadBands, loadFamilies, loadScan]);

  const measures = useMemo(
    () => [...(view?.file?.families ?? [])].sort((a, b) => (b.reclaimKB ?? -1) - (a.reclaimKB ?? -1) || FAMILIES.findIndex((f) => f.id === a.id) - FAMILIES.findIndex((f) => f.id === b.id)),
    [view],
  );
  const paths = view?.paths ?? {};
  const toggle = useCallback(
    (id: FamilyId) => {
      if (view?.refusals[id]) return;
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
    },
    [view],
  );
  const total = selectedTotal(measures, selected);

  const free = async () => {
    await flight(async () => {
      setBusy(true);
      try {
        const r = await window.procWatch.disk.clean([...selected]);
        const t = freedToast(r);
        if (t) onToast?.(t.text, t.kind);
        if (r.done.length) {
          setSelected(new Set());
          loadScan(true);
        }
        // après un ménage : attendre la nouvelle mesure (celle lancée par le main est partagée)
        loadFamilies(r.done.length > 0);
      } catch (e) {
        onToast?.(ipcErrorMessage(e), 'error');
      } finally {
        if (alive.current) setBusy(false);
      }
    });
  };

  const tree = scan.state === 'done' ? scan.tree : null;
  const crumbs = tree && current ? breadcrumb(tree.path, current) : [];

  return (
    <div className="disk-page" data-testid="disk-page">
      <div className="page-head">
        <h2>
          <HardDrive size={18} strokeWidth={2} />
          <span className="label">Disque</span>
        </h2>
        <span className="sub">Ce qui remplit le disque, et ce qui peut partir sans risque</span>
        <span className="spacer" />
        <button
          data-testid="disk-refresh"
          disabled={busy || scan.state === 'running'}
          title="Reparcourir le dossier personnel et remesurer les familles"
          onClick={() => {
            loadScan(true);
            loadFamilies(true);
          }}
        >
          <RefreshCw size={13} strokeWidth={2} /> Actualiser
        </button>
      </div>

      <div className="disk-bands">{bands === null ? <div className="chart-empty small">Lecture des partitions…</div> : bands.map((b) => <PartitionBand key={b.mount} b={b} />)}</div>

      <div className="disk-main">
        <section className="chart-panel disk-sun-panel">
          <div className="chart-panel-head">
            <nav className="crumb" aria-label="Dossier affiché">
              {crumbs.map((c, i) => (
                <span key={c.path}>
                  {i > 0 && <span className="sep"> › </span>}
                  <button className="crumb-link" disabled={c.path === current} onClick={() => setCurrent(c.path)}>{c.label}</button>
                </span>
              ))}
            </nav>
            <span className="spacer" />
            <span className="sub" data-testid="disk-scan-status">
              {scan.state === 'running'
                ? `Parcours… ${formatKB(scan.kb)} lus`
                : scan.state === 'error'
                  ? `Parcours impossible : ${scan.message}`
                  : `Parcouru à ${hm(scan.at)}${scan.truncated ? ' (incomplet : trop de fichiers)' : ''}`}
            </span>
          </div>
          {tree && current ? (
            <SunburstChart
              tree={tree}
              current={current}
              onEnter={setCurrent}
              onUp={() => setCurrent((c) => (c && c !== tree.path ? c.slice(0, c.lastIndexOf('/')) || tree.path : c))}
              familyOf={(p) => familyOfPath(p, paths)}
              isHighlighted={highlighted(selected, paths)}
              onToggleFamily={toggle}
              onOpen={(p) =>
                void window.procWatch.disk.open(p).then(
                  (r) => !r.ok && onToast?.(`Ouverture impossible : ${r.error}`, 'error'),
                  (e: unknown) => onToast?.(ipcErrorMessage(e), 'error'),
                )
              }
            />
          ) : (
            <div className="chart-empty tall">{scan.state === 'error' ? 'Soleil indisponible' : 'Parcours du dossier personnel…'}</div>
          )}
        </section>

        <section className="chart-panel disk-families" data-testid="disk-families">
          <div className="chart-panel-head">
            <h3>Familles récupérables</h3>
            {view?.measuring && <span className="sub">mesure en cours…</span>}
          </div>
          {famError ? (
            <div className="chart-empty small" role="alert">{famError}</div>
          ) : !view ? (
            <div className="chart-empty small">Mesure des familles…</div>
          ) : !measures.length ? (
            <div className="chart-empty small">Aucune famille récupérable trouvée</div>
          ) : (
            <ul className="disk-family-list">
              {measures.map((m) => {
                const def = familyDef(m.id);
                const why = view.refusals[m.id];
                const last = view.lastRefusals[m.id];
                const on = selected.has(m.id);
                return (
                  <li key={m.id} className={`disk-family${on ? ' on' : ''}${why ? ' refused' : ''}`} data-testid="disk-family-row" data-id={m.id}>
                    <input
                      type="checkbox"
                      id={`fam-${m.id}`}
                      data-testid="disk-family-check"
                      checked={on}
                      disabled={!!why || busy}
                      onChange={() => toggle(m.id)}
                    />
                    <label htmlFor={`fam-${m.id}`} className="name">
                      {def.label}
                      <span className={`disk-badge ${def.badge}`}>{badgeText(def.badge)}</span>
                    </label>
                    <span className="size mono" title="Taille mesurée">{m.sizeKB === null ? 'taille inconnue' : formatKB(m.sizeKB)}</span>
                    <span className="reclaim mono">{m.reclaimKB === null ? '' : `libère ≈ ${formatKB(m.reclaimKB)}`}</span>
                    <span className="when">{measuredAt(m.at)}</span>
                    {(why || last || m.error) && <span className="why" data-testid="disk-family-why">{why ?? (last ? `dernier essai : ${last}` : m.error)}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="disk-foot">
            <span className="sub">
              {selected.size} coché{selected.size > 1 ? 's' : ''}
              {selected.size > 0 && ` · ≈ ${formatKB(total)}`}
            </span>
            <button className="danger" data-testid="disk-free-button" disabled={!selected.size || busy} onClick={() => void free()}>
              <Trash2 size={13} strokeWidth={2} /> {selected.size ? `Libérer ≈ ${formatKB(total)}…` : 'Libérer…'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
