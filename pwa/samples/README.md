# Échantillons audio (General MIDI)

Ce dossier contient les échantillons joués par le moteur Web Audio natif de
Cantus (`src/audio.coffee`) : un fichier Ogg Vorbis par programme General MIDI
(`p000.ogg` à `p127.ogg`, plus `drums.ogg` pour le kit standard) et un
manifeste `manifest.json` qui décrit les zones.

Aucun calcul audio n'est fait en JavaScript : chaque note est un
`AudioBufferSourceNode` (hauteur par `playbackRate`, boucle par
`loopStart`/`loopEnd`) suivi d'un `GainNode` d'enveloppe. Le manifeste donne
pour chaque zone la tessiture (`keyLo`/`keyHi`), la couche de vélocité
(`velLo`/`velHi`), la hauteur d'origine (`root`) et l'accord fin (`tune`), les
offsets dans le fichier décodé (`offset`/`frames`), les points de boucle
(`loopStart`/`loopEnd`, absolus dans le fichier) et l'enveloppe de base
(`attack`, `hold`, `decay`, `sustain`, `release`, `gain`).

## Provenance

- Banque : MuseScore_General.sf2 0.2.0 (licence MIT)
- Source : <https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf2>
- sha256 : `ee51d2c4b1525e70f19a45909c4fd7a2e26d91d115fa89dbf5a6bc413d8b9bf3`
- Copyright © 2000-2002 Frank Wen (FluidR3), © 2014-2017 Michael Cowgill
  (FluidR3Mono), © 2018-2020 S. Christian Collins (MuseScore_General)
- La licence MIT est compatible avec la GPL-3.0-or-later de Cantus. Voir
  `THIRD-PARTY.md` pour les transformations et les notices complètes.

## Régénération

```sh
nix-shell -p python3 ffmpeg --run "python3 tools/build-samples.py"
```

Le script télécharge le SF2 (ou accepte `--source /chemin/MuseScore_General.sf2`),
vérifie son empreinte, extrait les zones utiles (zones globales SF2 comprises),
les rééchantillonne à 32 000 Hz, les encode en Ogg Vorbis et écrit le
manifeste. Il échoue si le décodage des Ogg ne
restitue pas le nombre d'échantillons attendu.

## Utilisation

- Build normal : copiés dans `dist/samples/`. Le service worker précache le
  manifeste, puis chaque Ogg à la demande (`cacheFirst`) ; le moteur ne
  télécharge et ne décode que les instruments présents dans la partition
  affichée, une seule fois par session.
- SPA : manifeste et fichiers inlinés en base64 dans `spa.html`, décodés
  paresseusement de la même manière.
- Si les échantillons sont absents ou illisibles, le moteur bascule sur
  l'oscillateur de repli sans bloquer la lecture.
