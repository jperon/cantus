#!/usr/bin/env node
'use strict';

// Tests unitaires de src/formats.coffee, la source unique des formats
// importables : `scoretkFrom` déduit `from` de l'extension, toujours
// explicitement, et une extension inconnue laisse scoretk détecter le format
// par le contenu. Un test de cohérence vérifie que les tables ne peuvent pas
// diverger (chaque extension scoretk a un `from`, chaque type MIME pointe vers
// une extension connue).
//
// Le module est évalué en CommonJS (module.exports), sans DOM, wasm ni Verovio.
//
// Usage : node tests/unit/scoretk-from.test.js  (code 0 si tout passe, 1 sinon)

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

test('extensions MuseScore, LilyPond, ABC, MIDI et GABC mappées explicitement', () => {
  const { scoretkFrom } = loadFormats();
  assert.strictEqual(scoretkFrom('partition.mscz'), 'mscz');
  assert.strictEqual(scoretkFrom('partition.mscx'), 'mscx');
  assert.strictEqual(scoretkFrom('chanson.ly'), 'ly');
  assert.strictEqual(scoretkFrom('chanson.lilypond'), 'lilypond');
  assert.strictEqual(scoretkFrom('chanson.abc'), 'abc');
  assert.strictEqual(scoretkFrom('transcription.mid'), 'midi');
  assert.strictEqual(scoretkFrom('transcription.midi'), 'midi');
  assert.strictEqual(scoretkFrom('kyrie.gabc'), 'gabc');
});

test('extension insensible à la casse et nom sans extension', () => {
  const { scoretkFrom } = loadFormats();
  assert.strictEqual(scoretkFrom('PARTITION.MSCZ'), 'mscz');
  assert.strictEqual(scoretkFrom('Chanson.LY'), 'ly');
  assert.strictEqual(scoretkFrom('Chanson.Abc'), 'abc');
  assert.strictEqual(scoretkFrom('Transcription.MID'), 'midi');
  assert.strictEqual(scoretkFrom('sans-extension'), undefined);
  assert.strictEqual(scoretkFrom(undefined), undefined);
});

test('cohérence : chaque extension scoretk a un `from`, chaque MIME une extension connue', () => {
  const formats = loadFormats();
  const known = new Set(formats.extensions);

  // Un format peut être direct et scoretk (gabc) : `extensions` est l'union
  // sans doublon des deux listes.
  assert.deepStrictEqual([...formats.extensions].sort(),
    [...new Set(formats.baseExtensions.concat(formats.scoretkExtensions))].sort());

  for (const ext of formats.scoretkExtensions) {
    assert.ok(known.has(ext), `extension scoretk inconnue : ${ext}`);
    assert.strictEqual(typeof formats.scoretkFrom(`fichier.${ext}`), 'string',
      `aucun \`from\` scoretk pour .${ext}`);
  }
  for (const ext of formats.baseExtensions) {
    if (formats.scoretkExtensions.includes(ext)) continue; // lisible et convertible
    assert.strictEqual(formats.scoretkFrom(`fichier.${ext}`), undefined,
      `.${ext} ne doit pas passer par scoretk`);
  }

  const mimes = Object.entries(formats.mimeExtensions);
  assert.ok(mimes.length > 0, 'table MIME vide');
  for (const [type, ext] of mimes) {
    assert.ok(type.includes('/'), `type MIME invalide : ${type}`);
    assert.ok(known.has(ext), `${type} pointe vers une extension inconnue : ${ext}`);
  }

  for (const [type, exts] of Object.entries(formats.fileHandlerAccept)) {
    assert.ok(Array.isArray(exts) && exts.length > 0, `${type} sans extension acceptée`);
    for (const dotted of exts) {
      assert.ok(dotted.startsWith('.') && known.has(dotted.slice(1)),
        `${type} accepte une extension inconnue : ${dotted}`);
    }
  }
  for (const item of formats.shareAccept) {
    if (item.startsWith('.')) {
      assert.ok(known.has(item.slice(1)), `share_target accepte une extension inconnue : ${item}`);
    }
  }
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
