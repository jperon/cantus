# Campagne de tests de Cantus

Scripts Playwright (Chromium headless) qui exercent l'application construite
dans `dist/`, sans modifier `src/`, `pwa/` ni `build.js`.

## Prérequis

- `node_modules/` (le worktree peut pointer vers celui du dépôt principal :
  `ln -s ../cantus/node_modules node_modules`) ;
- le paquet scoretk dans `../musescore/result/classic` (ou `$SCORETK_PKG`) ;
- Chromium du système (`/run/current-system/sw/bin/chromium`).

## Données de test

Les fichiers sont centralisés dans `lib.js` (`FILES`) et lus depuis
`$CANTUS_TEST_DATA` (par défaut `~/.local/share/cantus/test-data`). Contenu
attendu (noms relatifs à ce répertoire) :

- `telemann/telemann-sonatas-for-two-recorders.xml` ;
- `bach/Magnificat_Bach.xml` ;
- `magnificat/` (les 12 mouvements `.mscz` et `.pdf`) ;
- `downloads/Magnificat_Bach.mxl` ;
- `downloads/Ave_Verum_Corpus_-_William_Byrd.mscz` ;
- `downloads/Cantique de Jean Racine - Fauré.mscz` ;
- `magnificat-bach/01- Magnificat.mscz` (partitions utilisées par s8 et s9).

`La_foule.mxl` est lu à la racine du dépôt (`ROOT`) et ignoré par git.

## Lancement

```sh
tests/run.sh              # construit dist/, lance les tests unitaires puis s1 à s9
tests/run.sh s1-import.js # un seul scénario navigateur
JOBS=4 tests/run.sh       # jusqu'à 4 scénarios navigateur en parallèle
JOBS=1 tests/run.sh       # exécution strictement série
node --test tests/unit/*.test.js  # tests unitaires seuls (sans navigateur)
```

`tests/run.sh` exécute d'abord les tests unitaires Node ; un échec interrompt
la campagne navigateur. Chaque script imprime une ligne par vérification
(`[OK]` / `[ÉCHEC]` avec le détail mesuré), puis un résumé JSON. Les délais
d'attente sont tous bornés. Chaque bilan de scénario affiche sa durée en
secondes, et le script termine par la durée des scénarios et la durée totale
de la campagne.

### Langue des scénarios

Les assertions portent sur les textes français. `tests/lib.js` force donc la
préférence de l'application (`localStorage`, clé `musica-language`) à `fr`
dans chaque contexte, via `forceLanguage(ctx)` appelé par `newPage`. Un
scénario n'a rien à faire ; un contexte créé à la main doit appeler
`L.forceLanguage(ctx)`. Pour vérifier la détection par le navigateur, passer
`language: null` à `L.newPage` et fournir un contexte à la locale voulue
(`s3-settings.js`, section langue).

### Parallélisme

Les scénarios navigateur sont indépendants : chacun ouvre son propre serveur
sur un port libre (`listen(0)` dans `lib.js`), donc plusieurs peuvent tourner
en même temps. `tests/run.sh` en lance `JOBS` à la fois (variable
d'environnement, défaut 3) ; chaque scénario écrit dans un journal temporaire
distinct et sa sortie est affichée d'un bloc à sa fin, jamais entrelacée avec
celle d'un autre. Les vérifications, les totaux et le code de sortie sont les
mêmes qu'en série.

Deux familles restent en série, un seul scénario à la fois et après le lot
parallèle :

- `s5-nopkg.js`, qui reconstruit `dist/` (sans puis avec le paquet scoretk) :
  il ne peut pas cohabiter avec un scénario qui sert ce même `dist/` ;
- les `s6*.js` (lecture audio), sensibles à la charge de la machine.

`JOBS=1` redonne une exécution strictement série. La durée d'un scénario
lancé en parallèle est plus longue qu'en série (les navigateurs se partagent
le processeur) : c'est la durée du lot qui diminue.

### Convention de code de sortie

- Un scénario navigateur **doit sortir en code non nul dès qu'une assertion
  échoue**. C'est `record()` de `lib.js` qui s'en charge : il compte les
  `ÉCHEC` et, à la fin du processus (`beforeExit`), positionne le code de
  sortie à 1 sans interrompre les `close()` en cours ni masquer un crash
  (une exception non gérée sort déjà en 1). Un nouveau scénario n'a donc rien
  à faire de particulier, sauf à utiliser `L.record(...)` pour ses assertions.
- `tests/run.sh` **agrège** : il renvoie 1 si au moins un scénario a échoué,
  et aussi si la sortie d'un scénario contient une ligne commençant par
  `[ÉCHEC]` ou `ERREUR GÉNÉRALE` (ceinture et bretelles si un scénario futur
  oublie la convention). Le motif est ancré en début de ligne : les résumés
  JSON et les tests négatifs attendus (marqués `[OK]`, par exemple le
  rechargement hors ligne sans service worker en s4) ne sont pas comptés.
