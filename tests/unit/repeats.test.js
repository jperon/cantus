#!/usr/bin/env node
'use strict';

// Tests unitaires de la lecture linéaire (src/worker.coffee) : construction du
// flux de mesures depuis un timemap Verovio et des segments écrits.
//
// Le worker n'est pas un module : on l'évalue avec un `self` factice (il pose
// seulement self.onmessage au chargement) et on lit module.exports, exposé
// uniquement quand `module` existe.
//
// Usage : node tests/unit/repeats.test.js  (code 0 si tout passe, 1 sinon)

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const CoffeeScript = require('coffeescript');

function loadWorker() {
  const file = path.join(__dirname, '..', '..', 'src', 'worker.coffee');
  const js = CoffeeScript.compile(fs.readFileSync(file, 'utf8'), { bare: true });
  const mod = { exports: {} };
  const self = { postMessage() {}, addEventListener() {}, onmessage: null };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', 'self', js)(mod, mod.exports, require, self);
  return mod.exports;
}

const worker = loadWorker();

// Timemap minimal : seules les entrées qui débutent une mesure portent
// measureOn. mC est reprise trois fois (D.C.), mB est une mesure de silence
// (aucun on/off dans son intervalle) et mA une anacrouse de 500 ms.
const TIMEMAP = [
  { measureOn: 'mA', tstamp: 0, qstamp: 0 },
  { on: ['nA'], tstamp: 0, qstamp: 0 },
  { measureOn: 'mB', tstamp: 500, qstamp: 1 },
  { measureOn: 'mC', tstamp: 1500, qstamp: 3, on: ['nC'] },
  { measureOn: 'mD', tstamp: 2500, qstamp: 5, on: ['nD'] },
  { measureOn: 'mC-rend2', tstamp: 3500, qstamp: 8, on: ['nC-rend2'] },
  { measureOn: 'mD-rend2', tstamp: 4500, qstamp: 10, on: ['nD-rend2'] },
  { measureOn: 'mC-rend3', tstamp: 5500, qstamp: 13, on: ['nC-rend3'] },
  { measureOn: 'mD-rend3', tstamp: 6500, qstamp: 15, on: ['nD-rend3'] },
];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('normalizeMeasureId : retire le suffixe de passage -rendN', () => {
  assert.strictEqual(worker.normalizeMeasureId('m12-rend2'), 'm12');
  assert.strictEqual(worker.normalizeMeasureId('m12-rend10'), 'm12');
  assert.strictEqual(worker.normalizeMeasureId('m12'), 'm12');
  assert.strictEqual(worker.normalizeMeasureId('m-rend'), 'm-rend');
});

test('measureIdsFromMei : ordre écrit, sans doublon, ids de base', () => {
  const mei = `
    <measures>
      <measure id="mA"><note/></measure>
      <measure xml:id="mB"></measure>
      <measure id="mC-rend2"></measure>
    </measures>`;
  // Verovio peut écrire `id` ou `xml:id` : les deux formes sont reconnues.
  assert.deepStrictEqual(worker.measureIdsFromMei(mei), ['mA', 'mB', 'mC']);
  assert.deepStrictEqual(worker.measureIdsFromMei(mei.replace('xml:id', 'id')),
    ['mA', 'mB', 'mC']);
  assert.deepStrictEqual(worker.measureIdsFromMei(''), []);
});

test('buildMeasureFlow : une entrée par début de mesure, passages inclus', () => {
  const flow = worker.buildMeasureFlow(TIMEMAP);
  assert.strictEqual(flow.length, 8);
  assert.deepStrictEqual(flow.map((f) => f.base), ['mA', 'mB', 'mC', 'mD', 'mC', 'mD', 'mC', 'mD']);
  assert.deepStrictEqual(flow.map((f) => f.t), [0, 500, 1500, 2500, 3500, 4500, 5500, 6500]);
  assert.strictEqual(flow[4].id, 'mC-rend2');
  assert.strictEqual(flow[0].flowIndex, 0);
  assert.strictEqual(flow[4].flowIndex, 4);
  assert.deepStrictEqual(worker.buildMeasureFlow(null), []);
});

