# Moteur audio natif (échantillons Web Audio)

Branche `audio-natif`. Remplacement de SpessaSynth (synthèse JS dans un
AudioWorklet) par la lecture d'échantillons avec les nœuds natifs
`AudioBufferSourceNode` + `GainNode`.

## Livrables

- `tools/build-samples.py` : extraction reproductible de
  MuseScore_General.sf2 0.2.0 (MIT, empreinte vérifiée) vers
  `pwa/samples/` : 129 programmes (1244 zones), un Ogg Vorbis par programme,
  manifeste JSON. Zones globales SF2, points de boucle et enveloppe de base
  pris en compte.
- `src/audio.coffee` : moteur natif ; plus aucun calcul audio en JS. Hauteur
  par `playbackRate`, boucle par `loopStart`/`loopEnd`, attaque/relâchement
  par automation du gain, `start(when, offset, duration)`. Chargement
  paresseux (manifeste + instruments de la partition seulement). Arrêt
  immédiat (fondu 8 ms) sans purge différée.
- `pwa/samples/` : 10 Mo d'Ogg, manifeste 298 Ko ; seuls les instruments
  utilisés sont téléchargés et décodés (ex. 398 Ko pour le Magnificat).
- SpessaSynth retiré : dépendance npm, bundle, worklet, SF3, code mort,
  entrées du service worker, crédits et documentation.

## Mesures comparatives

Protocole : Chromium headless, service worker bloqué, CPU bridé ×6
(`Emulation.setCPUThrottlingRate`), 20 s du premier mouvement du Magnificat
(Bach) dans sa fenêtre la plus dense (départ 79,125 s, 307 notes), suivi
visuel désactivé, même segment pour les deux moteurs. CPU par type de
processus via CDP `SystemInfo` (agrège navigateur, rendus — dont l'AudioWorklet
— et service audio), fil principal via `Performance.getMetrics`. Médianes de
trois runs ; les valeurs varient de ±10 % environ.

| moteur | CPU lecture (s) | CPU à l'arrêt (s) | CPU net (s) | CPU fil principal (s) | heap JS (Mo) | chargement (ms) | audio (Ko) | notes | retard max (ms) | dispersion débuts (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| SpessaSynth | 22,49 | 8,04 | 14,37 | 18,07 | 6,3 | 1610 | 2749 | 300 | 65,6 | — |
| Échantillons | 22,06 | 8,27 | 14,25 | 18,33 | 5,7 | 1584 | 398 | 300 | 0,00 | 0,000 |

Sur ce desktop, le CPU est donc **sensiblement le même** : le protocole CDP ne
ralentit que le fil principal du rendu, pas le fil audio, et la synthèse de
quatre voix par SpessaSynth est peu coûteuse pour un processeur de bureau. Le
gain attendu sur téléphone ou liseuse vient de la suppression de cette
synthèse du fil audio (et de la gigue qu'elle entraîne), gain que ce banc ne
peut pas simuler fidèlement. Les résultats reproductibles sont :

- téléchargement audio divisé par 6,9 (2749 → 398 Ko pour cette partition) ;
- mémoire JS réduite (médiane 6,3 → 5,7 Mo ; 8,0 → 5,5 Mo sur les runs à la
  première note) ;
- régularité : débuts exacts par construction (`start(when)`), dispersion
  mesurée sur 300 notes = 0,000 ms, aucun retard du fil principal, contre
  65,6 ms de gigue maximale pour le worklet SpessaSynth (médiane) ;
- temps de chargement comparable (≈1,6 s bridé ×6 pour les deux).

Rendus d'écoute (20 s, même segment, 48 kHz mono) :

- `/tmp/cantus-natif/spessasynth-20s.wav` (SpessaSynth)
- `/tmp/cantus-natif/samples-20s.wav` (échantillons)

Niveaux comparables : moyenne −34,1 dB / −33,1 dB, crête −19,6 dB / −19,1 dB ;
aucun silence > 0,3 s dans les deux rendus.

## Vérifications

- `node build.js` et `node build.js --spa` : OK (SPA 23 Mo, échantillons
  inlinés).
- Tests unitaires : `tests/unit/*.test.js`, tous OK (dont 40 tests audio purs,
  chargement paresseux, ordonnancement, arrêt immédiat).
- Campagne : `tests/run.sh s6a-transport.js s6b-suivi.js s6c-magnificat.js
  s6d-reprises.js s8-boucle.js s9-synchro.js s4-offline.js` → 175/175
  assertions OK.
- `tests/bench-audio.js` : mesure et rendus WAV reproductibles.
