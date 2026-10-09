// Soleil de la page Disque (pur) : arbre des tailles du dossier personnel, élagué, puis arcs à dessiner.
// Le parcours ne suit jamais de lien et ne traverse jamais de montage (autre `dev` que la racine).

export interface SunNode { name: string; path: string; sizeKB: number; children: SunNode[]; other?: boolean }

/** Accès au système de fichiers (injectable) : `lstat` ne suit pas les liens ; `blocksKB` = place réellement occupée. */
export interface ScanFs {
  lstat(p: string): { isDir: boolean; isLink: boolean; dev: number; blocksKB: number };
  readdir(p: string): string[];
}

export interface SunTreeOptions {
  /** Niveaux gardés comme nœuds sous la racine ; plus bas, les tailles comptent sans nœud. */
  maxDepth: number;
  /** Enfants sous cette part de leur parent fusionnés en « autres » (0,005 = 0,5 %). */
  minShare: number;
  /** Budget d'entrées lues (lstat) ; au-delà, parcours arrêté, `truncated`. */
  maxEntries: number;
  /** Instant limite (même horloge que `now`). */
  deadline: number;
  now: () => number;
  /** Ko lus jusqu'ici (appelé toutes les PROGRESS_EVERY entrées et à la fin). */
  onProgress?: (kb: number) => void;
}

const PROGRESS_EVERY = 2000;
/** Garde-fou contre une arborescence anormalement profonde (pile d'appels). */
const MAX_DESCENT = 64;
export const OTHER_NAME = 'autres';

const join = (dir: string, name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`);
const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

/** Trie par taille décroissante et fusionne les enfants sous `minShare` du total en un nœud « autres ». */
function prune(path: string, children: SunNode[], total: number, minShare: number): SunNode[] {
  children.sort((a, b) => b.sizeKB - a.sizeKB);
  const keep: SunNode[] = [];
  let small = 0;
  for (const c of children) {
    if (c.sizeKB <= 0) continue;
    if (total > 0 && c.sizeKB < total * minShare) small += c.sizeKB;
    else keep.push(c);
  }
  if (small > 0) keep.push({ name: OTHER_NAME, path: `${join(path, '')}\u0000${OTHER_NAME}`, sizeKB: small, children: [], other: true });
  return keep;
}

export function buildSunTree(root: string, fs: ScanFs, o: SunTreeOptions): { tree: SunNode; truncated: boolean } {
  let entries = 0;
  let totalKB = 0;
  let truncated = false;
  const rootDev = fs.lstat(root).dev;
  const out = () => truncated || (entries >= o.maxEntries || o.now() > o.deadline ? (truncated = true) : false);

  const walk = (dir: string, depth: number): SunNode => {
    const node: SunNode = { name: baseName(dir), path: dir, sizeKB: 0, children: [] };
    let names: string[];
    try {
      names = fs.readdir(dir);
    } catch {
      return node; // illisible : ignoré
    }
    const kids: SunNode[] = [];
    for (const name of names) {
      if (out()) break;
      const p = join(dir, name);
      let st;
      try {
        st = fs.lstat(p);
      } catch {
        continue; // disparu entre-temps
      }
      entries++;
      if (entries % PROGRESS_EVERY === 0) o.onProgress?.(totalKB);
      if (st.isLink) continue; // jamais suivi, compté 0
      let k: SunNode;
      if (st.isDir) {
        if (st.dev !== rootDev || depth + 1 > MAX_DESCENT) continue; // montage : jamais parcouru
        k = walk(p, depth + 1);
        k.sizeKB += st.blocksKB; // le dossier lui-même
        totalKB += st.blocksKB;
      } else {
        totalKB += st.blocksKB;
        k = { name, path: p, sizeKB: st.blocksKB, children: [] };
      }
      node.sizeKB += k.sizeKB;
      if (depth < o.maxDepth) kids.push(k);
    }
    node.children = depth < o.maxDepth ? prune(dir, kids, node.sizeKB, o.minShare) : [];
    return node;
  };

  const tree = walk(root, 0);
  o.onProgress?.(totalKB);
  return { tree, truncated };
}

export interface Arc { path: string; name: string; depth: number; a0: number; a1: number; sizeKB: number; other: boolean }

/** Arcs des descendants de `node` sur `levels` niveaux, angles en degrés (enfants triés par taille décroissante). */
export function sunArcs(node: SunNode, levels: number): Arc[] {
  const out: Arc[] = [];
  const place = (n: SunNode, depth: number, a0: number, a1: number) => {
    if (depth > levels) return;
    const kids = [...n.children].sort((a, b) => b.sizeKB - a.sizeKB);
    const total = kids.reduce((s, k) => s + k.sizeKB, 0);
    if (total <= 0) return;
    let a = a0;
    for (const k of kids) {
      const b = a + ((a1 - a0) * k.sizeKB) / total;
      out.push({ path: k.path, name: k.name, depth, a0: a, a1: b, sizeKB: k.sizeKB, other: !!k.other });
      place(k, depth + 1, a, b);
      a = b;
    }
  };
  place(node, 1, 0, 360);
  return out;
}

/** Nœud au chemin donné sous `root` (null si absent ou élagué). */
export function findNode(root: SunNode, path: string): SunNode | null {
  if (root.path === path) return root;
  for (const c of root.children) {
    if (path === c.path || path.startsWith(`${c.path}/`)) return findNode(c, path);
  }
  return null;
}
