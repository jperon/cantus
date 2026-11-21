# Échantillons audio (soundfont)

`piano-fluidr3-13notes.js` est un sous-ensemble du soundfont FluidR3_GM
(piano acoustique), au format MIDI.js utilisé par `soundfont-player`.

## Provenance

- Source amont : <https://github.com/gleitz/midi-js-soundfonts>, branche
  `gh-pages`, fichier `FluidR3_GM/acoustic_grand_piano-mp3.js`
- Échantillons FluidR3 par Frank Wen, rendu MIDI.js par Benjamin Gleitzman
- Licence : Creative Commons Attribution 3.0 Unported (CC-BY 3.0),
  <https://creativecommons.org/licenses/by/3.0/>
- L'attribution est reprise dans `THIRD-PARTY.md`, dans l'en-tête de l'asset et
  dans l'écran « À propos » de l'interface.

## Contenu et empreintes

- 13 notes de `C2` à `C6`, une tous les 4 demi-tons ; `soundfont-player`
  interpole la hauteur avec le buffer voisin (`playbackRate`).
- Fichier local : `pwa/soundfonts/piano-fluidr3-13notes.js`, 429 145 octets
  - sha256 : `c20793ec90d8d7aeb605f5e0ae5ee3b9800c99b1aa94ae5f770205c960d97f91`
- Fichier amont téléchargé le 2026-11-17 : 2 631 954 octets
  - sha256 : `00eebe0214c12ff8f32c47c2f7ac92ef352800e868ab0f883b80854486ac4ca6`

## Régénération

```sh
curl -sS -o /tmp/piano-mp3.js \
  https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/FluidR3_GM/acoustic_grand_piano-mp3.js
node tools/build-soundfont-subset.js /tmp/piano-mp3.js \
  pwa/soundfonts/piano-fluidr3-13notes.js
```

Le script vérifie que les 13 notes existent, réécrit l'en-tête avec la date et
le sha256 du fichier amont, puis produit l'asset autonome. Vérifier ensuite
`sha256sum pwa/soundfonts/piano-fluidr3-13notes.js`.

## Utilisation

- Build normal : copié dans `dist/soundfonts/` et chargé en `defer` ; le service
  worker le précache en optionnel non bloquant.
- SPA : inliné dans la page.
- Si l'asset est absent (build sans échantillons ou premier lancement hors
  ligne sans précache), le moteur audio bascule immédiatement sur le repli
  oscillateur, sans requête réseau.
- Les buffers sont décodés **une seule fois** par mouvement, puis partagés par
  toutes les pistes ; le routage par voix passe par les `GainNode`.

## TimGM6mb.sf3 (banque General MIDI)

`TimGM6mb.sf3` est la banque General MIDI utilisée par le synthétiseur
SpessaSynth : 136 presets (128 programmes mélodiques + 8 kits de percussion),
404 échantillons, 1 976 938 octets.

- Source : TimGM6mb 1.3, paquet Debian `timgm6mb-soundfont` (GPL-2.0-only,
  voir `THIRD-PARTY.md` pour l'URL, les empreintes et les transformations).
- Régénération : `nix-shell -p python3Packages.numpy vorbis-tools --run
  "python3 tools/build-soundfont.py"`.
- Le script produit aussi les variantes de mesure (conversion directe à
  plusieurs qualités, réduction des zones à 1,5 ou 3 octaves,
  rééchantillonnage à 22 050 Hz) : `--all` les construit dans
  `.tmp-sf/build/variantes/`.
