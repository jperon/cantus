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
(Bach) à partir de la première note (67,875 s), suivi visuel désactivé, même
partition pour les deux moteurs. CPU par type de processus via CDP
`SystemInfo` (agrège navigateur, rendus — dont l'AudioWorklet — et service
audio), fil principal via `Performance.getMetrics`.

| moteur | CPU lecture (s) | CPU à l'arrêt (s) | CPU net (s) | CPU fil principal (s) | heap JS (Mo) | chargement (ms) | audio (Ko) | notes | retard max (ms) | dispersion débuts (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| SpessaSynth | 24,99 | 8,90 | 16,09 | 18,14 | 8,0 | 1307 | 2749 | 237 | 39,23 | — |
| Échantillons | 22,54 | 7,92 | 14,62 | 14,70 | 5,5 | 1488 | 398 | 243 | 0,00 | 0,000 |

Le CPU total baisse d'environ 10 % et le fil principal de 19 % sur ce
desktop ; les mesures varient de ±10 % selon les runs. Le protocole CDP ne
bride que le fil principal du rendu, pas le fil audio : sur un téléphone ou
une liseuse, dont le fil audio est bien plus lent, la suppression de la
synthèse JS pèse davantage. Les gains certains et reproductibles sont :

- téléchargement audio divisé par 6,9 (2749 → 398 Ko pour cette partition) ;
- mémoire JS réduite (8,0 → 5,5 Mo), banque décodée uniquement pour les
  instruments joués ;
- régularité : débuts exacts par construction (`start(when)`), dispersion
  mesurée sur 243 notes = 0,000 ms, aucun retard du fil principal sur ce run,
  contre 39,2 ms de gigue maximale pour le worklet SpessaSynth.

Rendus d'écoute (20 s, même segment, 48 kHz mono) :

- `/tmp/cantus-natif/spessasynth-20s.wav` (SpessaSynth)
- `/tmp/cantus-natif/samples-20s.wav` (échantillons)

Niveaux comparables : moyenne −35,7 dB / −34,3 dB, crête −19,6 dB / −20,2 dB ;
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
