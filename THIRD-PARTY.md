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

## mscz2xml

- Licence : GNU GPL v3 seulement (GPL-3.0-only)
- Source : <https://github.com/jperon/scoretk>

mscz2xml, qui fait partie du projet scoretk, est un portage du code de
MuseScore Studio, Copyright © MuseScore Limited and others, distribué sous
GNU GPL v3 seulement (GPL-3.0-only). Il n'est chargé que lors de l'import
d'un fichier `.mscz` ou `.mscx`.

---

La combinaison distribuée est soumise à la GNU GPL v3. Les sources de Cantus
sont disponibles à l'adresse <https://github.com/jperon/cantus>.
