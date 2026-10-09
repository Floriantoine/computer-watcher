// Lecture de /proc/self/mountinfo (pur) : décodage des échappements octaux du noyau (« \040 » = espace).

/** Décode les échappements octaux d'un champ de mountinfo. */
export const unescapeMount = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

export interface MountEntry { majmin: string; root: string; mount: string; fstype: string; source: string }

/**
 * Lignes de mountinfo : `id parent maj:min racine point options [champs optionnels] - type source superoptions`.
 * Lignes mal formées ignorées.
 */
export function parseMountinfo(mountinfo: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const l of mountinfo.split('\n')) {
    const f = l.split(' ');
    const dash = f.indexOf('-', 6);
    if (f.length < 7 || dash < 0 || dash + 2 >= f.length) continue;
    out.push({ majmin: f[2], root: unescapeMount(f[3]), mount: unescapeMount(f[4]), fstype: unescapeMount(f[dash + 1]), source: unescapeMount(f[dash + 2]) });
  }
  return out;
}
