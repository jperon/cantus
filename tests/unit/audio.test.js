#!/usr/bin/env node
'use strict';

// Tests unitaires du moteur audio (src/audio.coffee), sans navigateur.
// Le WebAudio n'existe pas sous Node : on teste uniquement la logique pure
// exposée par le module (volume -> gain, mapping libellé -> pistes,
// ordonnancement des notes, normalisation des données de lecture).
//
// Usage : node tests/unit/audio.test.js  (code 0 si tout passe, 1 sinon)
// tests/run.sh ne lance pas les tests unitaires ; lancer cette commande à part.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const CoffeeScript = require('coffeescript');

function loadAudio() {
  const file = path.join(__dirname, '..', '..', 'src', 'audio.coffee');
  const js = CoffeeScript.compile(fs.readFileSync(file, 'utf8'), { bare: true });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
  return mod.exports;
}

const audio = loadAudio();

// Le test d'intégration ci-dessous fait tourner la vraie timeline sur une
// fixture scoretk : c'est elle qui produit les segments consommés par audio.
function loadTimeline() {
  const file = path.join(__dirname, '..', '..', 'src', 'timeline.coffee');
  const js = CoffeeScript.compile(fs.readFileSync(file, 'utf8'), { bare: true });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
  return mod.exports;
}

const timeline = loadTimeline();
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'scoretk');

