# Captures PWA

Les trois images de ce dossier sont générées par `tools/screenshots.js`, appelé
par le build avec l'option `--screenshots`. Elles sont toujours régénérées :
les fichiers existants ne font pas sauter la génération.

```sh
nix develop -c node build.js --screenshots
```

Le script sert `dist/` sur un port local libre avec Chromium headless, importe
la fixture LilyPond `tests/fixtures/alde-friezen` comme un dossier (les trois
fichiers `partituer.ly`, `fideo.ly` et `noaten.ily` ; `partituer.ly` est la
pièce affichée) et attend le rendu réel avant de capturer.

## Fichiers

- `mobile-1.png` (390x844) : partition affichée, barre du bas visible ;
- `mobile-2.png` (390x844) : panneau Settings ouvert par-dessus la partition ;
- `desktop-1.png` (1280x720) : partition affichée pendant la lecture audio,
  mesure en cours surlignée.

## Partition utilisée

« De âlde Friezen » (texte d'Eeltsje Halbertsma / Jacobus van Loon, mélodie de
Heinrich Christian Schnoor, mise en page d'Erik Nijenhuis) est diffusée sous
**CC0 1.0 Universal** ; le texte complet de la licence est dans
`tests/fixtures/alde-friezen/LICENSE`. Provenance et crédits :
`THIRD-PARTY.md`.

Les captures améliorent l'interface d'installation PWA sur mobile.
