// Anti-gel (lot 1) : qui ranger dans cwatch.slice (décision pure). Spec, « Qui est déplacé » ; décisions 1 à 3 du plan.
import type { Category } from '../classify/categories';
import { checkCommand, launchesClaude, matchCommand } from '../classify/rules';
import { APP_NAMES, isBashToolShell, isTestBrowser } from '../grouping/rules';
import { APP_PATH, SHELL_COMMS, isClaudeProc, isIdeNodeScript, isIdeProc, isNeverKill, isTerminalName } from '../rules/neverKill';
import type { ProcInfo } from '../types';
import { ROOT_SLICE } from './units';

/** Catégories de travail (classement par ligne de commande, jamais par le comm). */
export const WORK_CATEGORIES: ReadonlySet<Category> = new Set<Category>(['test', 'build', 'front', 'back', 'worker', 'db']);
/** Shells (liste « jamais tuer ») : jamais racine déplacée, mais ils suivent leur parent dans un sous-arbre de travail. */
const SHELLS: ReadonlySet<string> = new Set(SHELL_COMMS);
/**
 * Âge minimal (s) d'une racine déplacée : un lanceur tout juste né n'a peut-être pas encore lancé l'intouchable qui le
 * bloquerait (claude, l'app, un navigateur) ; or un processus déplacé n'est jamais ressorti, ni ses futurs enfants.
 */
export const MIN_ROOT_AGE_SEC = 10;

export interface PlanTarget { pid: number; startTicks: number }

export interface PlanInput {
  procs: readonly ProcInfo[];
  /** Racine du projet du groupe d'un processus (groupe `project:` hors `/` et dossier personnel), null sinon. */
  projectOf: (pid: number) => string | null;
  currentUid: number;
  selfPid: number;
  appRoot: string | null;
  isProtected: (name: string) => boolean;
  /** cgroup v2 d'un processus (« /user.slice/… »), null si illisible ; appelé seulement pour les ancres, racines retenues et leurs descendants. */
  cgroupOf: (pid: number) => string | null;
  /** Unité du gestionnaire utilisateur : « /user.slice/user-1000.slice/user@1000.service ». */
  userBase: string;
  /** Dossiers de config de Claude (chemins réels), pour reconnaître les shells de l'outil Bash (`<dir>/shell-snapshots/`). */
  claudeDirs?: readonly string[];
  /** Cache facultatif « pid:startTicks » → travail d'après la ligne de commande (elle ne change pas). */
  workMemo?: Map<string, boolean>;
}

export type PlanRefusal = 'uid' | 'blocked' | 'moved' | 'outside-user' | 'other-unit' | 'cgroup' | 'anchor-cgroup' | 'young';
export interface PlanMove { rootPid: number; root: string | null; anchorCgroup: string; targets: PlanTarget[] }
export interface PlanResult {
  moves: PlanMove[];
  refused: { pid: number; reason: PlanRefusal }[];
  /** Racines de travail déjà sous cwatch.slice (reconstruction de l'attribution unité → projet). */
  inside: { pid: number; cgroup: string; root: string | null }[];
}

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/**
 * Vraie appli (navigateur ouvert par `vite --open`…) : le regroupement s'y arrête aussi ; un navigateur de test suit son
 * test, un script Node exécuté par l'éditeur (tsserver, comm « code ») n'est pas l'éditeur.
 */
const isRealApp = (p: ProcInfo) => APP_NAMES.has(p.name) && !isTestBrowser(p.cmdline) && !isIdeNodeScript(p);
/** Dossier de travail dans l'app (n'importe quel worktree, sous ses deux noms) : `npm run dev` de l'app avant qu'electron ne naisse. */
const inAppDir = (p: ProcInfo) => p.cwd !== null && APP_PATH.test(p.cwd);
/** Ligne de commande vue par le classement : le script d'un éditeur lancé en Node (ELECTRON_RUN_AS_NODE) est lu comme `node <script>`. */
const asNode = (p: ProcInfo): { name: string; cmdline: string } =>
  isIdeNodeScript(p) ? { name: 'node', cmdline: `node ${p.cmdline.split(/\s+/).slice(1).join(' ')}` } : p;
/** Ligne de commande vide, « [nom] » : processus zombie (ou thread noyau). Ni racine, ni cible (l'attacher échouerait). */
const isZombieLike = (p: ProcInfo) => p.cmdline.startsWith('[');

