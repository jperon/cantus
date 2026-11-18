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
      segments: [{ from: 0, to: 85000, offset: 0 }],
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
    { midi: 'x', segments: [{ from: 0, to: 12500, offset: 0 }] },
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
    { measureId: 'm1', from: 0, to: 1000, offset: 0 },
    { measureId: 'm2', from: 50000, to: 51000, offset: 1000 },
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
