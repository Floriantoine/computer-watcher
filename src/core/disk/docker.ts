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

/** Images qu'aucun conteneur (même arrêté) n'utilise : celles que `docker image prune -a` retire. */
export function unusedImages(images: readonly Record<string, unknown>[], containers: readonly Record<string, unknown>[]): string[] {
  const used = new Set(containers.map((c) => str(c.Image)));
  return images
    .filter((i) => {
      const repo = str(i.Repository);
      const tag = str(i.Tag);
      const id = str(i.ID);
      const names = [`${repo}:${tag}`, tag === 'latest' ? repo : '', id, `sha256:${id}`].filter(Boolean);
      return !names.some((n) => used.has(n)) && ![...used].some((u) => id && u.startsWith(id));
    })
    .map((i) => (str(i.Repository) === '<none>' ? `<sans nom> ${str(i.ID)} (${str(i.Size)})` : `${str(i.Repository)}:${str(i.Tag)} (${str(i.Size)})`));
}

/** Conteneurs que `docker container prune` retire (arrêtés, créés jamais lancés, morts). */
export function stoppedContainers(containers: readonly Record<string, unknown>[]): string[] {
  return containers.filter((c) => ['exited', 'created', 'dead'].includes(str(c.State))).map((c) => `${str(c.Names)} (${str(c.Image)}, ${str(c.Status)})`);
}

/** Volumes inutilisés : anonymes (64 caractères hexadécimaux, retirés) et nombre de nommés (gardés). */
export function anonymousVolumes(volumes: readonly Record<string, unknown>[]): { anonymous: string[]; named: number } {
  const names = volumes.map((v) => str(v.Name)).filter(Boolean);
  const anonymous = names.filter((n) => /^[0-9a-f]{64}$/.test(n));
  return { anonymous, named: names.length - anonymous.length };
}

export interface DockerActionView { id: DockerAction; reclaimKB: number | null; items: string[]; note?: string }
export interface DockerView { version: string; actions: DockerActionView[] }
