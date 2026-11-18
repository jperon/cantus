# Fixtures timeline scoretk

Instantanés **réels** de `timeline` produits par `convertWithTimeline` de
`scoretk-wasm` **0.1.0** (`/nix/store/gn76m55xvjll5jk7fwxq3njhaqxn42rs-scoretk-wasm-0.1.0`),
générés le **2026-11-18** par le harnais `/tmp/scoretk-verif/run.mjs`.
Ils sont normalisés sur la forme réellement exposée : seuls `division`,
`ticks`, `tempo`, `measures` et `pauses` sont conservés (les clés
artificielles `ticksPerQuarter` et `durationUs` de l'ancien harnais sont
retirées). Chaque entrée de `tempo` garde `tick`, `timeUs`,
`microsPerQuarter` ; chaque mesure `measure`, `ordinal`, `segment`, `passage`,
`tick`, `endTick`, `timeUs`, `endTimeUs` ; chaque pause `tick`, `endTick`,
`timeUs`, `endTimeUs`, `seconds`. Les six premières fixtures ont été
normalisées avant la prise en charge du tempo et n'ont pas de clé `tempo` :
c'est un cas réel de carte incomplète, que le code doit tolérer (tempo effectif
120, défaut de lecture 80).

Sources d'origine (via le harnais ci-dessus) :

| fixture | fichier source | taille |
|---|---|---|
| `D-expanded.json` | `/tmp/expmap/D.musicxml` (anacrouse + reprise) | 729 o |
| `E-expanded.json` | `/tmp/expmap/E.musicxml` (D.C., 3 passes) | 1207 o |
| `La_foule-expanded.json` | `La_foule.mxl` (98 occurrences / 72 mesures) | 11809 o |
| `La_foule-linear.json` | `La_foule.mxl`, sans reprises (72 occurrences) | 8637 o |
| `pause_basic-expanded.json` | `musescore/.../midiexport_data/testPauses.mscx` | 746 o |
| `pause_repeats-expanded.json` | `musescore/.../midiexport_data/testPausesRepeats.mscx` | 664 o |
| `andante-expanded.json` | `musescore/.../midiexport_data/testAndanteExcerpts.mscx` (tempo explicite 37) | 2660 o |
| `pauses-tempo-expanded.json` | `musescore/.../midiexport_data/testPausesTempoTimesigChange.mscx` (120 explicite puis 87, 100…) | 1531 o |
| `pauses-tempo.xml` | MusicXML converti du même `testPausesTempoTimesigChange.mscx` (`convertWithTimeline().musicxml`) | 10919 o |
| `tempo-2-2-expanded.json` | MusicXML 2/2 avec `<metronome>` à la blanche, converti par scoretk | 361 o |
| `tempo-2-2.xml` | MusicXML converti du même cas (blanche + `<sound tempo="120">`) | 3368 o |
| `tempo-6-8-expanded.json` | MusicXML 6/8 avec `<metronome>` à la noire pointée, converti par scoretk | 367 o |
| `tempo-6-8.xml` | MusicXML converti du même cas (noire pointée) | 4008 o |
| `tempo-6-8-default-expanded.json` | MusicXML 6/8 sans indication de tempo, converti par scoretk (120 noires implicites) | 363 o |
| `tempo-6-8-default.xml` | MusicXML converti du même cas, sans `<metronome>` | 3674 o |

Les six fichiers `tempo-*` ont été produits le **2026-11-18** par le même
harnais, à partir de MusicXML minimaux écrits pour exercer l'unité de battue,
puis convertis par scoretk (`convertWithTimeline`, reprises déroulées). Les
JSON sont normalisés comme les autres fixtures ; les XML sont la sortie réelle
de scoretk (`res.musicxml`). `tempo-2-2` porte un `<beat-unit>half</beat-unit>`,
`tempo-6-8` un `<beat-unit>quarter</beat-unit>` + `<beat-unit-dot/>`, et
`tempo-6-8-default` ni métronome ni `<sound>`, avec
`<time><beats>6</beats><beat-type>8</beat-type></time>`.

Total : 51043 o. `pauses-tempo.xml` est la preuve réelle qu'un
`<sound tempo="120">` explicite existe dans la première mesure : la seule
carte de tempo (500 000 µs au tick 0) ne le distingue pas du défaut implicite.

Sélection volontairement minimale : `A`–`C` sont des cas simples déjà couverts
par `D` (anacrouse) et `E` (D.C.) ; `campra` et `godrest` (plus de 12 Ko
chacun) n'apportent ni pause ni schéma de reprise supplémentaire et
doubleraient le poids versionné.

Ne pas éditer ces fichiers à la main : les régénérer depuis scoretk puis les
normaliser.
