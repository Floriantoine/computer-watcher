import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RULE_TEMPLATES } from '../../../core/rules/config';
import type { Rule } from '../../../core/rules/types';
import { ruleToForm, type RuleErrors, type RuleForm } from '../rulesForm';
import { SystemRuleFields } from './RulesPanel';

const noop = () => {};
const sysRule: Rule = { ...RULE_TEMPLATES[3]!, id: 'r-a', createdAt: 0 };
const html = (form: RuleForm, errors: RuleErrors = {}) => renderToStaticMarkup(createElement(SystemRuleFields, { form, errors, onChange: noop }));

describe('Réglages › Règles : condition « Saturation »', () => {
  it('six champs éditables, pression mémoire comprise, aux valeurs de la règle', () => {
    const h = html(ruleToForm(sysRule));
    for (const [id, v] of [['rule-mem-percent', '95'], ['rule-mem-for-sec', '15'], ['rule-cpu-percent', '95'], ['rule-cpu-for-sec', '60'], ['rule-psi-percent', '40'], ['rule-psi-for-sec', '20']]) {
      expect(h).toContain(`data-testid="${id}" value="${v}"`);
    }
    expect(h).toContain('Ou pression mémoire au-dessus de');
  });

  it('une phrase d’aide dit ce qu’est la pression mémoire, et que vides elle ne compte pas', () => {
    const h = html(ruleToForm(sysRule));
    expect(h).toContain('part du temps où tout ce qui tourne attend la mémoire');
    expect(h).toContain('Les deux champs vides : pas de condition de pression.');
  });

  it('cible : une vérification, y compris lancée par Claude ; jamais Claude lui-même ni ses serveurs MCP', () => {
    const h = html(ruleToForm(sysRule));
    expect(h).toContain('y compris une lancée par Claude ; jamais Claude lui-même ni ses serveurs MCP');
    expect(h).not.toContain('jamais une lancée par Claude');
  });

  it('règle d’avant la pression : champs de pression vides ; erreurs affichées sous leur champ', () => {
    const old = ruleToForm({ ...sysRule, condition: { kind: 'system', memPercent: 90, memForSec: 20, cpuPercent: 99, cpuForSec: 120 } });
    expect(html(old)).toContain('data-testid="rule-psi-percent" value=""');
    expect(html(old)).toContain('data-testid="rule-psi-for-sec" value=""');
    expect(html(old, { psiPercent: 'Un entier entre 10 et 90, ou les deux champs de pression vides' })).toContain('Un entier entre 10 et 90, ou les deux champs de pression vides');
  });
});
