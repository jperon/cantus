# Composants tiers

Cantus est distribué sous licence GNU GPL v3 ou ultérieure (voir `LICENSE`).
Il intègre les composants tiers suivants, qui conservent leurs propres
licences.

## Verovio

- Licence : GNU LGPL v3 ou ultérieure (LGPL-3.0-or-later)
- Source : <https://github.com/rism-digital/verovio>

Verovio est le moteur de gravure musicale utilisé pour afficher les
partitions SVG. Le paquet distribué avec l'application
(`verovio-toolkit-wasm.js`) inclut les polices SMuFL suivantes :

- Bravura
- Gootville
- Leipzig
- Leland
- Petaluma

Ces polices sont distribuées sous SIL Open Font License 1.1.

## Police de texte Cantus Serif

- Licence : SIL Open Font License 1.1 (voir `pwa/fonts/OFL.txt`)
- Source : Liberation Serif 2.1.5, <https://github.com/liberationfonts/liberation-fonts>
- Copyright © 2012 Red Hat, Inc., avec le nom réservé « Liberation »

Cantus Serif est une version sous-ensemble de Liberation Serif, renommée
conformément à la clause de nom réservé de l'OFL (le nom « Liberation » ne
peut pas être réutilisé pour une version modifiée). Elle est embarquée dans
`pwa/fonts/CantusSerif-Regular.woff` puis inlinée en data URI dans le CSS par
`build.js`. Verovio calcule l'espacement des paroles avec les métriques de
Times ; cette police métriquement compatible évite que la police de repli
d'Android (Noto Serif, plus large) ne fasse chevaucher les syllabes.

## exsurge

- Licence : MIT (le paquet déclare aussi OFL-1.1 pour ses glyphes NABC, que
  Cantus n'utilise pas)
- Copyright © 2019 Benjamin Bloomfield
- Source : <https://github.com/bbloomf/exsurge>

exsurge grave la notation grégorienne carrée à partir des fichiers GABC
(`dist/exsurge.min.js` dans la PWA, inliné dans `spa.html`). Il n'est chargé
qu'à l'ouverture d'un `.gabc`.

```text
MIT License

Copyright (c) 2019 Benjamin Bloomfield

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## fflate

- Licence : MIT
- Copyright © 2023 Arjun Barrett
- Source : <https://github.com/101arrowz/fflate>

fflate est utilisé pour décompresser les fichiers `.mxl`.

```text
MIT License

Copyright (c) 2023 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## MuseScore_General (banque General MIDI)

- Licence : MIT (voir `pwa/samples/README.md` pour les notices d'origine)
- Copyright © 2000-2002 Frank Wen (FluidR3), © 2014-2017 Michael Cowgill
  (FluidR3Mono), © 2018-2020 S. Christian Collins (MuseScore_General)
- Source : <https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/>
  - `MuseScore_General.sf2` version 0.2.0, 215 614 036 octets
  - sha256 : `ee51d2c4b1525e70f19a45909c4fd7a2e26d91d115fa89dbf5a6bc413d8b9bf3`
- Utilisée par : `tools/build-samples.py`, qui en extrait les échantillons
  joués par le moteur Web Audio natif (`src/audio.coffee`).

MuseScore_General est partagée sous licence MIT, comme FluidR3Mono et FluidR3
avant elle. Cette licence est compatible avec la GPL-3.0-or-later de Cantus,
contrairement à l'ancienne banque TimGM6mb (GPL-2.0-only) qui n'est plus
distribuée.

Le script produit `pwa/samples/manifest.json` et un fichier Ogg Vorbis par
programme GM (129 fichiers, batterie comprise). Transformations appliquées :

- une zone de clavier toutes les 12 touches par couche de vélocité, tessiture
  élargie pour couvrir le même ambitus ; au plus deux couches de vélocité par
  programme (la plus large, puis celle qui couvre la vélocité 90) ;
- batterie : une zone par touche, sans réduction de tessiture ;
- échantillons non bouclés tronqués à 3 s avec fondu de sortie de 50 ms ;
  échantillons bouclés limités à la boucle + 0,25 s ;
- rééchantillonnage à 32 000 Hz, points de boucle recalés sur un passage par
  zéro à ±5 ms ;
- encodage Ogg Vorbis mono qualité 0, contenu par programme concaténé (le
  manifeste donne l'offset de chaque zone).

Régénération (le script télécharge et vérifie l'empreinte du SF2) :

```sh
nix-shell -p python3 ffmpeg --run "python3 tools/build-samples.py"
```

## scoretk

- Licence : GNU GPL v3 seulement (GPL-3.0-only)
- Source : <https://github.com/jperon/scoretk>

scoretk est un portage du code de MuseScore Studio, Copyright © MuseScore
Limited and others, distribué sous GNU GPL v3 seulement (GPL-3.0-only). Il
n'est chargé que lors de l'import d'un fichier `.mscz`, `.mscx`, `.ly`,
`.lilypond`, `.abc`, `.mid` ou `.midi`.

## De âlde Friezen (fixture d'import de dossier LilyPond)

- Licence : CC0 1.0 Universal (texte complet dans
  `tests/fixtures/alde-friezen/LICENSE`)
- Source : <https://github.com/MacLotsen/alde-friezen>, commit
  `bba32e7492d2bfe581b15b5d82179db132937702` (preuve : `LICENSE:1` et
  `README.md:68-71` du dépôt amont)
- Fichiers : `tests/fixtures/alde-friezen/{partituer.ly,fideo.ly,noaten.ily}`
- Texte : Eeltsje Halbertsma / Jacobus van Loon (1876) ; mélodie : Heinrich
  Christian Schnoor ; mise en page : Erik Nijenhuis, 2026.

Ces trois fichiers (deux `.ly` qui partagent le même `noaten.ily`) servent de
fixture au scénario `tests/s13-ly-includes.js` : ils vérifient qu'un dossier
LilyPond à fichiers interdépendants donne deux pièces jouables. Aucun
 Makefile amont n'est exécuté.

---

La combinaison distribuée est soumise à la GNU GPL v3. Les sources de Cantus
sont disponibles à l'adresse <https://github.com/jperon/cantus>.
