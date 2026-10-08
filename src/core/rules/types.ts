// src/core/rules/types.ts — règles automatiques (⑥) : condition + action (SIGTERM puis SIGKILL), Simulation ou Active.
import type { Category } from '../classify/categories';

export type RuleMode = 'simulate' | 'active';

/** Nom comparé tel quel (sans casse, jamais interprété comme regex), ou catégorie du classement. */
export type RuleMatch = { by: 'name'; value: string } | { by: 'category'; value: Category };

export type RuleCondition =
  /** (a) un groupe ou une instance dont le nom ou la catégorie correspond dépasse `overMB` (RAM + swap) pendant `forMin`. */
  | { kind: 'memory'; target: 'group' | 'instance'; match: RuleMatch; overMB: number; forMin: number }
  /** (b) une instance de projet (groupes project/deleted seulement) d'une de ces catégories, inactive depuis `forHours`. */
  | { kind: 'inactive'; categories: Category[]; forHours: number }
  /**
   * (c) la prévision ② annonce l'épuisement dans moins de `underMin` : le plus gros groupe qui grossit. Les groupes
   * d'applis (navigateur, éditeur…) ne sont visés que si leur nom est dans `includeApps` (choix explicite).
   */
  | { kind: 'forecast'; underMin: number; includeApps: string[] };

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  mode: RuleMode;
  condition: RuleCondition;
  createdAt: number;
}

export interface RulesConfig {
  /** Interrupteur général « Règles automatiques » : éteint, rien ne tourne (pas même les simulations). */
  enabled: boolean;
  list: Rule[];
}

/** Règle du fichier refusée par la validation : ignorée (désactivée) seule, avec son erreur affichée. */
export interface RuleIssue {
  index: number;
  id: string | null;
  name: string | null;
  error: string;
}

/** Réglages › Règles : dernier déclenchement et nombre de déclenchements sur 7 jours (escalades SIGKILL et quotas non comptés). */
export interface RuleStats {
  lastTs: number | null;
  lastResult: string | null;
  count7d: number;
}
