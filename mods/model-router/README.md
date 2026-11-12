# model-router

Mod Claude Code qui choisit **automatiquement le modèle et le niveau d'effort** de chaque tour
d'après le message envoyé. La classification est locale et instantanée (règles et mots-clés),
sans appel de modèle supplémentaire.

| Niveau   | Exemples                                             | Par défaut      |
|----------|------------------------------------------------------|-----------------|
| simple   | question courte, reformulation, commande git triviale | haiku · low     |
| standard | fonction, explication de code, édition localisée     | sonnet · medium |
| complex  | refactor multi-fichiers, debug, migration, audit     | opus · high     |
| critical | gros chantier, ambigu, fort enjeu, planification     | opus · max      |

## Fonctionnement

- `prompt.submit` : le message est classé (`hooks/classify.ts`), la décision est retenue.
- `turn.step` : chaque requête modèle **du fil principal** est envoyée avec ce modèle et cet effort
  (les sous-agents gardent le leur). Votre réglage `/model` n'est pas modifié.
- Escalade d'un cran si vous corrigez (« non… », « ça ne marche toujours pas »), répétez une demande,
  avez interrompu le tour précédent, ou si celui-ci a eu des erreurs d'outils. Redescend dès que la demande redevient simple.
- En cas d'erreur, aucune réécriture : le tour part avec votre réglage actuel.

## Commandes

```
/router on | off            activer / couper le routage
/router lock opus max       forcer un modèle + effort jusqu'à /router unlock
/router lock complex        forcer le réglage d'un niveau
/router unlock
/router status              dernier choix et sa raison
/router stats [jours]       répartition des choix (journal)
/router config              chemins de la config et du journal
```

Préfixes pour un seul tour : `!fast` / `!simple`, `!std`, `!deep` / `!complex`, `!max` / `!critical`
(le préfixe est retiré du message).

## Configuration

Au premier lancement, `config.json` est copié dans `~/.claude/model-router/config.json`.
Modifiez-y les modèles par niveau (alias `haiku`/`sonnet`/`opus` ou un identifiant complet),
les mots-clés, poids et seuils. Le fichier est relu à chaque message. Seules les clés présentes
remplacent les valeurs par défaut ; une liste remplace la liste entière.

Journal : `~/.claude/model-router/decisions.jsonl` (une ligne JSON par décision, 5000 max).

## Installation

- Session courante : le mod est chargé à la fin du tour une fois les mods activés.
- Sur votre machine : copiez ce dossier puis `claude --plugin-dir /chemin/vers/model-router`,
  ou ajoutez le chemin à `CLAUDE_CODE_PLUGIN_DIRS` dans le bloc `env` de `~/.claude/settings.json`.

## Limites

- Changer de modèle d'un tour à l'autre invalide le cache de prompt : le premier tour sur un
  nouveau modèle relit toute la conversation (plus lent, plus cher sur les longues sessions).
- L'effort est ramené par le moteur aux niveaux que le modèle et votre organisation permettent.
- La barre de statut montre le choix du routeur ; `/model` continue d'afficher le réglage de la session.

Tests : `claude plugin test .`
