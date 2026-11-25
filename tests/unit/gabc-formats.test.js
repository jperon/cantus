#!/usr/bin/env node
'use strict';

// Tests unitaires du format GABC dans src/formats.coffee : il est importable
// directement en notation carrée et convertible par scoretk en MusicXML pour
// la vue classique ; il est déclaré au partage et aux gestionnaires de
// fichiers, et son type MIME texte reste accepté.
//
// Usage : node tests/unit/gabc-formats.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const CoffeeScript = require('coffeescript');

function loadFormats() {
  const file = path.join(__dirname, '..', '..', 'src', 'formats.coffee');
  const js = CoffeeScript.compile(fs.readFileSync(file, 'utf8'), { bare: true });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', js)(mod, mod.exports);
  return mod.exports;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('gabc est lisible directement et convertible par scoretk', () => {
  const formats = loadFormats();
  assert.ok(formats.baseExtensions.includes('gabc'), 'gabc absent de baseExtensions');
  assert.ok(formats.scoretkExtensions.includes('gabc'), 'gabc absent de scoretkExtensions');
  assert.ok(formats.extensions.includes('gabc'), 'gabc absent de extensions');
  assert.strictEqual(formats.scoretkFrom('kyrie.gabc'), 'gabc');
  assert.strictEqual(formats.scoretkFrom('Kyrie.GABC'), 'gabc');
});

test('gabc est proposé à l’ouverture, au partage et dans les listes accept', () => {
  const formats = loadFormats();
  assert.ok(formats.formatLabels.includes('GABC'), 'libellé GABC absent');
  assert.ok(formats.shareAccept.includes('.gabc'), 'gabc absent du partage');
  assert.ok(formats.fileHandlerAccept['text/plain'].includes('.gabc'),
    'text/plain ne déclare pas .gabc');
  assert.ok(formats.fileHandlerAccept['text/x-gabc'].includes('.gabc'),
    'text/x-gabc ne déclare pas .gabc');
});

test('le type MIME de repli du gabc est connu', () => {
  const formats = loadFormats();
  assert.strictEqual(formats.mimeExtensions['text/x-gabc'], 'gabc');
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
