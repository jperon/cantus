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

test('normalizePlaybackData : notes aplaties, triées, durée du timemap', () => {
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
  const data = audio.normalizePlaybackData(
    { midi: 'x', duration: 85000, trackMap: { piano: [1, 2] }, syncMarks: [{ t: 1 }], staffLabels: ['Piano'] },
    parser
  );
  assert.deepStrictEqual(data.notes.map((n) => [n.start, n.track, n.pitch]), [
    [0.5, 1, 60],
    [0.75, 2, 48],
    [1.5, 1, 64],
  ]);
  // 85000 ms (timemap) l'emporte sur 84,9 s (MIDI) ; la dernière note finit à 2,75 s
  approx(data.duration, 85, 'durée');
  assert.deepStrictEqual(data.trackMap.byLabel, { piano: [1, 2] });
  assert.deepStrictEqual(data.syncMarks, [{ t: 1 }]);
  assert.deepStrictEqual(data.staffLabels, ['Piano']);
});

test('normalizePlaybackData : sans durée de timemap, utilise le MIDI', () => {
  const parser = {
    parseBase64: () => ({ duration: 12.5, tracks: [{ index: 0, notes: [] }] }),
  };
  const data = audio.normalizePlaybackData({ midi: 'x' }, parser);
  approx(data.duration, 12.5, 'durée MIDI');
  assert.throws(() => audio.normalizePlaybackData(null, parser), /absentes/);
  assert.throws(() => audio.normalizePlaybackData({ midi: 'x' }, null), /Parseur MIDI/);
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
