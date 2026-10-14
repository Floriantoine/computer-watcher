import { useEffect, useState } from 'react';
import { FolderSearch } from 'lucide-react';
import type { Config } from '../../../core/types';
import { diskSettingsToForm, validateDiskSettingsForm } from '../diskSettingsForm';
import { Card, NumberField, Row, SaveBar } from './settingsUi';

/** Réglages → Disque : dossiers de projets (vide = défaut) et seuil d'inactivité des node_modules. */
export function DiskSettingsCard({ config, onSave }: { config: Config; onSave: (c: Config) => void }) {
  const saved = diskSettingsToForm(config.ui);
  const [form, setForm] = useState(saved);
  const [def, setDef] = useState<{ home: string; roots: string[] } | null>(null);
  useEffect(() => setForm(diskSettingsToForm(config.ui)), [config.ui.diskProjectRoots, config.ui.diskInactiveDays]);
  useEffect(() => {
    window.procWatch.disk.projectRootsDefault().then(setDef, () => setDef(null));
  }, []);
  const v = validateDiskSettingsForm(form, def?.home ?? null);
  const dirty = form.rootsText !== saved.rootsText || form.days !== saved.days;
  const save = () => {
    if (v.ok) onSave({ ...config, ui: { ...config.ui, diskProjectRoots: v.roots, diskInactiveDays: v.days } });
  };
  return (
    <Card title="Page Disque" icon={<FolderSearch size={14} strokeWidth={2} />}>
      <Row
        label="Dossiers de projets"
        error={v.ok ? null : v.errors.roots ?? null}
        help={`Un chemin par ligne ; node_modules et worktrees n’y sont cherchés que là. Vide : ${def?.roots.length ? def.roots.join(', ') : 'aucun projet dans l’historique'} (parents des projets vus).`}
      >
        {(id) => (
          <textarea id={id} data-testid="disk-roots-text" rows={4} value={form.rootsText} placeholder={def?.roots.join('\n') ?? ''} onChange={(e) => setForm({ ...form, rootsText: e.target.value })} />
        )}
      </Row>
      <Row label="node_modules inactif après" error={v.ok ? null : v.errors.days ?? null} help="Ni processus vu dans le projet (historique), ni fichier source modifié pendant cette durée.">
        {(id) => <NumberField id={id} value={form.days} min="1" max={365} unit="jours" ariaLabel="Jours d’inactivité" invalid={!v.ok && !!v.errors.days} onChange={(d) => setForm({ ...form, days: d })} onEnter={save} testid="disk-days" />}
      </Row>
      <SaveBar dirty={dirty} disabled={!v.ok || !dirty} onSave={save} testid="disk-settings-save" />
    </Card>
  );
}
