import type { InstanceSummary } from '../types';
import type { Category } from './categories';
import type { CommandMatch } from './match';
import { categoryForPorts } from './portRules';
import type { PackageHints } from './packageJson';

export interface DecideInput {
  overrideKey: string; overrides: Record<string, Category>;
  match: CommandMatch | null; ports: number[]; chainText: string; pkg: PackageHints | null;
  /** Optionnel : applique les règles de commande au texte d'un script package.json. */
  matchScript?: (script: string) => CommandMatch | null;
}

const SCRIPT_NAME = /^(dev|start)/;

export function decide(input: DecideInput): { category: Category; source: InstanceSummary['source'] } {
  const o = Object.prototype.hasOwnProperty.call(input.overrides, input.overrideKey) ? input.overrides[input.overrideKey] : undefined;
  if (o) return { category: o, source: 'manual' };
  if (input.match) return { category: input.match.category, source: 'command' };
  const port = categoryForPorts(input.ports, input.chainText);
  if (port) return { category: port, source: 'port' };
  const pkg = input.pkg;
  if (pkg) {
    if (input.matchScript && input.chainText.length >= 3) {
      for (const [name, script] of Object.entries(pkg.scripts)) {
        if (!SCRIPT_NAME.test(name) || !script.includes(input.chainText)) continue;
        const m = input.matchScript(script);
        if (m) return { category: m.category, source: 'package' };
      }
    }
    if (pkg.front) return { category: 'front', source: 'package' };
    if (pkg.back) return { category: 'back', source: 'package' };
  }
  return { category: 'unknown', source: 'unknown' };
}
