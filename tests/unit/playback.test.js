#!/usr/bin/env node
'use strict';

// Tests unitaires du suivi de partition (src/playback.coffee), sans DOM.
// Le module ne manipule que des marqueurs {t,page,id} triés et un temps en ms.
//
// Usage : node tests/unit/playback.test.js  (code 0 si tout passe, 1 sinon)

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const CoffeeScript = require('coffeescript');

function loadPlayback() {
  const file = path.join(__dirname, '..', '..', 'src', 'playback.coffee');
  const js = CoffeeScript.compile(fs.readFileSync(file, 'utf8'), { bare: true });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
  return mod.exports;
}

const playback = loadPlayback();

const MARKS = [
  { t: 0, page: 1, id: 'm1' },
  { t: 500, page: 1, id: 'm2' },
  { t: 1000, page: 2, id: 'm3' },
  { t: 1500, page: 2, id: 'm4' },
  { t: 2000, page: 3, id: 'm5' },
];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('markAt : dernier marqueur dont t <= temps demandé', () => {
  assert.strictEqual(playback.markAt(MARKS, 0).id, 'm1');
  assert.strictEqual(playback.markAt(MARKS, 750).id, 'm2');
  assert.strictEqual(playback.markAt(MARKS, 1000).id, 'm3');
  assert.strictEqual(playback.markAt(MARKS, 5000).id, 'm5');
});

test('markAt : avant le premier marqueur, liste vide ou temps invalide -> null', () => {
  assert.strictEqual(playback.markAt(MARKS, -1), null);
  assert.strictEqual(playback.markAt([], 100), null);
  assert.strictEqual(playback.markAt(null, 100), null);
  assert.strictEqual(playback.markAt(MARKS, NaN), null);
});

test('firstMarkOfPage', () => {
  assert.strictEqual(playback.firstMarkOfPage(MARKS, 2).id, 'm3');
  assert.strictEqual(playback.firstMarkOfPage(MARKS, 9), null);
});

test('planFollow : mode page -> première page du marqueur courant', () => {
  assert.deepStrictEqual(playback.planFollow(MARKS, 1200, { scrollUnit: 'page' }), { page: 2, id: 'm3' });
  assert.deepStrictEqual(playback.planFollow(MARKS, 0, {}), { page: 1, id: 'm1' });
});

test('planFollow : mode système -> id du marqueur courant', () => {
  assert.deepStrictEqual(playback.planFollow(MARKS, 1600, { scrollUnit: 'system' }), { page: 2, id: 'm4' });
  assert.deepStrictEqual(playback.planFollow(MARKS, 0, { scrollUnit: 'system' }), { page: 1, id: 'm1' });
});

test('planFollow : avant le premier marqueur, on vise le début', () => {
  assert.deepStrictEqual(playback.planFollow(MARKS, -500, { scrollUnit: 'system' }), { page: 1, id: 'm1' });
  assert.strictEqual(playback.planFollow([], 100, {}), null);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`OK   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`ÉCHEC ${name}\n     ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests playback`);
process.exit(failed ? 1 : 0);
