#!/usr/bin/env node
'use strict';

// Tests unitaires du worker restés vrais après le passage à scoretk : le pont
// mesure -> page ne compte que les mesures écrites, et la clé du cache de
// lecture sépare mode (déroulé / linéaire) et bornes de mouvement.
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

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('countWrittenMeasures : mesures de la première partie seulement', () => {
  const xml = `<?xml version="1.0"?>
    <score-partwise>
      <part-list><score-part id="P1"><part-name>A</part-name></score-part></part-list>
      <part id="P1">
        <measure number="1"><note/></measure>
        <measure number="2"><note/></measure>
      </part>
      <part id="P2">
        <measure number="1"><note/></measure>
        <measure number="2"><note/></measure>
        <measure number="3"><note/></measure>
      </part>
    </score-partwise>`;
  assert.strictEqual(worker.countWrittenMeasures(xml), 2);
  assert.strictEqual(worker.countWrittenMeasures(''), 0);
  assert.strictEqual(worker.countWrittenMeasures(null), 0);
});

test('playbackCacheKey : mode et bornes distincts, mouvement distinct', () => {
  assert.notStrictEqual(
    worker.playbackCacheKey(1, false, 0, 50),
    worker.playbackCacheKey(1, true, 0, 50)
  );
  assert.notStrictEqual(
    worker.playbackCacheKey(1, false, 0, 50),
    worker.playbackCacheKey(1, false, 50, 100)
  );
  assert.notStrictEqual(
    worker.playbackCacheKey(1, false, 0, 50),
    worker.playbackCacheKey(2, false, 0, 50)
  );
  assert.strictEqual(
    worker.playbackCacheKey(1, false, 0, 50),
    worker.playbackCacheKey(1, false, 0, 50)
  );
  // Un rechargement (autre pagination) doit produire une autre clé, même à
  // mode et bornes égaux : un calcul encore en vol ne resservira pas ses
  // marqueurs après condensation des portées vides ou masquage d'une voix.
  assert.notStrictEqual(
    worker.playbackCacheKey(1, false, 0, 50, 1),
    worker.playbackCacheKey(1, false, 0, 50, 2)
  );
  assert.match(worker.playbackCacheKey(1, true, 0, 50), /linear/);
  assert.match(worker.playbackCacheKey(1, false, 0, 50), /expanded/);
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