- **Comptage des assertions** : une assertion = une ligne `[OK]`, `[ÉCHEC]`
  ou `[SAUTÉ]`. `lib.js` écrit à la sortie du processus une ligne
  `=== BILAN <script> : N assertion(s), F échec(s) ===` (écriture synchrone,
  insensible au vidage des tubes), et `tests/run.sh` la compare au nombre de
  lignes du journal : un écart rend la campagne rouge (« comptage
  incohérent »). Le compte par scénario est affiché à la fin de chaque
  script, et le total de la campagne en dernière ligne.
- Attention : le préfixe numérique des titres (`6. Erreurs JS ...`) est le
  numéro d'**exigence** de la spécification, pas celui du scénario ; compter
  les assertions par ce préfixe fausse la répartition (s1 à s5 contiennent
  des vérifications d'exigence 6). Compter par section `== sN ==` ou se fier
  au bilan affiché par `run.sh`.
- Les tests unitaires (`tests/unit/*.test.js`) sortent en 1 en cas d'échec et
  interrompent la campagne.
- Les scénarios `s6*` partagent `tests/s6-common.js` et fixent chacun un
  budget global (`budgetMs` dans l'appel à `main`) : un dépassement sort en
  code 1 en nommant le fichier, sans confondre une panne de temps avec un
  échec d'assertion.

## Tests unitaires

**Règle des fixtures** : tester les modules contre les fixtures réelles du
paquet (`tests/fixtures/scoretk/`), jamais contre des objets écrits à la main —
un contrat imaginé (`pauseBefore`, `from`/`to`/`offset`) ne prouve rien.

- `tests/unit/midi.test.js` — parseur SMF (`src/midi.coffee`).
- `tests/unit/audio.test.js` — logique audio pure : volumes, mapping des voix,
  répartition des pistes sur les canaux et programmes GM, ordonnancement,
  normalisation de `playbackData`.
- `tests/unit/audio-load.test.js` — chargement paresseux des échantillons
  (seuls les programmes de la partition, une seule fois), avec un faux
  `AudioContext` ; repli oscillateur si le manifeste ou un échantillon manque.
- `tests/unit/audio-schedule.test.js` — notes datées avec
  `start(when, offset, duration)`, hauteur par `playbackRate`, boucle et
  enveloppe sur les nœuds natifs, coupure immédiate (pause, seek, stop,
  transposition) sans purge différée.
- `tests/unit/playback.test.js` — résolution des marqueurs de synchronisation
  et suivi de page/système (`src/playback.coffee`).
- `tests/unit/timeline.test.js` — slices de mouvement, segments de lecture,
  pauses et marqueurs de synchronisation de la timeline pure
  (`src/timeline.coffee`, non encore branchée).
- `tests/unit/i18n.test.js` — interpolation, pluriel, replis et cohérence
  stricte des clés et des `{paramètres}` entre les dictionnaires.

## Sonde audio (moteur d'échantillons natif)

Pas de scénario dédié : la plomberie se vérifie dans la console de la page
construite.

- build normal : le manifeste est servi depuis `samples/manifest.json` et un
  Ogg par programme depuis `samples/` ; seuls les instruments de la partition
  sont téléchargés et décodés ;
- SPA : manifeste et échantillons sont inlinés dans
  `<script id="samples-manifest" type="application/json">` et
  `<script id="samples-data" type="application/json">`, décodés paresseusement.

Après lecture, `window.__musicaAudio.getEngineMode()` vaut `samples` (ou
`oscillator` en repli), `getChannelAssignments()` décrit les programmes
effectifs (diagnostic), `getLoadedSampleKeys()` liste les programmes décodés et
`getTimingStats()` donne le retard du fil principal au moment de confier
chaque note au graphe. Les instants de `start(when)` sont exacts par
construction. Si `pwa/samples/manifest.json` est absent, le build passe
(tolérance) et le moteur se rabat sur l'oscillateur.

## Mesure comparative des moteurs audio

`tests/bench-audio.js` compare deux builds (SpessaSynth de référence et moteur
d'échantillons courant) sur la même partition, Chromium headless, service
worker bloqué et CPU bridé ×6 : CPU par type de processus (CDP `SystemInfo`),
CPU du fil principal (`Performance.getMetrics`), mémoire JS, octets audio
téléchargés, temps de chargement et régularité des débuts. Il produit aussi un
WAV de 20 s par moteur.

```sh
CHROMIUM=/run/current-system/sw/bin/chromium env -u LD_LIBRARY_PATH \
  node tests/bench-audio.js --spessa /tmp/cantus-natif/spessa-dist \
  --samples dist --out /tmp/cantus-natif
```

`--spessa` désigne un `dist/` construit avant le remplacement (le build de
référence), `--samples` le build courant. Ce script n'est pas lancé par
`tests/run.sh`.

## Scénarios

- `s1-import.js` — import `.xml`, `.mxl`, `.mscz`, `.ly`, `.abc` et `.mid`
  seuls, navigation (flèches, tap), découpage en mouvements
  (`fixtures/movements.xml`), réouverture à la page mémorisée, boutons de
  navigation. `index.html` et `spa.html`.
- `s2-folder.js` — dossier Magnificat par bouton et par sélection multiple,
  entrée unique, premier affichage avant la fin des conversions, parcours des
  12 mouvements puis page par page, réouverture dans un mouvement tardif,
  suppression pendant le chargement de fond.
- `s3-settings.js` — tailles de voix (Telemann, Bach), régénération seulement
  à la fermeture, bouton « Toutes les voix à 100 % », voix masquée (fichier
  seul et dossier), ergonomie tactile des interrupteurs de voix à 360 px,
  zoom, défilement par page / système et recouvrement, tempo de lecture
  (défaut du fichier, unité et symbole affichés, réglage par fichier, retour au
  défaut, sans re-rendu SVG), transpositions visuelle et auditive (deux
  sélecteurs tactiles, valeurs de −12 à +12, persistance après rechargement,
  variante de cache SVG, application du rendu à la fermeture), choix
  d'instrument par voix et option « Piano seulement » (programmes GM effectifs,
  persistance), et langue (anglais par défaut, bascule au français,
  préférence conservée).
- `s4-offline.js` — installation du service worker, mise en cache des trois
  fichiers mscz2xml, rechargement et import `.mscz` avec `setOffline(true)`,
  puis lecture audio hors ligne (position qui progresse, échantillons précachés ou
  repli oscillateur). Diagnostique l'étape qui échoue au lieu d'attendre
  indéfiniment.
- `s5-nopkg.js` — build `MSCZ2XML_PKG=/nonexistent` (normal et `--spa`),
  refus propre d'un `.mscz`, puis reconstruction normale de `dist/`.
- `s6-common.js` — aides partagées par les scénarios s6 (bornes `WAIT`,
  attentes nommées, état du transport, cale de page, données de lecture du
  worker) et `main()`, qui déroule le scénario sur `index.html` puis
  `spa.html`. Chaque fichier s6 déclare un budget global (`budgetMs`) : au-delà,
  il sort en code 1 avec une ligne `ERREUR GÉNÉRALE budget dépassé : <fichier>`.
- `s6a-transport.js` — structure de la barre, lecture/pause/arrêt, raccourcis
  `p`/`s`, tempo de lecture (défaut affiché, 80 → 160 : durée divisée par
  deux et reprise à la position courante), transpositions (auditive +2 à
  chaud : hauteurs jouées décalées sans re-rendu ni données modifiées ;
  visuelle +2 : rendu transposé à la fermeture, son et données inchangés),
  suivi vertical par système et par page, volume général, volume par voix, et
  dissociation affichage / lecture d'une voix (masquée mais jouée, affichée
  mais coupée, persistance). `index.html` et `spa.html`.
- `s6b-suivi.js` — suivi horizontal (Fauré) : sauts avant/arrière sans page
  blanche, granularité en demi-pages, puis cale de la tête sur le premier
  marqueur de la page affichée. `index.html` et `spa.html`.
- `s6c-magnificat.js` — non-régression de la boucle de lecture sur le 1er
  mouvement réel du Magnificat de Bach : seeks bornés, position monotone,
  scroll périmé, pause stable, suivi désactivé. `index.html` et `spa.html`.
- `s6d-reprises.js` — reprises : marqueurs des deux passages, mode linéaire
  (« Dérouler les reprises » décoché) et bascule par l'interface. `index.html`
  et `spa.html`.
- `s6e-robustesse.js` — changement de fichier ou redimensionnement pendant la
  lecture, erreur de données de lecture, MIDI vide. `index.html` et
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
- `s10-horizontal.js` — disposition : en mode horizontal, une page rendue ne
  contient jamais deux systèmes (Byrd à 1200×800 et zoom 40, première page à
  un système, deuxième à deux dans l'ancienne mise en page), sur toutes les
  pages, après réouverture depuis les caches, puis après masquage d'une voix
  (le mode est redécidé au rechargement). Vérifie aussi le forçage
  « Vertical » sur ce fichier naturellement horizontal et le retour à « Auto »
  qui repasse en vertical quand un rechargement le justifie, enfin le retour à
  un fichier vertical. `index.html` et `spa.html`.

## Réglages de lecture

Le panneau Réglages expose :

- **Volume général** (0–100) : appliqué immédiatement et conservé dans
  `localStorage` (`musica-settings`).
- **Disposition** (Auto / Horizontal / Vertical) : « Auto » décide sur la
  première page de la mise en page naturelle (un système → horizontal avec un
  système par page, plusieurs → vertical) ; les deux autres imposent la mise
  en page. Réglage global conservé dans `musica-settings`, appliqué en
  rechargeant la partition (comme le zoom). Le mode est redécidé à chaque
  chargement, y compris après un changement de zoom, de voix ou de
  transposition.
- **Volume par voix** (10–100) : propre à chaque fichier, appliqué au
  `GainNode` de la voix sans re-rendu ; conservé avec les voix masquées ou
  coupées dans `musica-hidden-parts-<fileId>`.
- **Instrument par voix** : « Partition » (instrument GM d'origine) ou un des
  128 programmes GM, groupés par famille de huit. Propre à chaque fichier
  (`programs: {libellé: numéro}` dans `musica-hidden-parts-<fileId>`), appliqué
  à chaud par `programChange` ; aucune sélection pour une voix de batterie.
- **Piano seulement** : force le programme 0 sur toutes les voix mélodiques
  sans effacer les choix par voix ; réglage global conservé dans
  `musica-settings`. Les sélecteurs d'instrument sont alors désactivés.
- **Affichage et lecture d'une voix** (deux interrupteurs de 44 px par voix) :
  « affichée » ne concerne que le rendu (masquage, appliqué à la fermeture),
  « jouée » que l'audio (coupure, appliquée à chaud au `GainNode`). Les deux
  états sont indépendants et persistés séparément (`hidden` et `muted`) ; au
  moins une voix reste affichée, aucune contrainte sur les voix jouées.
- **Tempo de lecture** (20–300 dans l'unité de battue) : propre à chaque
  fichier, conservé dans `musica-tempo-<fileId>`. L'unité (blanche, noire,
  noire pointée…) vient de l'indication métronomique du fichier, sinon de sa
  métrique ; son symbole est affiché à côté du champ. La valeur stockée est
  celle de cette unité, sans compatibilité avec les anciennes valeurs en
  noires/minute. Défaut = tempo initial explicite du fichier, sinon 80 dans la
  même unité. Le bouton « Tempo du fichier » (ou un champ vidé) efface le
  réglage. Appliqué sans re-rendu SVG ; un changement pendant la lecture
  reprend à la même position musicale (voir BUILD.md, « Tempo de lecture »).
- **Suivre le défilement** : pendant la lecture, amène la page ou le système
  courant à l'écran (défaut activé, sans re-rendu).
- **Vider le cache** : purge les caches de rendu SVG et de données de lecture,
  sans toucher aux fichiers de la bibliothèque.

## Régénérer les échantillons audio

```sh
nix-shell -p python3 ffmpeg --run "python3 tools/build-samples.py"
```

Le script produit `pwa/samples/manifest.json` et un Ogg par programme (voir
`pwa/samples/README.md` et `THIRD-PARTY.md`).

## Notes

- Le cache persistant `musica-playback-cache-v8` stocke MIDI + `syncMarks` +
  tempo initial du fichier (valeur et unité de battue) + position et durée du
  mouvement dans la source, compressés, avec une clé
  fichier/mouvement/largeur/hauteur/échelle/variante de voix et de mise en
  page (un système par page en mode horizontal, mise en page naturelle
  sinon). Les données sont à l'échelle du fichier : le réglage Tempo ne les
  invalide pas (le facteur est appliqué à la lecture). Les v3 et v4 ne sont
  jamais resservies (la première n'a pas le tempo, la seconde l'exprime en
  noires/minute) ; les v5 non plus
  (une variante avec une voix groupée masquée pouvait n'avoir aucun marqueur),
  ni les v6 (segments calés sur le début du mouvement : un mouvement autre que
  le premier jouait les notes du début du fichier), ni les v7 (la pagination
  horizontale impose désormais un système par page : leurs marqueurs visaient
  l'ancienne pagination).
  Le cache est préservé par le service worker aux mises à jour et purgé par
  « Vider le cache ».
- Les voix coupées (`muted`) n'entrent dans aucune clé de cache, ni SVG ni
  lecture : elles ne changent que le gain du moteur. Le masquage (`hidden`)
  reste dans la variante du rendu et, via le XML élagué du worker, dans celle
  de la lecture (la pagination déplace les marqueurs de synchronisation).
- `s4` enregistre le service worker manuellement lorsque l'application ne le
  fait pas, afin de distinguer un défaut d'enregistrement d'un défaut de
  cache. Le détail du diagnostic est dans le résumé JSON.
- Les chemins des fichiers de test sont centralisés dans `lib.js` (`FILES`).
- `s5` reconstruit `dist/` à la fin ; ne pas l'interrompre pendant cette
  restauration.
