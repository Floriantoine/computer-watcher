# proc-watch

Voir ce qui tourne sur ta machine Linux, depuis combien de temps, ce que ça consomme — et le tuer en un clic.

Né d'un PC gelé dix minutes par 19 Go de swap : vieilles sessions de terminal, serveurs de dev oubliés dans des worktrees supprimés, navigateur gourmand. proc-watch regroupe tout ça pour qu'on le voie et qu'on le nettoie avant d'en arriver là.

![Détail d'un projet : instances classées, ports, doublon](docs/screenshot-main.png)

## Ce que ça fait

- **Groupes lisibles** : une carte par appli (Chrome, Spotify…), par projet de dev (tous les `node`, `vite`, `esbuild`… d'un même dépôt), une carte « Claude » qui rassemble toutes les sessions Claude Code (chaque session est une racine de l'arbre de détail) ; les outils lancés depuis `~/.claude` (ou `$CLAUDE_CONFIG_DIR`) rejoignent aussi le groupe Claude, même détachés de leur session, et le reste par nom de commande. Les petits groupes sont rangés dans « Autres », sauf les projets, toujours visibles.
- **Classement des instances** : chaque serveur de dev est reconnu (Front, Back, BDD, Worker, Tests, Outils…), avec son port en écoute et un badge « en double » s'il tourne deux fois. Filtres par catégorie, « Tuer la sélection », « Tuer le front », « Tout arrêter »… (voir plus bas).
- **Ancienneté** de chaque groupe et de chaque processus, en orange au-delà d'un jour.
- **Bandeau système** : RAM, swap, pression mémoire (PSI), charge.
- **Page de détail** : arbre parent → enfants, commande complète, dossier de travail, CPU, RAM, swap.
- **Kill** : `SIGTERM`, puis bouton « Forcer (SIGKILL) » si le processus résiste 3 secondes.
- **Programmes protégés** : terminaux, shells, Claude, bureau… Les tuer demande une confirmation qui dit exactement ce qui va mourir. La liste se modifie dans les Réglages et est conservée dans `~/.config/proc-watch/config.json`.
- **Mini-courbes** de mémoire sur chaque carte et **vue liste** compacte en alternative aux cartes.
- **Historique en arrière-plan** et onglet **Métriques** (voir plus bas).
- **Icône dans la barre des tâches** : un anneau montre la RAM utilisée, sa couleur suit la pression mémoire (normal, orange, rouge). Son menu donne la RAM, le swap, la pression et la charge, et propose « Ouvrir proc-watch », « Libérer de la mémoire… » et « Quitter ». Fermer la fenêtre la cache dans la barre au lieu de quitter ; la collecte est alors suspendue, comme fenêtre réduite. Les deux se coupent dans Réglages → Affichage. Sur un bureau sans zone de notification (pas de `StatusNotifierWatcher` sur le bus de session), pas d'icône et fermer la fenêtre quitte l'app.
- proc-watch refuse de tuer lui-même, ses parents (ton terminal) et les processus des autres utilisateurs.

## Classement front / back et actions groupées

Dans un projet, proc-watch découpe les processus en **instances** : un serveur et ses enfants (`npm run dev` → `vite` → `esbuild` donne une instance « vite »), classées dans une **catégorie** :

| Catégorie | Exemples |
|---|---|
| Front | `vite`, `next dev`, `nuxt`, `ng serve`, `webpack serve`, `storybook` |
| Back | `nest start`, `node dist/main`, `tsx src/server.ts`, `uvicorn`, `manage.py runserver`, `rails s`, `go run`, `cargo run` |
| BDD | `postgres`, `mysqld`, `redis-server`, `mongod`, `meilisearch` |
| Worker | `celery`, `rq worker`, `sidekiq`, `bullmq`, scripts `worker`/`queue`/`consumer` |
| Tests | `vitest`, `jest`, `playwright test`, `pytest` |
| Outils | `tsc --watch`, `esbuild --watch`, serveurs de langage (`tsserver`, `gopls`, `pyright`…), `vite build` |
| Conteneur, Navigateur, IA, Système | `docker`, `podman` ; Chrome, Firefox ; Claude, serveurs MCP ; bureau et services (kwin, pipewire, systemd…) |
| Inconnu | tout le reste (les shells et terminaux restent sans étiquette) |

**D'où vient la catégorie**, dans cet ordre (la première qui conclut gagne) : ta correction manuelle, puis la ligne de commande, puis le port en écoute (5173 → front, 5432 → BDD, 8000 → back…), puis un script `dev` / `start*` du `package.json` du projet qui lance cette commande. Les dépendances seules (`react`, `express`…) ne classent rien.

- **Reclasser** : dans le détail d'un projet, section « Instances », le menu « Reclasser » corrige une erreur en un clic. Un `node server.js` resté « Inconnu » devient ainsi un « Back ». La correction est retenue pour ce projet et ce motif de commande (elle survit aux redémarrages du serveur) ; « Revenir à l'automatique » l'annule. Toutes les corrections se retrouvent dans Réglages → Classement, où l'on peut les retirer une par une ou tout effacer.
- **Ports** : les ports TCP en écoute sont lus toutes les 10 s dans `/proc/net/tcp{,6}`, pour les projets et les bases seulement, et affichés sur les étiquettes (`Front :5173`). Les ports des processus d'autres utilisateurs (un `postgres` lancé par le système, par exemple) ne sont pas lisibles. Réglages → Classement → « Détecter les ports » coupe cette lecture.
- **Qui tient le port ?** : taper `:3000` (ou `port:3000`) dans la recherche affiche, au-dessus des cartes, les processus qui écoutent ce port (catégorie, projet, commande, ancienneté) et ne garde que leurs cartes. Le bouton **« Libérer :3000 »** n'existe que pour une instance non protégée d'un projet (même périmètre que le kill groupé) : il tue l'instance par le chemin habituel. Les autres lignes (applis, Claude et ses serveurs MCP, commandes, système) ne montrent que l'information et « Voir le groupe ». Dans le détail d'un projet, une instance non protégée qui écoute affiche le même bouton. L'onglet Métriques liste tous les **ports ouverts** de tes processus, triés par port, avec le même bouton. Les ports des autres utilisateurs (un `postgres` ou `cups` système) sont signalés (« écouté par un autre utilisateur (uid 965) », « n ports d'autres utilisateurs non affichés ») mais jamais arrêtables, de même que tes ports sans processus lisible (conteneur, autre espace de noms : « n ports sans processus lisible »). Pendant une recherche `:port` sur la page Processus ou onglet Métriques ouvert, les ports de **tous** tes processus sont lus toutes les 10 s, par tranches de quelques millisecondes ; sinon seulement ceux des projets et des bases.
- **Doublons** : deux instances du même projet, de la même catégorie (front, back, worker ou BDD) et de la même commande sont des doublons. Toutes sauf la plus ancienne portent le badge « en double ». Une API et un worker, ou deux applis d'un monorepo, n'en sont pas.
- **Filtres** : sous la barre d'outils, une pastille par catégorie présente (avec le nombre d'instances), à sélection multiple et mémorisée. Un groupe reste affiché s'il a au moins une instance d'une catégorie choisie.
- **Kill groupé** : avec un filtre actif, « Tuer la sélection (n) » ; dans le détail d'un projet, « Tuer le front », « Tuer le back » et « Tout arrêter ». Tous ouvrent la même confirmation, qui liste exactement les instances visées (projet, catégorie, commande, ports, ancienneté, RAM, CPU instantané) avec des raccourcis « Toutes », « Inactives > 1 h », « Inactives > 1 j » et « Doublons seulement ». Garde-fous :
  - seuls les processus des **projets** (et des dossiers supprimés) sont visés : les applis, Claude et les services gardent leurs étiquettes mais ne sont jamais tués en groupe ;
  - les instances **protégées** (🔒) sont décochées par défaut et se cochent une par une ;
  - le kill passe par le même chemin que le kill simple (`SIGTERM`, puis « Forcer » ; refus pour proc-watch lui-même, ses parents et les autres utilisateurs), au plus 2 000 processus par demande.
- **Lanceurs** : `npm`, `pnpm`, `yarn`, `npx`, `concurrently`, `nodemon`, `turbo`… qui ne font que lancer un serveur ne forment pas d'instance : ils s'arrêtent d'eux-mêmes quand leurs enfants meurent. « Tout arrêter » les ajoute au kill du projet seulement si toutes les instances qu'ils lancent sont cochées. Les `sh -c` intermédiaires ne sont jamais visés : ils se terminent avec leur commande.
- **Inactives** : une instance est « inactive depuis 1 h » si elle tourne depuis au moins 1 h et que l'historique n'a aucun échantillon à 1 % de CPU ou plus pour ses processus sur cette période. Ces raccourcis ont donc besoin du service d'enregistrement (voir plus bas) ; s'il est arrêté, ils sont désactivés. Au-delà de 30 minutes, seules les moyennes par minute sont lues : un pic de moins d'une minute peut passer inaperçu.

## Installation

### AppImage (toutes distributions)

1. Télécharger `proc-watch-<version>-x86_64.AppImage` depuis les [Releases](https://github.com/Floriantoine/proc-watcher/releases).
2. `chmod +x proc-watch-*.AppImage` puis le lancer.
3. Dans **Réglages**, cliquer **Ajouter au menu des applications**.

Sur Ubuntu 22.04+, les AppImage demandent `libfuse2` : `sudo apt install libfuse2`.

### Debian / Ubuntu

```bash
sudo apt install ./proc-watch-<version>-amd64.deb
```

### Depuis les sources

```bash
git clone https://github.com/Floriantoine/proc-watcher
cd proc-watcher
npm install
npm run dev
```

Avec npm 11.10+ (dont npm 12), les scripts d'installation des dépendances sont bloqués par défaut. Le champ `allowScripts` de `package.json` n'autorise en pratique que celui d'`esbuild`, une simple optimisation de démarrage qui n'est pas requise. Le paquet `electron` 44 n'a pas de script d'installation : son binaire est téléchargé au premier `require('electron')`. Un simple `npm install` suffit.

## Développement

| Commande | Rôle |
|---|---|
| `npm run dev` | lance l'app avec rechargement à chaud |
| `npm test` | tests unitaires (Vitest) |
| `npm run typecheck` | vérification TypeScript |
| `npm run test:recorder` | build, test de performance du service d'enregistrement et test de bout en bout (base, événements, reprise) |
| `npm run smoke` | build + lancement réel de l'app via Playwright |
| `npm run dist` | produit l'AppImage et le .deb dans `release/` |

La logique (lecture de `/proc`, regroupement, protection, kill) vit dans `src/core/`, sans dépendance à Electron, et se teste sur de faux répertoires `/proc`. Pour reconnaître une nouvelle appli multi-processus, modifier `src/core/grouping/rules.ts` ; pour classer un nouvel outil de dev (front, back…), `src/core/classify/rules.ts`.

## Historique en arrière-plan

Au premier lancement de la version installée (AppImage, .deb), proc-watch installe automatiquement un service systemd utilisateur, `proc-watch-recorder` (sans sudo). Depuis un clone du dépôt (`npm run dev`), rien n'est installé en silence : activer le réglage Réglages → Enregistrement, ou lancer avec `PROC_WATCH_RECORDER_DEV=1`. Il échantillonne le système en continu, même quand la fenêtre est fermée, pour répondre à « qu'est-ce qui a fait geler la machine à 3 h du matin ? ».

- **Couper l'enregistrement** : Réglages → Enregistrement (arrête et supprime le service). `systemctl --user disable --now proc-watch-recorder` seul ne tient pas : tant que le réglage reste activé, l'app réactive le service à son prochain lancement.
- **Ce qui est enregistré** : un échantillon toutes les 5 s. Un groupe est enregistré à part s'il dépasse 20 Mo (RAM+swap) ou 1 % de CPU ; les autres (souvent ~300 petites commandes) sont cumulés dans un seul groupe « Petits groupes ». Un processus seul n'est enregistré que s'il dépasse 50 Mo ou 1 % de CPU. Intervalle, seuils et rétention se règlent dans Réglages → Enregistrement.
- **Données** : `~/.local/share/proc-watch/metrics.db` (SQLite, schéma v4). Rétention par défaut : 24 h détaillées (5 s), 30 jours résumés (par minute et par heure ; les plages de 7 et 30 jours lisent les heures). À la mise à jour du schéma, une copie `metrics.db.pre-v4-*` est faite avant migration si la place le permet (sinon la migration a lieu quand même, avec un avertissement dans Réglages) ; les copies plus vieilles que la rétention résumée sont supprimées. Une base d'une version plus récente n'est jamais écrasée : l'enregistrement se met en pause.
- **Taille mesurée** (test à la cardinalité réelle, `npm run test:recorder`) : ~130 Mo pour les 24 h détaillées, ~3 Mo/jour de résumés pour les groupes et le système, et ~6 à 28 Mo/jour pour les processus selon le nombre de processus courts de plus de 50 Mo (lignes de commande comprises). Soit, à 30 jours, environ 0,4 Go sur une machine calme et jusqu'à ~1,1 Go lors de journées de développement intensives (~1 300 processus distincts > 50 Mo par heure). Monter le seuil mémoire des processus réduit surtout cette dernière part.
- **Lecture** : chaque requête de l'onglet Métriques prend moins de 50 ms à 30 jours d'historique ; les plages de 7 et 30 jours ne se rafraîchissent qu'à la demande (bouton « Actualiser »).
- **Coût mesuré** : sur ~750 processus, un tick du service dure environ 21 à 28 ms et le service occupe environ 34 à 48 Mo de PSS.
- **Vider l'historique** (Réglages → Enregistrement) : supprime aussi les copies de sécurité. Si le service tourne, il vide la base à sa minute suivante ; sinon l'app supprime directement la base, recréée au prochain démarrage du service.
- **Vie privée** : tout reste en local. La base contient les lignes de commande complètes des processus enregistrés (elles peuvent contenir des chemins ou des arguments sensibles) ; fichiers en 0600, dossier en 0700.
- **Désinstaller** : désactiver Réglages → Enregistrement (arrête et supprime le service), ou à la main :
  ```sh
  systemctl --user disable --now proc-watch-recorder
  rm ~/.config/systemd/user/proc-watch-recorder.service
  rm -rf ~/.local/share/proc-watch
  ```
- **Kills earlyoom** : pour les enregistrer, l'utilisateur doit pouvoir lire le journal système (groupe `systemd-journal` ou `adm` sur la plupart des distributions, `wheel` sur certaines). Sans cet accès, Réglages → Enregistrement affiche « Kills earlyoom : indisponibles » et le reste fonctionne normalement.

### Onglet Métriques

- **Enquête — mémoire par groupe** : courbe de la mémoire par groupe sur la période choisie ; cliquer place un curseur sur un instant. Le panneau « À <heure> » liste alors les groupes dont la mémoire a le plus augmenté dans les 5 minutes précédentes.
- **Top consommateurs** : les groupes les plus gourmands en mémoire (moyenne) sur la plage, avec mini-courbe, pic et moyenne.
- **Alertes** : fuites, kills earlyoom, pics de pression et trous d'enregistrement ; un clic place le curseur de l'enquête sur l'événement. Une fuite probable est signalée quand la mémoire d'un groupe monte de façon quasi continue (≥ 80 % des minutes sur 1 h, +300 Mo par défaut, réglable), et un badge « fuite ? » apparaît alors sur sa carte.
- **Swap** : jauge du swap, groupes et instances triés par swap cumulé, avec leur état **actif**, **endormi depuis X** ou **inconnu** (avec la raison), et la ligne « Mémoire partagée (tmpfs, shm…) » (Shmem : RAM + swap non attribuée aux processus ; « Voir » liste les plus gros dossiers de /tmp). **Endormi** : swap cumulé de l'instance ou du groupe au-delà du seuil (100 Mo par défaut, réglable dans l'en-tête du panneau, enregistré à l'Entrée) **et** aucun CPU ≥ 1 % (ou le seuil CPU d'enregistrement s'il est plus haut) depuis 1 jour d'après l'historique. L'historique est lu sur 7 jours au plus (« endormi depuis plus de 7 j »). État « inconnu », et rien de proposé, si le service d'enregistrement est arrêté (aucun échantillon depuis 30 s, ou 3 intervalles s'ils sont plus longs) ou si l'historique est plus court qu'un jour. Un trou d'enregistrement de plus de 10 min (service arrêté, machine en veille) rend la vue « inconnu » pendant les 24 h qui suivent : on ne peut pas affirmer qu'un processus n'a rien fait pendant le trou. « Arrêter les endormis (n) » ouvre le kill groupé habituel, limité aux instances non protégées des projets et dossiers supprimés (jamais celles lancées par une session Claude encore ouverte) ; l'état est revérifié au clic. Une appli endormie (navigateur, lecteur de musique…) a un bouton « Arrêter » individuel, avec confirmation ; jamais Claude, un programme protégé, un groupe de commandes ni un service de session (portail, pipewire, kwallet, kded, KWin, D-Bus, systemd…). Le panneau se relit toutes les 30 s tant que l'onglet est ouvert.

**Gestes sur les graphes** (Métriques et détail d'un groupe) :

| Geste | Effet |
|---|---|
| Glisser sur le graphe, ou Ctrl + molette | zoomer sur une période |
| Maj + molette, ou glisser avec le clic molette | se déplacer dans le temps |
| Double-clic | revenir à la plage complète |
| Zoom collé au bout du graphe | suivi « En direct » : la fenêtre avance avec le temps |
| Survol d'une ligne du Top, de la légende ou d'une alerte | met en avant la courbe ou l'instant correspondant |

### Pop-ups et notifications d'alerte

- **Pop-ups** : chaque nouvelle alerte (kill earlyoom, fuite, fichiers en mémoire, pression) s'affiche en haut à droite de proc-watch et y reste jusqu'à « Fermer ». Au-delà de 3, un « + n autres » les regroupe (avec « Tout fermer »). L'onglet Métriques porte le nombre d'alertes non vues. Au premier lancement, les alertes déjà enregistrées ne s'affichent pas.
- **Notifications du bureau** : envoyées par le service d'enregistrement, donc même quand proc-watch est fermé, avec `notify-send` (paquet libnotify ; absent : pas de notification, sans erreur). Elles sont « critiques » (KDE les garde jusqu'au clic) et ont un bouton « Ouvrir » si `notify-send` connaît `--action` (libnotify ≥ 0.7.9). Pas de notification quand la fenêtre de proc-watch a le focus : le pop-up suffit. (la fenêtre signale son focus au service par un petit fichier, `$XDG_RUNTIME_DIR/proc-watch/focus-<empreinte>.json`, propre à chaque dossier de données ; périmé au bout de 10 s si l'app est fermée).
- **Réglages → Alertes** : pour chaque type, « Pop-up et bureau », « Pop-up seulement » ou « Rien » (par défaut : pression en pop-up seulement, le reste partout) ; au plus une notification du bureau par type toutes les 5 min (1 à 120).
- **« Ouvrir »** lance proc-watch, ou affiche la fenêtre déjà ouverte (instance unique), sur l'instant de l'alerte (`--alert=<id>`). Le service trouve l'app à partir de son propre emplacement : AppImage → le fichier AppImage ; paquet → le binaire installé ; clone du dépôt lancé avec `npm start` (`electron-vite preview`) → `electron <dossier du clone>` (la sortie `out/` doit être construite). L'app est lancée sous le même utilisateur, via `systemd-run --user` quand il existe (hors du service : redémarrer le service ne la ferme pas). Sinon, la notification part sans bouton.

### Règles automatiques

Réglages → Règles : le service d'enregistrement peut arrêter des processus **sans confirmation** selon des règles. Tout est éteint par défaut (interrupteur « Règles automatiques » : éteint, rien ne tourne, pas même les simulations).

- **Conditions** : un groupe ou une instance (par nom, comparé tel quel, ou par catégorie) au-dessus de X Go (RAM + swap) pendant Y min ; une instance de projet (front, back…) inactive depuis T (aucune mesure CPU ≥ 1 % ; sans historique couvrant toute la période, rien n'est arrêté) ; la prévision « Mémoire bientôt épuisée » qui annonce l'épuisement dans moins de N min (cible : le plus gros groupe qui grossit ; les applis seulement si tu les coches).
- **Simulation d'abord** : chaque nouvelle règle démarre en Simulation (journal « aurait arrêté… », aucun signal). Le passage en « Active » demande une confirmation ; une règle active dont la condition change repasse en Simulation. Trois modèles fournis, désactivés.
- **Action** : SIGTERM, puis SIGKILL 5 s plus tard aux seuls processus encore vivants avec la même identité (pid + heure de démarrage).
- **Garde-fous** (codés en dur, revérifiés juste avant chaque signal) : jamais Claude ni ce qu'il a lancé, les terminaux et les shells, le bureau (KWin, Plasma, X), systemd, D-Bus, PipeWire, earlyoom, proc-watch et ses parents, les programmes protégés, root ni les processus d'autres utilisateurs. Au plus 1 action par règle toutes les 5 min et 10 par heure en tout : au-delà, la règle se met en pause 1 h (notification).
- **Journal** : chaque action et chaque simulation est une alerte (Métriques → Alertes, pop-up, notification du bureau pour les actions) ; Réglages → Règles montre le dernier déclenchement et le nombre sur 7 jours. Une règle invalide écrite à la main dans `config.json` est ignorée seule, avec son erreur affichée.

## Va bien avec earlyoom

proc-watch ne tue jamais rien tout seul, sauf règles automatiques que tu as activées. Pour éviter qu'un manque de mémoire ne gèle la machine, installe [earlyoom](https://github.com/rfjakob/earlyoom). Si earlyoom manque ou est arrêté, proc-watch le signale au lancement et peut l'installer, le configurer et l'activer (Réglages › earlyoom), avec un seul mot de passe administrateur, après une confirmation qui montre le paquet, le gestionnaire et la ligne exacte. Le gestionnaire de paquets (pacman, apt-get, dnf ou zypper ; d'après `/etc/os-release` s'il y en a plusieurs) tourne sans questions et sans paquets recommandés ; apt-get ne supprime jamais rien (`--no-remove`). Attention : en mode non interactif, dnf importe automatiquement la clé GPG d'un dépôt qui la demande, et pacman importe une clé PGP inconnue (la confiance du trousseau reste exigée).

## Licence

MIT
