# proc-watch

Voir ce qui tourne sur ta machine Linux, depuis combien de temps, ce que ça consomme — et le tuer en un clic.

Né d'un PC gelé dix minutes par 19 Go de swap : vieilles sessions de terminal, serveurs de dev oubliés dans des worktrees supprimés, navigateur gourmand. proc-watch regroupe tout ça pour qu'on le voie et qu'on le nettoie avant d'en arriver là.

![Vue principale](docs/screenshot-main.png)

## Ce que ça fait

- **Groupes lisibles** : une carte par appli (Chrome, Spotify…), par projet de dev (tous les `node`, `vite`, `esbuild`… d'un même dépôt), une carte « Claude » qui rassemble toutes les sessions Claude Code (chaque session est une racine de l'arbre de détail), et le reste par nom de commande. Les petits groupes sont rangés dans « Autres ».
- **Ancienneté** de chaque groupe et de chaque processus, en orange au-delà d'un jour.
- **Bandeau système** : RAM, swap, pression mémoire (PSI), charge.
- **Page de détail** : arbre parent → enfants, commande complète, dossier de travail, CPU, RAM, swap.
- **Kill** : `SIGTERM`, puis bouton « Forcer (SIGKILL) » si le processus résiste 3 secondes.
- **Programmes protégés** : terminaux, shells, Claude, bureau… Les tuer demande une confirmation qui dit exactement ce qui va mourir. La liste se modifie dans les Réglages et est conservée dans `~/.config/proc-watch/config.json`.
- proc-watch refuse de tuer lui-même, ses parents (ton terminal) et les processus des autres utilisateurs.

## Installation

### AppImage (toutes distributions)

1. Télécharger `proc-watch-<version>-x86_64.AppImage` depuis les [Releases](https://github.com/Floriantoine/proc-watch/releases).
2. `chmod +x proc-watch-*.AppImage` puis le lancer.
3. Dans **Réglages**, cliquer **Ajouter au menu des applications**.

Sur Ubuntu 22.04+, les AppImage demandent `libfuse2` : `sudo apt install libfuse2`.

### Debian / Ubuntu

```bash
sudo apt install ./proc-watch-<version>-amd64.deb
```

### Depuis les sources

```bash
git clone https://github.com/Floriantoine/proc-watch
cd proc-watch
npm install
npm run dev
```

Avec npm 11.10+ (dont npm 12), les scripts d'installation des dépendances sont bloqués par défaut ; le champ `allowScripts` de `package.json` autorise le script d'installation d'`electron`, qui télécharge le binaire Electron (indispensable) ; celui d'`esbuild` n'est qu'une optimisation de démarrage, il n'est pas requis. Un simple `npm install` suffit.

## Développement

| Commande | Rôle |
|---|---|
| `npm run dev` | lance l'app avec rechargement à chaud |
| `npm test` | tests unitaires (Vitest) |
| `npm run typecheck` | vérification TypeScript |
| `npm run smoke` | build + lancement réel de l'app via Playwright |
| `npm run dist` | produit l'AppImage et le .deb dans `release/` |

La logique (lecture de `/proc`, regroupement, protection, kill) vit dans `src/core/`, sans dépendance à Electron, et se teste sur de faux répertoires `/proc`. Pour reconnaître une nouvelle appli multi-processus ou un nouvel outil de dev, modifier `src/core/grouping/rules.ts`.

## Va bien avec earlyoom

proc-watch ne tue jamais rien tout seul. Pour éviter qu'un manque de mémoire ne gèle la machine, installe [earlyoom](https://github.com/rfjakob/earlyoom). Une future version permettra de le configurer depuis proc-watch.

## Licence

MIT