test('buildLinearSegments : ordre écrit, offsets cumulés, anacrouse et silence', () => {
  const flow = worker.buildMeasureFlow(TIMEMAP);
  const layout = worker.buildLinearSegments(flow, 7500, ['mA', 'mB', 'mC', 'mD']);
  assert.deepStrictEqual(layout.missing, []);
  assert.deepStrictEqual(layout.segments, [
    { measureId: 'mA', from: 0, to: 500, offset: 0 },
    { measureId: 'mB', from: 500, to: 1500, offset: 500 },
    { measureId: 'mC', from: 1500, to: 2500, offset: 1500 },
    { measureId: 'mD', from: 2500, to: 3500, offset: 2500 },
  ]);
  // 500 (anacrouse) + 1000 (silence) + 1000 + 1000 ; le D.C. n'ajoute rien
  assert.strictEqual(layout.duration, 3500);
  // mC est écrite une seule fois malgré ses trois occurrences
  assert.deepStrictEqual(layout.entries.map((e) => e.id), ['mA', 'mB', 'mC', 'mD']);
  assert.strictEqual(layout.entries[2].occurrenceId, 'mC');
  assert.deepStrictEqual(flow.filter((f) => f.base === 'mC').map((f) => f.id),
    ['mC', 'mC-rend2', 'mC-rend3']);
});

test('buildLinearSegments : dernière mesure jusqu’à la fin du timemap', () => {
  const flow = worker.buildMeasureFlow(TIMEMAP);
  // mD n'est pas la dernière occurrence du flux : sa durée vient de l'entrée
  // suivante (mC-rend2), pas de la fin totale. Pour la toute dernière mesure
  // du flux, la durée va jusqu'à la fin du timemap.
  const layout = worker.buildLinearSegments(flow, 8000, ['mA', 'mB', 'mC', 'mD']);
  assert.strictEqual(layout.segments[3].to, 3500);
  const tail = worker.buildMeasureFlow([
    { measureOn: 'mZ', tstamp: 7000 },
  ]);
  const tailLayout = worker.buildLinearSegments(tail, 8000, ['mZ']);
  assert.deepStrictEqual(tailLayout.segments, [
    { measureId: 'mZ', from: 7000, to: 8000, offset: 0 },
  ]);
  assert.strictEqual(tailLayout.duration, 1000);
});

test('buildLinearSegments : mesure écrite jamais jouée ignorée sans décaler les autres', () => {
  const flow = worker.buildMeasureFlow(TIMEMAP);
  const layout = worker.buildLinearSegments(flow, 7500, ['mA', 'mZoom', 'mB', 'mC', 'mD']);
  assert.deepStrictEqual(layout.missing, ['mZoom']);
  assert.deepStrictEqual(layout.segments.map((s) => s.measureId), ['mA', 'mB', 'mC', 'mD']);
  assert.deepStrictEqual(layout.segments.map((s) => s.offset), [0, 500, 1500, 2500]);
  assert.strictEqual(layout.duration, 3500);
});

test('buildLinearSegments : prorata d’un tempo variable', () => {
  // Deux mesures de durées réelles différentes (tempo/temps composés)
  const flow = worker.buildMeasureFlow([
    { measureOn: 'm1', tstamp: 0 },
    { measureOn: 'm2', tstamp: 1500 },
    { measureOn: 'm3', tstamp: 2500 },
  ]);
  const layout = worker.buildLinearSegments(flow, 4000, ['m1', 'm2', 'm3']);
  assert.deepStrictEqual(layout.segments, [
    { measureId: 'm1', from: 0, to: 1500, offset: 0 },
    { measureId: 'm2', from: 1500, to: 2500, offset: 1500 },
    { measureId: 'm3', from: 2500, to: 4000, offset: 2500 },
  ]);
  assert.strictEqual(layout.duration, 4000);
});

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
