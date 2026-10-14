// Page Disque, lot 2 (pur) : actions Docker fermées et lecture des sorties `--format {{json .}}`.

export type DockerAction = 'images' | 'containers' | 'volumes';
export const DOCKER_ACTIONS: readonly DockerAction[] = ['images', 'containers', 'volumes'];
export const isDockerAction = (v: unknown): v is DockerAction => typeof v === 'string' && (DOCKER_ACTIONS as readonly string[]).includes(v);

export const DOCKER_LABELS: Record<DockerAction, string> = {
  images: 'Images Docker inutilisées',
  containers: 'Conteneurs Docker arrêtés',
  volumes: 'Volumes Docker anonymes inutilisés',
};

/** Arguments figés (après le binaire docker). */
export function dockerPruneArgs(a: DockerAction): string[] {
  switch (a) {
    case 'images': return ['image', 'prune', '-a', '-f'];
    case 'containers': return ['container', 'prune', '-f'];
    case 'volumes': return ['volume', 'prune', '-f'];
  }
}

/**
 * Revue I-4 : avant l'API 1.42 (Docker 23.0), `docker volume prune` retire aussi les volumes nommés. Vrai seulement pour
 * une version d'API lisible (« 1.42 », « 1.47 »…) au moins égale à 1.42.
 */
export function volumePruneKeepsNamed(api: string): boolean {
  const m = /^(\d{1,4})\.(\d{1,4})$/.exec(api.trim());
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 1 || (major === 1 && minor >= 42);
}
export const DOCKER_TOO_OLD = 'Docker trop ancien : docker volume prune supprimerait aussi les volumes nommés';

const UNITS: Record<string, number> = { '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 };

/** Taille affichée par docker (unités décimales : « 1.2GB », « 0B », « 1.2GB (37%) ») → Ko ; null si illisible. */
export function parseDockerSize(s: string): number | null {
  const m = /^([\d.]+)\s*([kKMGTP]?)B\b/.exec(s.trim());
  if (!m || !Number.isFinite(Number(m[1]))) return null;
  return Math.round((Number(m[1]) * UNITS[m[2]]) / 1024);
}

/** Une ligne JSON par objet ; lignes invalides ou non-objets ignorées. */
export function parseJsonLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    try {
      const o = JSON.parse(line) as unknown;
      if (typeof o === 'object' && o !== null && !Array.isArray(o)) out.push(o as Record<string, unknown>);
    } catch {
      // ligne illisible
    }
  }
  return out;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** `docker system df --format {{json .}}` → place récupérable par action. */
export function reclaimByAction(df: readonly Record<string, unknown>[]): Record<DockerAction, number | null> {
  const of = (type: string) => {
    const row = df.find((r) => r.Type === type);
    return row ? parseDockerSize(str(row.Reclaimable)) : null;
  };
  return { images: of('Images'), containers: of('Containers'), volumes: of('Local Volumes') };
}

function unusedImageRows(images: readonly Record<string, unknown>[], containers: readonly Record<string, unknown>[]) {
  const used = new Set(containers.map((c) => str(c.Image)));
  return images.filter((i) => {
    const repo = str(i.Repository);
    const tag = str(i.Tag);
    const id = str(i.ID);
    const names = [`${repo}:${tag}`, tag === 'latest' ? repo : '', id, `sha256:${id}`].filter(Boolean);
    return !names.some((n) => used.has(n)) && ![...used].some((u) => id && u.startsWith(id));
  });
}

/** Images qu'aucun conteneur (même arrêté) n'utilise : celles que `docker image prune -a` retire. */
export function unusedImages(images: readonly Record<string, unknown>[], containers: readonly Record<string, unknown>[]): string[] {
  return unusedImageRows(images, containers)
    .map((i) => (str(i.Repository) === '<none>' ? `<sans nom> ${str(i.ID)} (${str(i.Size)})` : `${str(i.Repository)}:${str(i.Tag)} (${str(i.Size)})`));
}

/** Revue m-2 : identifiants stables des mêmes images (dépôt:étiquette@ID, sans la taille affichée). */
export function unusedImageKeys(images: readonly Record<string, unknown>[], containers: readonly Record<string, unknown>[]): string[] {
  return unusedImageRows(images, containers).map((i) => `${str(i.Repository)}:${str(i.Tag)}@${str(i.ID)}`);
}

const stoppedRows = (containers: readonly Record<string, unknown>[]) => containers.filter((c) => ['exited', 'created', 'dead'].includes(str(c.State)));

/** Conteneurs que `docker container prune` retire (arrêtés, créés jamais lancés, morts). */
export function stoppedContainers(containers: readonly Record<string, unknown>[]): string[] {
  return stoppedRows(containers).map((c) => `${str(c.Names)} (${str(c.Image)}, ${str(c.Status)})`);
}

/** Revue m-2 : identifiants stables des mêmes conteneurs (ID, sinon nom), jamais le Status (« Exited (0) 3 weeks ago »). */
export function stoppedContainerKeys(containers: readonly Record<string, unknown>[]): string[] {
  return stoppedRows(containers).map((c) => str(c.ID) || str(c.Names));
}

/** Volumes inutilisés : anonymes (64 caractères hexadécimaux, retirés) et nombre de nommés (gardés). */
export function anonymousVolumes(volumes: readonly Record<string, unknown>[]): { anonymous: string[]; named: number } {
  const names = volumes.map((v) => str(v.Name)).filter(Boolean);
  const anonymous = names.filter((n) => /^[0-9a-f]{64}$/.test(n));
  return { anonymous, named: names.length - anonymous.length };
}

/** `keys` : identifiant stable de chaque élément de `items` (même ordre), pour comparer deux analyses (revue m-2). */
export interface DockerActionView { id: DockerAction; reclaimKB: number | null; items: string[]; keys?: string[]; note?: string }
export interface DockerView { version: string; actions: DockerActionView[] }
