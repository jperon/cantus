#!/usr/bin/env node
'use strict';

// Tests unitaires du choix du format d'entrée scoretk (src/worker.coffee) :
// `from` est déduit de l'extension, toujours explicite, et une extension
// inconnue laisse scoretk détecter le format par le contenu.
//
// Le worker n'est pas un module : on l'évalue avec un `self` factice. Seule
// `scoretkFrom` est utilisée ici, sans wasm ni Verovio.
//
// Usage : node tests/unit/scoretk-from.test.js  (code 0 si tout passe, 1 sinon)

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const CoffeeScript = require('coffeescript');

function loadWorker() {
  const file = path.join(__dirname, '..', '..', 'src', 'worker.coffee');
  const js = CoffeeScript.compile(fs.readFileSync(file, 'utf8'), { bare: true });
  const mod = { exports: {} };
  const self = {
    postMessage() {},
    addEventListener() {},
    onmessage: null,
  };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', 'self', js)(mod, mod.exports, require, self);
  return mod.exports;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('extensions MuseScore, LilyPond et ABC mappées explicitement', () => {
  const { scoretkFrom } = loadWorker();
  assert.strictEqual(scoretkFrom('partition.mscz'), 'mscz');
  assert.strictEqual(scoretkFrom('partition.mscx'), 'mscx');
  assert.strictEqual(scoretkFrom('chanson.ly'), 'ly');
  assert.strictEqual(scoretkFrom('chanson.lilypond'), 'lilypond');
  assert.strictEqual(scoretkFrom('chanson.abc'), 'abc');
});

test('extension insensible à la casse et nom sans extension', () => {
  const { scoretkFrom } = loadWorker();
  assert.strictEqual(scoretkFrom('PARTITION.MSCZ'), 'mscz');
  assert.strictEqual(scoretkFrom('Chanson.LY'), 'ly');
  assert.strictEqual(scoretkFrom('Chanson.Abc'), 'abc');
  assert.strictEqual(scoretkFrom('sans-extension'), undefined);
  assert.strictEqual(scoretkFrom(undefined), undefined);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`not ok - ${name}\n  ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