export function planMoves(input: PlanInput): PlanResult {
  const me = input.currentUid;
  const byPid = new Map<number, ProcInfo>();
  for (const p of input.procs) byPid.set(p.pid, p);
  const children = new Map<number, ProcInfo[]>();
  for (const p of input.procs) {
    if (p.ppid === p.pid || !byPid.has(p.ppid)) continue;
    const l = children.get(p.ppid);
    if (l) l.push(p);
    else children.set(p.ppid, [p]);
  }
  const kids = (p: ProcInfo) => children.get(p.pid) ?? [];
  const cgMemo = new Map<number, string | null>();
  const cg = (pid: number): string | null => {
    if (!cgMemo.has(pid)) cgMemo.set(pid, input.cgroupOf(pid));
    return cgMemo.get(pid)!;
  };
  const cwatch = `${input.userBase}/${ROOT_SLICE}`;
  const isAnchor = (p: ProcInfo) => isTerminalName(p.name) || isIdeProc(p) || isClaudeProc(p);
  const neverMove = (p: ProcInfo) =>
    p.pid <= 1 || p.pid === input.selfPid || isNeverKill(p, input.appRoot) || isIdeProc(p) || isRealApp(p) || inAppDir(p) ||
    launchesClaude(p.name, p.cmdline) || input.isProtected(p.name);
  const isWork = (p: ProcInfo): boolean => {
    if (input.projectOf(p.pid) !== null) return true;
    const key = `${p.pid}:${p.startTicks}`;
    let v = input.workMemo?.get(key);
    if (v === undefined) {
      const q = asNode(p);
      const cat = matchCommand([q])?.category;
      v = (cat !== undefined && WORK_CATEGORIES.has(cat)) || checkCommand(q.name, q.cmdline) !== null;
      input.workMemo?.set(key, v);
    }
    return v;
  };
  /** Un descendant d'un autre utilisateur, ou intouchable autre qu'un shell (Claude, terminal, éditeur, l'app, vraie appli, protégé…). */
  const blocked = (root: ProcInfo): boolean => {
    const stack = [...kids(root)];
    const seen = new Set<number>([root.pid]);
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      if (c.uid !== me || isAnchor(c) || (neverMove(c) && !SHELLS.has(c.name))) return true;
      stack.push(...kids(c));
    }
    return false;
  };

  // Partie de Claude (serveurs MCP, hooks, LSP, `bash -c` d'un MCP local) : ses enfants directs autres que les shells de
  // l'outil Bash, et tout leur sous-arbre. Jamais déplacés, et aucune ancre là-dessous. Le travail lancé par Claude passe
  // par l'outil Bash (`zsh -c source …/shell-snapshots/… && …`) et reste déplaçable.
  const dirs = input.claudeDirs ?? [];
  const claudeOwned = new Set<number>();
  for (const c of input.procs) {
    if (c.uid !== me || !isClaudeProc(c)) continue;
    const stack = kids(c).filter((k) => !isBashToolShell(k, dirs));
    while (stack.length) {
      const k = stack.pop()!;
      if (k.pid === c.pid || claudeOwned.has(k.pid)) continue;
      claudeOwned.add(k.pid);
      stack.push(...kids(k));
    }
  }

  const moves: PlanMove[] = [];
  const refused: PlanResult['refused'] = [];
  const inside: PlanResult['inside'] = [];

  const move = (root: ProcInfo, anchor: ProcInfo): void => {
    const ca = cg(anchor.pid);
    if (ca === null || ca === input.userBase || !under(ca, input.userBase) || under(ca, cwatch)) {
      refused.push({ pid: root.pid, reason: 'anchor-cgroup' });
      return;
    }
    const cr = cg(root.pid);
    if (cr === null) {
      refused.push({ pid: root.pid, reason: 'cgroup' });
      return;
    }
    if (under(cr, cwatch)) {
      inside.push({ pid: root.pid, cgroup: cr, root: input.projectOf(root.pid) });
      refused.push({ pid: root.pid, reason: 'moved' });
      return;
    }
    if (!under(cr, input.userBase)) {
      refused.push({ pid: root.pid, reason: 'outside-user' });
      return;
    }
    if (cr !== ca) {
      refused.push({ pid: root.pid, reason: 'other-unit' });
      return;
    }
    // la racine et tous ses descendants restés dans l'unité de l'ancre (les futurs enfants héritent seuls), zombies exceptés
    const targets: PlanTarget[] = [];
    let project = input.projectOf(root.pid);
    const stack = [root];
    const seen = new Set<number>();
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      if (c.uid === me && !isZombieLike(c) && cg(c.pid) === ca) {
        targets.push({ pid: c.pid, startTicks: c.startTicks });
        project ??= input.projectOf(c.pid);
      }
      stack.push(...[...kids(c)].reverse());
    }
    moves.push({ rootPid: root.pid, root: project, anchorCgroup: ca, targets });
  };

  // Descente depuis chaque ancre (terminal, éditeur, Claude) de l'utilisateur jusqu'à la prochaine ancre.
  for (const a of input.procs) {
    if (a.uid !== me || !isAnchor(a) || claudeOwned.has(a.pid)) continue;
    const stack = [...kids(a)];
    const seen = new Set<number>([a.pid]);
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      if (claudeOwned.has(p.pid)) continue; // partie de Claude : ni lui, ni son sous-arbre
      if (isAnchor(p)) continue; // sa propre descente
      if (p.uid !== me) {
        refused.push({ pid: p.pid, reason: 'uid' });
        continue;
      }
      if (neverMove(p)) {
        if (SHELLS.has(p.name)) stack.push(...kids(p)); // shell : on regarde ce qu'il lance ; autre intouchable : on s'arrête
        // lanceur de Claude ou de l'app, même sans enfant encore visible : refusé comme un lanceur bloqué
        else if (launchesClaude(p.name, p.cmdline) || inAppDir(p)) refused.push({ pid: p.pid, reason: 'blocked' });
        continue;
      }
      if (isZombieLike(p) || !isWork(p)) {
        stack.push(...kids(p));
        continue;
      }
      if (blocked(p)) {
        refused.push({ pid: p.pid, reason: 'blocked' });
        stack.push(...kids(p));
        continue;
      }
      if (p.ageSec < MIN_ROOT_AGE_SEC) {
        refused.push({ pid: p.pid, reason: 'young' }); // revu au prochain tick, avec ses enfants
        continue;
      }
      move(p, a);
    }
  }
  return { moves, refused, inside };
}