const approx = (actual, expected, msg, eps = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg || 'valeur'} : attendu ${expected}, obtenu ${actual}`
  );
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- Volume -> gain --------------------------------------------------------

test('volumeToGain : 100 % -> 1, 50 % -> 0,505', () => {
  approx(audio.volumeToGain(100), 1, '100 %');
  approx(audio.volumeToGain(50), 0.505, '50 %');
});

test('volumeToGain : plancher à FLOOR (0,01) pour 1 % et moins', () => {
  assert.strictEqual(audio.FLOOR, 0.01);
  approx(audio.volumeToGain(1), 0.0199, '1 %');
  approx(audio.volumeToGain(0), 0.0199, '0 % ramené à 1 %');
  approx(audio.volumeToGain(-12), 0.0199, 'négatif ramené à 1 %');
  assert.ok(audio.volumeToGain(1) > 0, 'le curseur ne coupe jamais totalement');
});

test('volumeToGain : valeurs hautes bornées à 100 %', () => {
  approx(audio.volumeToGain(150), 1, '150 %');
  approx(audio.volumeToGain(Infinity), 1, 'Infinity -> 100 %');
  approx(audio.volumeToGain(NaN), 1, 'NaN -> 100 %');
});

test('voiceGainValue : le masquage explicite coupe vraiment', () => {
  assert.strictEqual(audio.voiceGainValue(50, true), 0);
  approx(audio.voiceGainValue(50, false), 0.505, 'voix non masquée');
  approx(audio.voiceGainValue(0, true), 0, 'masquée à volume 0');
});

test('DEFAULT_VOICE_VOLUME : 50 %, gain audible', () => {
  assert.strictEqual(audio.DEFAULT_VOICE_VOLUME, 50, 'volume par défaut d’une voix');
  const gain = audio.voiceGainValue(audio.DEFAULT_VOICE_VOLUME, false);
  approx(gain, 0.505, 'gain au volume par défaut');
  assert.ok(gain > 0.1, 'le gain par défaut reste audible');
  assert.ok(gain < audio.volumeToGain(100), 'inférieur au gain maximal');
});

// --- Mapping libellé -> pistes ---------------------------------------------

test('resolveTrackMap : index par piste et par libellé, doublons écartés', () => {
  const map = audio.resolveTrackMap({ piano: [1, 2, 2], violon: [3], vide: [], invalide: 'x' });
  assert.deepStrictEqual(map.byLabel.piano, [1, 2]);
  assert.deepStrictEqual(map.byLabel.violon, [3]);
  assert.deepStrictEqual(map.byLabel.vide, []);
  assert.strictEqual(map.byLabel.invalide, undefined);
  assert.strictEqual(map.byTrack[1], 'piano');
  assert.strictEqual(map.byTrack[2], 'piano');
  assert.strictEqual(map.byTrack[3], 'violon');
});

test('resolveTrackMap : entrées absentes ou non numériques ignorées', () => {
  const map = audio.resolveTrackMap({ a: [0, '2', -1, 'x', null], b: null });
  assert.deepStrictEqual(map.byLabel.a, [0, 2]);
  assert.strictEqual(map.byLabel.b, undefined);
  assert.strictEqual(map.byTrack[0], 'a');
  assert.strictEqual(map.byTrack[2], 'a');
  assert.strictEqual(map.byTrack[-1], undefined);
  assert.deepStrictEqual(audio.resolveTrackMap(null), { byTrack: {}, byLabel: {} });
});

// --- Canaux et programmes GM -----------------------------------------------

const playedTrack = (index, program, channel = 0) => ({
  index,
  program,
  channel,
  notes: [{ start: 0, dur: 1, pitch: 60, velocity: 90 }],
});

test('assignTrackChannels : deux programmes différents -> deux canaux et deux programChange', () => {
  const plan = audio.assignTrackChannels(
    [playedTrack(0, 0), playedTrack(1, 40)],
    {}
  );
  assert.deepStrictEqual(plan.byTrack, { 0: 0, 1: 1 });
  assert.deepStrictEqual(plan.channels.map((c) => c.channel), [0, 1]);
  assert.deepStrictEqual(plan.channels.map((c) => c.program), [0, 40]);
  assert.strictEqual(plan.overflow, 0);
  assert.ok(
    plan.channels[0].program !== plan.channels[1].program,
    'les deux pistes reçoivent des programChange différents'
  );
});

test('assignTrackChannels : percussion sur le canal 9, programme ignoré', () => {
  const plan = audio.assignTrackChannels(
    [playedTrack(0, 0), playedTrack(1, 24, 9)],
    {}
  );
  assert.strictEqual(plan.byTrack[1], 9);
  const drums = plan.channels.find((c) => c.percussion);
  assert.strictEqual(drums.channel, 9);
  assert.deepStrictEqual(drums.tracks, [1]);
});

test('assignTrackChannels : plus de 15 pistes -> un canal par libellé de voix', () => {
  const tracks = [];
  const byTrack = {};
  for (let i = 0; i < 24; i += 1) {
    tracks.push(playedTrack(i, i));
    byTrack[i] = `voix-${i % 3}`;
  }
  const plan = audio.assignTrackChannels(tracks, byTrack);
  assert.strictEqual(plan.channels.length, 3, 'un canal par voix');
  assert.strictEqual(plan.overflow, 0);
  assert.strictEqual(new Set(plan.channels.map((c) => c.channel)).size, 3);
  for (let i = 0; i < 24; i += 1) {
    assert.strictEqual(plan.byTrack[i], plan.byTrack[i % 3], `piste ${i} rattachée à sa voix`);
  }
});

test('assignTrackChannels : au-delà de 15 voix, débordement signalé', () => {
  const tracks = [];
  const byTrack = {};
  for (let i = 0; i < 18; i += 1) {
    tracks.push(playedTrack(i, i));
    byTrack[i] = `voix-${i}`;
  }
  const plan = audio.assignTrackChannels(tracks, byTrack);
  assert.strictEqual(plan.channels.length, 18);
  assert.strictEqual(plan.overflow, 3, 'trois voix partagent un canal');
});

test('trackProgram : programme borné à 0..127, piano par défaut', () => {
  assert.strictEqual(audio.trackProgram({ program: 40 }), 40);
  assert.strictEqual(audio.trackProgram({ program: null }), 0);
  assert.strictEqual(audio.trackProgram({}), 0);
  assert.strictEqual(audio.trackProgram({ program: 200 }), 127);
  assert.strictEqual(audio.trackProgram({ program: -4 }), 0);
});

test('effectiveTrackProgram : partition, choix de voix, pianoOnly, batterie', () => {
  const flute = { index: 0, channel: 0, program: 73 };
  const drums = { index: 1, channel: 9, program: 8 };
  const programs = { Flûte: 52 };
  // Absence de choix : programme de la partition ; choix par libellé ; une
  // autre voix n'hérite pas du choix.
  assert.strictEqual(audio.effectiveTrackProgram(flute, 'Flûte', {}, false), 73, 'partition');
  assert.strictEqual(audio.effectiveTrackProgram(flute, 'Flûte', programs, false), 52, 'choix de la voix');
  assert.strictEqual(audio.effectiveTrackProgram(flute, 'Hautbois', programs, false), 73, 'autre voix');
  // pianoOnly prime sur le choix, sans l'effacer (le choix reste dans la table).
  assert.strictEqual(audio.effectiveTrackProgram(flute, 'Flûte', programs, true), 0, 'piano seulement');
  assert.strictEqual(programs.Flûte, 52, 'le choix de voix est conservé');
  // Batterie : programme de la partition, choix et pianoOnly ignorés.
  assert.strictEqual(audio.effectiveTrackProgram(drums, 'Batterie', programs, true), 8, 'batterie');
  assert.strictEqual(audio.effectiveTrackProgram(drums, 'Batterie', { Batterie: 52 }, false), 8, 'batterie, choix ignoré');
});

test('effectiveTrackProgram : programme absent, choix hors bornes ou invalide', () => {
  const track = { index: 2, channel: 0 };
  assert.strictEqual(audio.effectiveTrackProgram(track, 'Piano', {}, false), 0, 'programme absent');
  assert.strictEqual(audio.effectiveTrackProgram(track, 'Piano', { Piano: 200 }, false), 127, 'borne haute');
  assert.strictEqual(audio.effectiveTrackProgram(track, 'Piano', { Piano: -3.7 }, false), 0, 'borne basse et arrondi');
  assert.strictEqual(audio.effectiveTrackProgram(track, 'Piano', { Piano: 'x' }, false), 0, 'choix invalide');
  assert.strictEqual(
    audio.effectiveTrackProgram({ ...track, program: 41 }, 'Piano', { Piano: null }, false),
    41,
    'null vaut instrument de la partition'
  );
});

// --- Ordonnanceur ----------------------------------------------------------

const notes = [
  { start: 0, pitch: 60 },
  { start: 0.1, pitch: 62 },
  { start: 0.2, pitch: 64 },
  { start: 0.5, pitch: 65 },
  { start: 1, pitch: 67 },
];

test('noteIndexAt : recherche binaire de la première note >= position', () => {
  assert.strictEqual(audio.noteIndexAt(notes, 0), 0);
  assert.strictEqual(audio.noteIndexAt(notes, 0.05), 1);
  assert.strictEqual(audio.noteIndexAt(notes, 0.2), 2);
  assert.strictEqual(audio.noteIndexAt(notes, 0.21), 3);
  assert.strictEqual(audio.noteIndexAt(notes, 2), notes.length);
  assert.strictEqual(audio.noteIndexAt([], 1), 0);
});

test('notesToSchedule : fenêtre [fromTime, toTime) et index de reprise', () => {
  const block = audio.notesToSchedule(notes, 0, 0.15, 0.6);
  assert.deepStrictEqual(block.notes.map((n) => n.start), [0.2, 0.5]);
  assert.strictEqual(block.nextIndex, 4);
});

test('notesToSchedule : reprise en cours de bloc, notes passées ignorées', () => {
  const block = audio.notesToSchedule(notes, 2, 0.25, 0.55);
  assert.deepStrictEqual(block.notes.map((n) => n.start), [0.5]);
  assert.strictEqual(block.nextIndex, 4);
  // Index déjà au-delà de la fenêtre : rien à planifier
  const empty = audio.notesToSchedule(notes, 4, 0, 0.5);
  assert.deepStrictEqual(empty.notes, []);
  assert.strictEqual(empty.nextIndex, 4);
});

test('notesToSchedule : index invalide ramené au début', () => {
  const block = audio.notesToSchedule(notes, -3, 0, 0.15);
  assert.deepStrictEqual(block.notes.map((n) => n.start), [0, 0.1]);
  assert.strictEqual(block.nextIndex, 2);
});

// --- Normalisation des données de lecture ----------------------------------

test('normalizePlaybackData : notes aplaties, triées, durée du slice', () => {
  const parser = {
    parseBase64: () => ({
      duration: 84.9,
      tracks: [
        { index: 0, notes: [] },
        {
          index: 1,
          notes: [
            { start: 1.5, dur: 0.5, pitch: 64, velocity: 80 },
            { start: 0.5, dur: 0.25, pitch: 60, velocity: 100 },
          ],
        },
        { index: 2, notes: [{ start: 0.75, dur: 2, pitch: 48, velocity: 90 }] },
      ],
    }),
  };
  // Un segment couvre tout le morceau : le remappage est l'identité.
  const data = audio.normalizePlaybackData(
    {
      midi: 'x',
      duration: 85000,
      segments: [{ fromMs: 0, toMs: 85000, offsetMs: 0 }],
      trackMap: { piano: [1, 2] },
      syncMarks: [{ t: 1 }],
      staffLabels: ['Piano'],
    },
    parser
  );
  assert.deepStrictEqual(data.notes.map((n) => [n.start, n.track, n.pitch]), [
    [0.5, 1, 60],
    [0.75, 2, 48],
    [1.5, 1, 64],
  ]);
  // 85000 ms (slice) l'emporte sur 84,9 s (MIDI) ; la dernière note finit à 2,75 s
  approx(data.duration, 85, 'durée');
  assert.deepStrictEqual(data.trackMap.byLabel, { piano: [1, 2] });
  assert.deepStrictEqual(data.syncMarks, [{ t: 1 }]);
  assert.deepStrictEqual(data.staffLabels, ['Piano']);
});

test('normalizePlaybackData : sans durée, la somme des segments fait foi', () => {
  const parser = {
    parseBase64: () => ({ duration: 99, tracks: [{ index: 0, notes: [] }] }),
  };
  const data = audio.normalizePlaybackData(
    { midi: 'x', segments: [{ fromMs: 0, toMs: 12500, offsetMs: 0 }] },
    parser
  );
  approx(data.duration, 12.5, 'durée des segments');
  assert.throws(() => audio.normalizePlaybackData(null, parser), /absentes/);
  assert.throws(() => audio.normalizePlaybackData({ midi: 'x' }, null), /Parseur MIDI/);
});

// --- Lecture linéaire : remappage des notes sur les segments ----------------

const SEGMENTS = [
  { measureId: 'm1', from: 0, to: 1, offset: 0 },
  { measureId: 'm2', from: 5, to: 6, offset: 1 },
];

test('remapNotesToSegments : translation et troncature à la frontière', () => {
  const notes = [
    { start: 0.5, dur: 2, pitch: 60, velocity: 90, track: 1 },
    { start: 5.2, dur: 0.1, pitch: 64, velocity: 80, track: 1 },
  ];
  const out = audio.remapNotesToSegments(notes, SEGMENTS);
  assert.strictEqual(out.length, 2);
  approx(out[0].start, 0.5, 'start 0');
  approx(out[0].dur, 0.5, 'dur 0 (tronquée à la frontière)');
  assert.strictEqual(out[0].pitch, 60);
  approx(out[1].start, 1.2, 'start 1');
  approx(out[1].dur, 0.1, 'dur 1');
  assert.strictEqual(out[1].pitch, 64);
});

test('remapNotesToSegments : note hors segment ou de durée restante nulle écartée', () => {
  const notes = [
    { start: 1, dur: 1, pitch: 60, velocity: 90, track: 1 },   // == to, hors segment
    { start: 4.9, dur: 1, pitch: 62, velocity: 90, track: 1 }, // dans un trou
    { start: 6, dur: 1, pitch: 63, velocity: 90, track: 1 },   // après le dernier
    { start: 5.5, dur: 0, pitch: 65, velocity: 90, track: 1 }, // durée nulle
  ];
  assert.deepStrictEqual(audio.remapNotesToSegments(notes, SEGMENTS), []);
});

test('remapNotesToSegments : résultat trié par start puis hauteur', () => {
  const notes = [
    { start: 5.8, dur: 0.1, pitch: 70, velocity: 90, track: 2 },
    { start: 0.8, dur: 0.1, pitch: 72, velocity: 90, track: 1 },
    { start: 0.1, dur: 0.1, pitch: 74, velocity: 90, track: 1 },
  ];
  const out = audio.remapNotesToSegments(notes, SEGMENTS);
  assert.deepStrictEqual(out.map((n) => n.pitch), [74, 72, 70]);
  approx(out[0].start, 0.1, 'start 0');
  approx(out[1].start, 0.8, 'start 1');
  approx(out[2].start, 1.8, 'start 2');
});

test('remapNotesToSegments : segments vides ou invalides -> aucune note', () => {
  assert.deepStrictEqual(audio.remapNotesToSegments([{ start: 0, dur: 1 }], []), []);
  assert.deepStrictEqual(audio.remapNotesToSegments([{ start: 0, dur: 1 }], null), []);
  assert.deepStrictEqual(audio.remapNotesToSegments([{ start: 0, dur: 1 }], [
    { from: 1, to: 1, offset: 0 },
    { from: 2, to: 1, offset: 0 },
    { from: 3, to: 4, offset: -5 },
  ]), []);
});

test('segmentsDuration : somme des longueurs, offsets ignorés', () => {
  assert.strictEqual(audio.segmentsDuration(SEGMENTS), 2);
  assert.strictEqual(audio.segmentsDuration([]), 0);
  assert.strictEqual(audio.segmentsDuration([
    { from: 0, to: 1.5, offset: 0 },
    { from: 5, to: 6, offset: 1.5 },
  ]), 2.5);
});

test('normalizePlaybackData : mode linéaire, durée écrite et notes remappées', () => {
  const parser = {
    parseBase64: () => ({
      duration: 104,
      tracks: [
        {
          index: 1,
          notes: [
            { start: 0.5, dur: 2, pitch: 60, velocity: 100 },
            { start: 33, dur: 1, pitch: 62, velocity: 100 }, // hors segments
            { start: 50.2, dur: 0.1, pitch: 64, velocity: 100 },
          ],
        },
      ],
    }),
  };
  // Le worker fournit les segments en millisecondes.
  const segments = [
    { measureId: 'm1', fromMs: 0, toMs: 1000, offsetMs: 0 },
    { measureId: 'm2', fromMs: 50000, toMs: 51000, offsetMs: 1000 },
  ];
  const data = audio.normalizePlaybackData(
    { midi: 'x', duration: 2000, segments, syncMarks: [{ t: 0 }] },
    parser
  );
  // La durée écrite (2 s) l'emporte sur le MIDI complet (104 s)
  approx(data.duration, 2, 'durée écrite');
  assert.deepStrictEqual(data.notes.map((n) => n.pitch), [60, 64]);
  approx(data.notes[0].start, 0.5, 'start 0');
  approx(data.notes[0].dur, 0.5, 'dur 0');
  approx(data.notes[1].start, 1.2, 'start 1');
  approx(data.notes[1].dur, 0.1, 'dur 1');
  assert.strictEqual(data.segments.length, 2);
});

// --- Intégration : timeline réelle -> données de lecture ---------------------
// Régression : `buildSegments` produit `{measure, fromMs, toMs, offsetMs}`,
// noms que la conversion en secondes lit sans repli. Une forme différente
// laisserait tous les champs NaN et `remapNotesToSegments` écarterait TOUTES
// les notes (mesuré : 0/813) — l'horloge avancerait sans aucune source audio.
test('intégration : buildSegments(fixture) -> normalizePlaybackData garde les notes', () => {
  const slice = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'La_foule-expanded.json'), 'utf8')
  );
  const segments = timeline.buildSegments(slice);
  assert.ok(segments.length > 1, 'segments produits par la timeline');
  assert.ok(
    segments.every(
      (s) => Number.isFinite(s.fromMs) && Number.isFinite(s.toMs) && Number.isFinite(s.offsetMs)
    ),
    'champs de segment en millisecondes'
  );

  // Une note au début de chaque mesure, comme le flux MIDI exporté.
  const midiNotes = slice.measures.map((m) => ({
    start: m.timeUs / 1e6 + 0.01,
    dur: 0.2,
    pitch: 60,
    velocity: 90,
  }));
  const parser = { parseBase64: () => ({ duration: 0, tracks: [{ index: 0, notes: midiNotes }] }) };
  const data = audio.normalizePlaybackData({ midi: 'x', segments }, parser);

  assert.ok(data.notes.length > 0, 'aucune note conservée après remappage');
  assert.strictEqual(data.notes.length, midiNotes.length, 'toutes les notes sont dans les bornes');
  const last = segments[segments.length - 1];
  const total = (last.offsetMs + (last.toMs - last.fromMs)) / 1000;
  approx(data.duration, total, 'durée issue des segments', 1e-6);
  for (const note of data.notes) {
    assert.ok(note.start >= 0 && note.start < total, `start hors bornes : ${note.start}`);
    assert.ok(note.dur > 0 && note.start + note.dur <= total + 1e-9, `durée hors bornes : ${note.dur}`);
  }
});

// --- Tempo de lecture ------------------------------------------------------

test('playbackTempoFactor : tempo choisi / tempo initial du fichier', () => {
  approx(audio.playbackTempoFactor(160, 80), 2, '160 sur un fichier à 80');
  approx(audio.playbackTempoFactor(80, 120), 2 / 3, '80 sur la référence 120');
  approx(audio.playbackTempoFactor(37, 37), 1, 'défaut du fichier');
  assert.strictEqual(audio.playbackTempoFactor(80, 0), 1, 'fichier inconnu : inchangé');
  assert.strictEqual(audio.playbackTempoFactor(NaN, 80), 1, 'choix invalide : inchangé');
});

// Données dérivées de la fixture RÉELLE pause_basic (slices, segments,
// marqueurs, pauses) : le facteur met à l'échelle le temps de LECTURE d'un
// seul coup, sans modifier les données brutes du cache. Les segments restent
// en temps source : `from`/`to` sont des positions du flux MIDI.
test('scalePlaybackData : durée, marqueurs et pauses divisés par 2, segments en temps source', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'pause_basic-expanded.json'), 'utf8'));
  const slice = timeline.movementSlice(raw, 0, null);
  const segments = timeline.buildSegments(slice);
  // Une page unique : le mapping page est un paramètre du marqueur, pas une
  // donnée de la carte scoretk.
  const pages = slice.measures.map(() => 1);
  const marks = timeline.buildSyncMarks(slice, pages, 0).marks;
  const data = {
    duration: slice.durationMs,
    segments,
    syncMarks: marks,
    pauses: slice.pauses,
  };
  const before = JSON.stringify(data);
  const scaled = audio.scalePlaybackData(data, 2);

  assert.strictEqual(JSON.stringify(data), before, 'les données brutes ne sont pas modifiées');
  assert.strictEqual(scaled.duration, data.duration / 2);
  assert.strictEqual(scaled.tempoFactor, 2, 'facteur transmis aux notes');
  assert.strictEqual(scaled.segments, segments, 'segments laissés en temps source');
  scaled.segments.forEach((seg, i) => {
    assert.strictEqual(seg.fromMs, segments[i].fromMs, `segment ${i} fromMs`);
    assert.strictEqual(seg.toMs, segments[i].toMs, `segment ${i} toMs`);
    assert.strictEqual(seg.offsetMs, segments[i].offsetMs, `segment ${i} offsetMs`);
  });
  assert.ok(marks.length > 0, 'marqueurs réels produits');
  scaled.syncMarks.forEach((mark, i) => {
    assert.strictEqual(mark.t, marks[i].t / 2, `marqueur ${i}`);
  });
  assert.ok(slice.pauses.length > 0, 'pauses réelles');
  scaled.pauses.forEach((pause, i) => {
    assert.strictEqual(pause.timeUs, slice.pauses[i].timeUs / 2, `pause ${i} début`);
    assert.strictEqual(pause.endTimeUs, slice.pauses[i].endTimeUs / 2, `pause ${i} fin`);
  });
});

// Les notes sont sélectionnées dans le temps SOURCE (from/to des segments),
// puis leurs débuts et durées de sortie sont divisés par le facteur : le MIDI
// joué accélère réellement, au lieu d'être décalé. La fixture réelle fournit
// les mesures et la timeline les segments.
test('tempo ×2 : mêmes notes programmées, débuts et durées divisés par 2', () => {
  const slice = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'La_foule-expanded.json'), 'utf8')
  );
  const segments = timeline.buildSegments(slice);
  const midiNotes = slice.measures.map((m) => ({
    start: m.timeUs / 1e6 + 0.01,
    dur: 0.2,
    pitch: 60 + (m.measure % 12),
    velocity: 90,
  }));
  const parser = { parseBase64: () => ({ duration: 0, tracks: [{ index: 0, notes: midiNotes }] }) };
  const data = { midi: 'x', segments };
  const base = audio.normalizePlaybackData(data, parser);
  const fast = audio.normalizePlaybackData(audio.scalePlaybackData(data, 2), parser);

  assert.ok(base.notes.length > 1, 'notes préparées au tempo du fichier');
  assert.strictEqual(fast.notes.length, base.notes.length, 'les mêmes notes sont jouées');
  base.notes.forEach((note, i) => {
    const other = fast.notes[i];
    assert.strictEqual(other.pitch, note.pitch, `note ${i} : hauteur`);
    approx(other.start, note.start / 2, `note ${i} : début`, 1e-9);
    approx(other.dur, note.dur / 2, `note ${i} : durée`, 1e-9);
  });
  approx(fast.duration, base.duration / 2, 'durée totale', 1e-9);
});

test('scalePlaybackData : facteur 1 rend les données telles quelles', () => {
  const data = { duration: 1000, segments: [{ fromMs: 0, toMs: 1000, offsetMs: 0 }] };
  assert.strictEqual(audio.scalePlaybackData(data, 1), data);
  assert.strictEqual(audio.scalePlaybackData(data, 0), data);
});

// --- Transposition auditive ------------------------------------------------

test('transposePitch : décalage entier, borné à 0..127', () => {
  assert.strictEqual(audio.transposePitch(60, 2), 62);
  assert.strictEqual(audio.transposePitch(60, -3), 57);
  assert.strictEqual(audio.transposePitch(60, 0), 60);
  assert.strictEqual(audio.transposePitch(126, 5), 127, 'borne haute');
  assert.strictEqual(audio.transposePitch(2, -5), 0, 'borne basse');
});

test('playedPitch : une percussion (canal MIDI 10) n’est jamais transposée', () => {
  assert.strictEqual(audio.playedPitch(60, 5, false), 65);
  assert.strictEqual(audio.playedPitch(60, 5, true), 60);
  assert.strictEqual(audio.playedPitch(60, -5, true), 60);
});

test('normalizePlaybackData : pistes de percussion signalées, hauteurs intactes', () => {
  const parser = {
    parseBase64: () => ({
      duration: 1,
      tracks: [
        { index: 0, channel: 0, notes: [{ start: 0, dur: 0.5, pitch: 60, velocity: 90 }] },
        { index: 1, channel: 9, notes: [{ start: 0.2, dur: 0.2, pitch: 38, velocity: 80 }] },
      ],
    }),
  };
  const data = audio.normalizePlaybackData(
    { midi: 'x', duration: 1000, segments: [{ fromMs: 0, toMs: 1000, offsetMs: 0 }] },
    parser
  );
  assert.deepStrictEqual(data.percussionTracks, [1]);
  assert.deepStrictEqual(data.notes.map((n) => n.pitch), [60, 38], 'notes chargées inchangées');
});

// --- Exécution -------------------------------------------------------------

let passed = 0;
const failures = [];
for (const { name, fn } of tests) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err && err.message}`);
  }
}

console.log('');
console.log(`${passed}/${tests.length} test(s) réussi(s)`);
if (failures.length) {
  console.log(`${failures.length} échec(s)`);
  process.exit(1);
}
process.exit(0);
