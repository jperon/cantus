# TODO — Cantus

Reste à faire uniquement. Pour l'architecture et les décisions déjà prises, voir
`ROADMAP.md` et `BUILD.md`.

## Bugs connus

### Course au démarrage du worker

- **Symptôme** : importer une partition avant que le worker Verovio soit prêt
  provoque « Source 0 inconnue dans le worker » (reproduit avec `La_foule.mxl`
  sans attendre `ready`).
- **Piste** : le worker possède déjà une file `pending` rejouée après `ready`
  (`worker.coffee`), mais l'ordre y fait foi : un `clearMovements` arrivé après
  le `load` efface la source que le `load` vient d'enregistrer. Soit ignorer un
  `clearMovements` visant une source inconnue, soit numéroter les messages et
  n'appliquer un effacement que si son `load` le précède.

### Lenteur anormale de `s6-audio.js`

- **Symptôme** : étirements et timeouts de 60 s en cascade. Le scénario est
  redevenu rapide après réparation de l'audio, sans que la cause des étirements
  soit élucidée.
- **Piste** : borner explicitement les attentes, isoler les scénarios longs pour
  que chacun ait son propre budget de temps.

## Chantiers

### Import de tous les formats gérés par scoretk

- **Objectif** : accepter `.ly`, `.abc`, `.mid`/`.midi` en plus de `.musicxml`,
  `.mxl`, `.mscz`, `.mscx`.
- **Piste** : étendre `isCompatibleFile` (`src/app.coffee`) et l'attribut
  `accept` des quatre inputs `.pug` (`src/index.pug`, `src/spa.pug`), puis la
  liste MIME du `share_target` (`pwa/manifest.json` et `apk/twa-manifest.json`).
- **Attention** : un `.mid` ne porte pas de notation ; la conversion produit une
  transcription. Le dire dans l'interface.

### Export vers tous les formats

- **Objectif** : exporter au format choisi via `formats()` de scoretk, sans coder
  la liste en dur.
- **Questions ouvertes** : emplacement de l'entrée d'export (réglages ou
  bibliothèque) ; fichier téléchargeable ou partage Android.

### Installation/distribution Android

- **`apk/twa-manifest.json`** doit être régénéré quand le manifeste web change
  (types MIME du partage).
- L'APK n'est pas versionné (`apk/` est ignoré) et la signature dépend de
  `~/.config/cantus/apk.env` et des variables `BUBBLEWRAP_*`/`CANTUS_*`.

## Dette technique

### Tests unitaires contre des contrats imaginaires

- Deux cas rencontrés : `pauseBefore`, puis `from`/`to`/`offset`.
- **Règle** : tester les modules contre les fixtures réelles du paquet
  (`tests/fixtures/scoretk/`), jamais contre des objets écrits à la main.

### Champs annoncés absents

- scoretk ne fournit ni `durationUs`, ni `pauseBefore`, ni `ordinal` distinct de
  `measure` ; `passage` n'est pas un discriminant d'occurrence.
- Ces conventions sont documentées dans `BUILD.md` (section « Aperçu audio et
  synchronisation ») : vérifier qu'elles y restent à chaque évolution de scoretk.

### Limites assumées de scoretk

- Fermatas et respirations non modélisées.
- Trémolo à deux accords : seule la première note pilote les deux attaques
  (parité MuseScore).

### Branche `midi`

- Obsolète : 19 commits de retard sur `master`, 0 commit propre — à supprimer
  localement et sur `origin`.

### Worktrees résiduels

- `cantus-wt-*` (à côté du dépôt) et `/tmp/cantus-loop`, `/tmp/cantus-old` : à
  nettoyer (`git worktree remove`, `--force` seulement si le seul non-suivi est
  `node_modules`).

## Industrialisation

### Flake Nix non hermétique

- Le build du site lit `../partitura` et `../musescore/result` hors dépôt
  (`BUILD.md`, « Dépendances externes du build »).
- **Piste** : dériver `verovio-toolkit-wasm.js` et le paquet scoretk comme
  entrées Nix.

### `tests/run.sh` dépendant du devShell ambiant

- Le script invoque encore `nix-shell -p nodejs` en interne alors qu'on le lance
  depuis le devShell du flake, et le chemin de scratch `SCRATCH` est codé en dur.
- À remplacer par `$NODE`/`command -v node` et un répertoire temporaire produit
  par `mktemp -d`.

### Service Worker à mettre à jour à chaque bump

- `pwa/sw.coffee` conserve une liste `PRESERVED_CACHES` à tenir à jour :
  `musica-structure-cache-v1`, `musica-svg-cache-v2`,
  `musica-playback-cache-v3`, et le préfixe `musica-static-`.

## Vérifications de référence

Campagne : `nix develop -c bash -lc 'tests/run.sh'` (s1→s9 + unitaires) ; le harnais échoue si une assertion échoue.
