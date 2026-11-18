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

## soundfont-player

- Licence : MIT
- Copyright © 2015 Daniel Gómez Blasco <danigb@gmail.com>
- Source : <https://github.com/danigb/soundfont-player>

soundfont-player est utilisé pour charger et jouer les échantillons du
soundfont. Le fichier distribué (`soundfont-player.min.js`) embarque ses
dépendances : `audio-loader`, `sample-player`, `note-parser` (MIT),
`adsr` (ISC) et `midimessage` (MIT).

```text
The MIT License

Copyright (c) 2015 Daniel Gómez Blasco <danigb@gmail.com>

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

## Échantillons FluidR3_GM (piano)

- Licence : Creative Commons Attribution 3.0 Unported (CC-BY 3.0)
- Source : <https://github.com/gleitz/midi-js-soundfonts> (branche `gh-pages`,
  fichier `FluidR3_GM/acoustic_grand_piano-mp3.js`)
- Échantillons FluidR3 par Frank Wen, rendu MIDI.js par Benjamin Gleitzman
- Texte de la licence : <https://creativecommons.org/licenses/by/3.0/>

Cantus distribue un sous-ensemble de 13 notes (`C2` à `C6`, une tous les
4 demi-tons) sous forme de données audio encodées en base64, dans
`pwa/soundfonts/piano-fluidr3-13notes.js` (puis `dist/soundfonts/`). Ce
fichier est généré par `tools/build-soundfont-subset.js`.

L'attribution CC-BY 3.0 doit rester visible : elle figure dans l'en-tête de
l'asset, dans ce fichier et doit être reprise dans l'écran « À propos » (ou
la section d'attribution de l'interface) avec un lien vers la licence.

## scoretk

- Licence : GNU GPL v3 seulement (GPL-3.0-only)
- Source : <https://github.com/jperon/scoretk>

scoretk est un portage du code de MuseScore Studio, Copyright © MuseScore
Limited and others, distribué sous GNU GPL v3 seulement (GPL-3.0-only). Il
n'est chargé que lors de l'import d'un fichier `.mscz`, `.mscx`, `.ly`,
`.lilypond`, `.abc`, `.mid` ou `.midi`.

---

La combinaison distribuée est soumise à la GNU GPL v3. Les sources de Cantus
sont disponibles à l'adresse <https://github.com/jperon/cantus>.
