# Fixtures timeline scoretk

Instantanés **réels** de `timeline` produits par `convertWithTimeline` de
`scoretk-wasm` **0.1.0** (`/nix/store/gn76m55xvjll5jk7fwxq3njhaqxn42rs-scoretk-wasm-0.1.0`),
générés le **2026-11-18** par le harnais `/tmp/scoretk-verif/run.mjs`.
Ils sont normalisés sur la forme réellement exposée : seuls `division`,
`ticks`, `measures` et `pauses` sont conservés (les clés artificielles
`ticksPerQuarter` et `durationUs` de l'ancien harnais sont retirées). Chaque
mesure garde `measure`, `ordinal`, `segment`, `passage`, `tick`, `endTick`,
`timeUs`, `endTimeUs` ; chaque pause `tick`, `endTick`, `timeUs`, `endTimeUs`,
`seconds`.

Sources d'origine (via le harnais ci-dessus) :

| fixture | fichier source | taille |
|---|---|---|
| `D-expanded.json` | `/tmp/expmap/D.musicxml` (anacrouse + reprise) | 729 o |
| `E-expanded.json` | `/tmp/expmap/E.musicxml` (D.C., 3 passes) | 1207 o |
| `La_foule-expanded.json` | `La_foule.mxl` (98 occurrences / 72 mesures) | 11809 o |
| `La_foule-linear.json` | `La_foule.mxl`, sans reprises (72 occurrences) | 8637 o |
| `pause_basic-expanded.json` | `musescore/.../midiexport_data/testPauses.mscx` | 746 o |
| `pause_repeats-expanded.json` | `musescore/.../midiexport_data/testPausesRepeats.mscx` | 664 o |

Total : 23792 o.

Sélection volontairement minimale : `A`–`C` sont des cas simples déjà couverts
par `D` (anacrouse) et `E` (D.C.) ; `campra` et `godrest` (plus de 12 Ko
chacun) n'apportent ni pause ni schéma de reprise supplémentaire et
doubleraient le poids versionné. `pause_tempo` n'est pas retenu : la carte de
tempo n'est pas encore consommée par `timeline.coffee`.

Ne pas éditer ces fichiers à la main : les régénérer depuis scoretk puis les
normaliser.
