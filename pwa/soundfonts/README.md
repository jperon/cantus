# Banque audio (soundfont)

`TimGM6mb.sf3` est la banque General MIDI utilisée par le synthétiseur
SpessaSynth : 136 presets (128 programmes mélodiques + 8 kits de percussion),
404 échantillons, 1 976 938 octets.

## Provenance

- Source : TimGM6mb 1.3, paquet Debian `timgm6mb-soundfont` (GPL-2.0-only,
  voir `THIRD-PARTY.md` pour l'URL, les empreintes et les transformations).
- Copyright © 2004 Tim Brechbill, © 2010 David Bolton.

## Contenu et empreintes

- Fichier local : `pwa/soundfonts/TimGM6mb.sf3`, 1 976 938 octets
  - sha256 : `deb62fc32331a2ef2ab64ee8be869f927e01898c2ea6a52e5eb5150765759ee6`
- Zones de clavier réduites à une par deux octaves, échantillons encodés en
  Ogg Vorbis (qualité 2), points de boucle relatifs au flux décodé.

## Régénération

```sh
nix-shell -p python3Packages.numpy vorbis-tools --run \
  "python3 tools/build-soundfont.py"
```

Le script télécharge et vérifie le SF2 amont, applique les transformations
décrites dans `THIRD-PARTY.md`, assemble le SF3 et mesure sa taille brute et
gzip. `--all` construit aussi les variantes de mesure (conversion directe à
plusieurs qualités, réduction des zones à 1,5 ou 3 octaves, rééchantillonnage
à 22 050 Hz) dans `.tmp-sf/build/variantes/`.

## Utilisation

- Build normal : copié dans `dist/soundfonts/` et chargé au premier `play()` ;
  le service worker le précache en optionnel non bloquant, avec le processeur
  AudioWorklet `soundfonts/spessasynth_processor.min.js`.
- SPA : banque inlinée en base64 et processeur AudioWorklet inliné, chargé
  depuis une URL blob (aucun `fetch` possible en `file://`).
- Si la banque est absente (build sans échantillons, premier lancement hors
  ligne sans précache) ou ne se charge pas dans `SOUNDFONT_TIMEOUT`, le moteur
  audio bascule sur le repli oscillateur.
- La banque n'est décodée **qu'une seule fois** par session : elle reste
  chargée d'un mouvement à l'autre et le routage par voix passe par les
  `GainNode` connectés aux sorties de canal de SpessaSynth.
