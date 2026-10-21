// `computer-watcher claude-hook` : hook PreToolUse de Claude Code pour l'outil Bash. Lit l'évènement JSON sur stdin ;
// si la commande est un travail lourd dans un projet qui a un budget anti-gel, renvoie la commande réécrite
// (`computer-watcher run -- …`) par `hookSpecificOutput.updatedInput`, SANS décision d'autorisation : la commande
// réécrite repasse par le parcours normal des permissions de Claude Code.
//
// Format vérifié le 2026-10-21 sur https://code.claude.com/docs/en/hooks (« PreToolUse decision control ») :
// updatedInput « Replaces the entire input object, so include unchanged fields alongside modified ones » ; Claude Code
// évalue les règles de permission sur l'entrée renvoyée. La doc décrit updatedInput « combiné » à "allow" ou "ask" ;
// sans permissionDecision, son effet n'est pas documenté. `--ask` ajoute la décision "ask" (documentée : montre la
// commande modifiée et demande confirmation). Jamais "allow".
//
// Au moindre doute ou erreur : aucune sortie, code 0 (la commande part telle quelle, jamais bloquée).
import { rewrite, type WrapCliDeps } from './wrap';

export const CLAUDE_HOOK_USAGE = `Usage : computer-watcher claude-hook [--ask]

Hook PreToolUse de Claude Code (outil Bash) : lit l'évènement JSON sur l'entrée standard et, pour un travail lourd
dans un projet qui a un budget anti-gel, remplace la commande par computer-watcher run -- … (updatedInput), sans
donner d'autorisation. --ask : demande aussi confirmation (permissionDecision "ask"). Sinon : aucune sortie, code 0.
`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function claudeHookCli(args: readonly string[], d: WrapCliDeps): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    d.stdout(CLAUDE_HOOK_USAGE);
    return 0;
  }
  try {
    const ev: unknown = JSON.parse(await d.readStdin());
    if (!isObj(ev) || ev.tool_name !== 'Bash' || (ev.hook_event_name !== undefined && ev.hook_event_name !== 'PreToolUse')) return 0;
    const input = ev.tool_input;
    if (!isObj(input) || typeof input.command !== 'string' || typeof ev.cwd !== 'string') return 0;
    // shell des lignes composées : celui de l'utilisateur s'il est zsh, sinon bash
    const shell = /(^|\/)zsh$/.test(d.env.SHELL ?? '') ? 'zsh' : 'bash';
    const command = rewrite(d, input.command, ev.cwd, shell);
    if (command === null) return 0;
    const out: Record<string, unknown> = { hookEventName: 'PreToolUse', updatedInput: { ...input, command } };
    if (args.includes('--ask')) {
      out.permissionDecision = 'ask';
      out.permissionDecisionReason = 'Computer Watcher : commande lancée directement dans le budget anti-gel du projet (computer-watcher run).';
    }
    d.stdout(`${JSON.stringify({ hookSpecificOutput: out })}\n`);
  } catch {
    // entrée illisible ou erreur interne : rien, la commande part telle quelle
  }
  return 0;
}
