// src/core/rules/verification.ts — « vérifications » visées par la règle anti-gel (saturation) : lanceur de tests, tsc (hors
// --watch) ou eslint, reconnus à leur ligne de commande comme le classement (jamais au comm « MainThread » de Node ≥ 24).
// Autorisé par l'utilisateur (2026-10-19) : pour cette seule règle, une vérification lancée par Claude peut être arrêtée ;
// Claude lui-même, ses serveurs MCP et tout ce qui n'est pas une vérification restent intouchables.
import { checkCommand, matchCommand } from '../classify/rules';
import { isClaudeProc } from './neverKill';

interface VerifProc { pid: number; ppid: number; name: string; cmdline: string }

/** Nom de la vérification (« vitest », « tsc »…) ou null ; jamais Claude lui-même. */
export function verificationKind(p: { name: string; cmdline: string }): string | null {
  if (isClaudeProc(p)) return null;
  const m = matchCommand([p]);
  if (m?.category === 'test') return m.label;
  return checkCommand(p.name, p.cmdline);
}

/**
 * Vérifications parmi les processus connus, avec tous leurs descendants (workers). Un descendant qui est Claude n'en fait
 * jamais partie, ni ce qui est sous lui.
 */
export function verificationPids(byPid: ReadonlyMap<number, VerifProc>): Set<number> {
  const children = new Map<number, number[]>();
  for (const p of byPid.values()) if (p.ppid !== p.pid) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const out = new Set<number>();
  const stack: number[] = [];
  for (const p of byPid.values()) if (verificationKind(p)) stack.push(p.pid);
  while (stack.length) {
    const pid = stack.pop()!;
    if (out.has(pid)) continue;
    const p = byPid.get(pid);
    if (!p || isClaudeProc(p)) continue;
    out.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}
