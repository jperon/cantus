# Campagne de tests de Cantus

Scripts Playwright (Chromium headless) qui exercent l'application construite
dans `dist/`, sans modifier `src/`, `pwa/` ni `build.js`.

## Prérequis

- `node_modules/` (le worktree peut pointer vers celui du dépôt principal :
  `ln -s ../../cantus/node_modules node_modules`) ;
- le paquet mscz2xml dans `../musescore/result-wasm/classic` ;
- Chromium du système (`/run/current-system/sw/bin/chromium`).

## Lancement

```sh
tests/run.sh              # construit dist/ puis exécute s1 à s5
tests/run.sh s1-import.js # un seul scénario
```

Chaque script imprime une ligne par vérification (`[OK]` / `[ÉCHEC]` avec le
détail mesuré), puis un résumé JSON. Les délais d'attente sont tous bornés.

## Scénarios

- `s1-import.js` — import `.xml`, `.mxl`, `.mscz` seuls, navigation
  (flèches, tap), découpage en mouvements (`fixtures/movements.musicxml`),
  réouverture à la page mémorisée, boutons de navigation. `index.html` et
  `spa.html`.
- `s2-folder.js` — dossier Magnificat par bouton et par sélection multiple,
  entrée unique, premier affichage avant la fin des conversions, parcours des
  12 mouvements puis page par page, réouverture dans un mouvement tardif,
  suppression pendant le chargement de fond.
- `s3-settings.js` — tailles de voix (Telemann, Bach), régénération seulement
  à la fermeture, bouton « Toutes les voix à 100 % », voix masquée (fichier
  seul et dossier), zoom, défilement par page / système et recouvrement.
- `s4-offline.js` — installation du service worker, mise en cache des trois
  fichiers mscz2xml, rechargement et import `.mscz` avec `setOffline(true)`.
  Diagnostique l'étape qui échoue au lieu d'attendre indéfiniment.
- `s5-nopkg.js` — build `MSCZ2XML_PKG=/nonexistent` (normal et `--spa`),
  refus propre d'un `.mscz`, puis reconstruction normale de `dist/`.

## Notes

- `s4` enregistre le service worker manuellement lorsque l'application ne le
  fait pas, afin de distinguer un défaut d'enregistrement d'un défaut de
  cache. Le détail du diagnostic est dans le résumé JSON.
- Les chemins des fichiers de test sont centralisés dans `lib.js` (`FILES`).
- `s5` reconstruit `dist/` à la fin ; ne pas l'interrompre pendant cette
  restauration.
