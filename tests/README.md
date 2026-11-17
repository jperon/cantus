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
tests/run.sh              # construit dist/, lance les tests unitaires puis s1 à s7
tests/run.sh s1-import.js # un seul scénario navigateur
node --test tests/unit/*.test.js  # tests unitaires seuls (sans navigateur)
```

`tests/run.sh` exécute d'abord les tests unitaires Node ; un échec interrompt
la campagne navigateur. Chaque script imprime une ligne par vérification
(`[OK]` / `[ÉCHEC]` avec le détail mesuré), puis un résumé JSON. Les délais
d'attente sont tous bornés.

## Tests unitaires

- `tests/unit/midi.test.js` — parseur SMF (`src/midi.coffee`).
- `tests/unit/audio.test.js` — logique audio pure : volumes, mapping des voix,
  ordonnancement, normalisation de `playbackData`.
- `tests/unit/audio-load.test.js` — chargement du soundfont une seule fois,
  mesuré avec un faux `AudioContext` pour 1 et 3 pistes.
- `tests/unit/playback.test.js` — résolution des marqueurs de synchronisation
  et suivi de page/système (`src/playback.coffee`).

## Sonde audio (aperçu soundfont)

Pas de scénario dédié : la plomberie se vérifie dans la console de la page
construite.

- build normal : `typeof window.Soundfont` vaut `function` (UMD inliné) et,
  après chargement différé, `window.MIDI.Soundfont.acoustic_grand_piano`
  contient 13 notes (`C2`…`C6`), servies depuis `soundfonts/` ;
- SPA : les mêmes globals sont définis, l'asset étant inliné dans
  `<script id="soundfont-src" type="text/plain">` puis évalué avant
  `app.js`.

Si `pwa/soundfonts/piano-fluidr3-13notes.js` est absent, le build passe
(tolérance) et ces globals ne sont simplement pas définis.

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
  fichiers mscz2xml, rechargement et import `.mscz` avec `setOffline(true)`,
  puis lecture audio hors ligne (position qui progresse, soundfont précaché ou
  repli oscillateur). Diagnostique l'étape qui échoue au lieu d'attendre
  indéfiniment.
- `s5-nopkg.js` — build `MSCZ2XML_PKG=/nonexistent` (normal et `--spa`),
  refus propre d'un `.mscz`, puis reconstruction normale de `dist/`.
- `s6-audio.js` — transport, suivi du défilement (page/système, horizontal),
  volume général et par voix, persistance, puis robustesse : changement de
  fichier ou redimensionnement pendant la lecture, erreur de données de
  lecture, MIDI vide, voix mémorisée absente du MIDI. `index.html` et
  `spa.html`.
- `s7-share.js` — partage Android (`share_target` POST multipart). Le test
  envoie depuis la page un `fetch('share', { method: 'POST', body: FormData })`
  avec un `File`, exactement comme le navigateur Android ; le service worker
  actif l'intercepte, stocke le fichier dans IndexedDB et redirige vers
  `?shared=<jeton>`. Couvre : `.musicxml` valide (partition ouverte, nom
  conservé), `.mscz` annoncé en `application/octet-stream` si le fichier de
  test est présent (sinon cas sauté), fichier incompatible refusé proprement,
  jeton consommé et retiré de l'URL (rechargement sans réimport), non-régression
  du protocole `web+musicxml` (`?file=`), et manifeste servi en POST
  multipart. `index.html` et `spa.html` (le `.mscz` seulement sur
  `index.html`).

## Réglages de lecture

Le panneau Réglages expose :

- **Volume général** (0–100) : appliqué immédiatement et conservé dans
  `localStorage` (`musica-settings`).
- **Volume par voix** (10–100) : propre à chaque fichier, appliqué au
  `GainNode` de la voix sans re-rendu ; conservé avec les voix masquées dans
  `musica-hidden-parts-<fileId>`.
- **Suivre le défilement** : pendant la lecture, amène la page ou le système
  courant à l'écran (défaut activé, sans re-rendu).
- **Vider le cache** : purge les caches de rendu SVG et de données de lecture,
  sans toucher aux fichiers de la bibliothèque.

## Régénérer les échantillons audio

```sh
curl -sS -o /tmp/piano-mp3.js \
  https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/FluidR3_GM/acoustic_grand_piano-mp3.js
node tools/build-soundfont-subset.js /tmp/piano-mp3.js \
  pwa/soundfonts/piano-fluidr3-13notes.js
```

## Notes

- Le cache persistant `musica-playback-cache-v1` stocke MIDI + `syncMarks`
  compressés, avec une clé fichier/mouvement/largeur/hauteur/échelle/variante
  de voix. Il est préservé par le service worker aux mises à jour et purgé par
  « Vider le cache ».
- `s4` enregistre le service worker manuellement lorsque l'application ne le
  fait pas, afin de distinguer un défaut d'enregistrement d'un défaut de
  cache. Le détail du diagnostic est dans le résumé JSON.
- Les chemins des fichiers de test sont centralisés dans `lib.js` (`FILES`).
- `s5` reconstruit `dist/` à la fin ; ne pas l'interrompre pendant cette
  restauration.
