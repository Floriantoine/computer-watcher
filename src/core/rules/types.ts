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
  | { kind: 'forecast'; underMin: number; includeApps: string[] }
  /**
   * (d) anti-gel : la RAM utilisée (d'après MemAvailable) ≥ `memPercent` pendant `memForSec`, OU le CPU total ≥
   * `cpuPercent` pendant `cpuForSec`. Cible : la plus grosse « vérification » (instance de catégorie Test, ou `tsc` /
   * `eslint` reconnus à leur ligne de commande), une à la fois.
   */
  | { kind: 'system'; memPercent: number; memForSec: number; cpuPercent: number; cpuForSec: number };

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
  /**
   * Migration « règles recommandées en Active » (2026-10-20) déjà faite. Absent d'une config d'avant : la validation
   * passe les règles recommandées intactes en Active, puis le pose (toujours vrai en sortie de validation).
   */
  recommendedActive?: boolean;
  /** Migration « règle inactif recommandée de 1 j à 4 h » (2026-10-21) déjà faite. Même principe que recommendedActive. */
  recommendedInactive4h?: boolean;
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
