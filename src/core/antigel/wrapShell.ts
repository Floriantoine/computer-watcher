// Anti-gel : snippet zsh de `computer-watcher shell-init zsh` (pur, texte seul).
//
// Widget sur accept-line : à Entrée, si la ligne contient un nom de commande lourde (préfiltre en zsh, sans processus),
// `computer-watcher should-wrap` décide et rend la ligne réécrite ; BUFFER est alors remplacé par
// `computer-watcher run -- …`. L'historique garde la ligne tapée (zshaddhistory). Tout échec (outil absent, erreur,
// délai de 2 s) laisse la ligne intacte. Le widget précédent (accept-line d'origine ou d'un greffon) est toujours appelé.
import { HEAVY_NAMES } from './wrap';

export const SHELL_INIT_USAGE = `Usage : computer-watcher shell-init zsh

Imprime le code zsh qui lance les commandes lourdes (jest, vitest, tsc, npm test…) directement dans le budget
anti-gel de leur projet. À ajouter à la fin de ~/.zshrc :

  (( \${+commands[computer-watcher]} )) && eval "$(computer-watcher shell-init zsh)"

Désactiver pour une session : export CWATCH_NO_WRAP=1
`;

export function zshInit(): string {
  const pattern = HEAVY_NAMES.join('|');
  return `# Computer Watcher (anti-gel) : les commandes lourdes démarrent directement dans le budget de leur projet.
# Installé par : eval "$(computer-watcher shell-init zsh)". Désactiver : export CWATCH_NO_WRAP=1
if [[ -o interactive ]] && (( ! \${+functions[_cwatch_wrap_accept_line]} )); then
  typeset -g _cwatch_wrap_orig='' _cwatch_wrap_new=''
  _cwatch_wrap_accept_line() {
    _cwatch_wrap_orig='' _cwatch_wrap_new=''
    if [[ \${CWATCH_NO_WRAP-} != 1 && $BUFFER == *(${pattern})* ]] && (( \${+commands[computer-watcher]} )); then
      local _cwatch_out _cwatch_to=()
      (( \${+commands[timeout]} )) && _cwatch_to=(timeout 2)
      _cwatch_out="$(command "\${_cwatch_to[@]}" computer-watcher should-wrap --shell zsh -- "$BUFFER" 2>/dev/null </dev/null)"
      if (( $? == 0 )) && [[ -n $_cwatch_out && $_cwatch_out != "$BUFFER" ]]; then
        _cwatch_wrap_orig=$BUFFER _cwatch_wrap_new=$_cwatch_out
        BUFFER=$_cwatch_out
      fi
    fi
    zle _cwatch_wrap_prev_accept_line -- "$@"
  }
  _cwatch_wrap_history() {
    # la ligne réécrite n'entre pas dans l'historique : la ligne tapée à sa place
    if [[ -n $_cwatch_wrap_new && "\${1%%$'\\n'}" == "\${_cwatch_wrap_new%%$'\\n'}" ]]; then
      print -sr -- "\${_cwatch_wrap_orig%%$'\\n'}"
      _cwatch_wrap_orig='' _cwatch_wrap_new=''
      return 1
    fi
    return 0
  }
  zle -A accept-line _cwatch_wrap_prev_accept_line
  zle -N accept-line _cwatch_wrap_accept_line
  autoload -Uz add-zsh-hook
  add-zsh-hook zshaddhistory _cwatch_wrap_history
fi
`;
}
