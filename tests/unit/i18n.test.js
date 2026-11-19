#!/usr/bin/env node
'use strict';

// Tests unitaires de src/i18n.coffee et des dictionnaires src/i18n/*.coffee :
// interpolation, pluriel, repli vers l'anglais, clé absente de l'anglais
// (erreur visible et clé affichée), et cohérence stricte entre l'anglais
// (référence) et le français : mêmes clés, mêmes {paramètres}.
//
// Le module est évalué en CommonJS (module.exports), sans DOM ni navigateur.
//
// Usage : node tests/unit/i18n.test.js  (code 0 si tout passe, 1 sinon)

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const CoffeeScript = require('coffeescript');

function loadI18n() {
  const src = path.join(__dirname, '..', '..', 'src');
  const files = ['i18n.coffee', 'i18n/en.coffee', 'i18n/fr.coffee'];
  const js = CoffeeScript.compile(
    files.map((file) => fs.readFileSync(path.join(src, file), 'utf8')).join(''),
    { bare: true }
  );
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', js)(mod, mod.exports);
  return mod.exports;
}

const placeholders = (text) => {
  const found = new Set();
  for (const match of String(text).matchAll(/\{(\w+)\}/g)) found.add(match[1]);
  return [...found].sort();
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('langues présentes : anglais de référence puis français', () => {
  const i18n = loadI18n();
  assert.deepStrictEqual(i18n.languages(), [
    { code: 'en', name: 'English' },
    { code: 'fr', name: 'Français' },
  ]);
  assert.strictEqual(i18n.language(), 'en');
  assert.strictEqual(i18n.setLanguage('fr'), true);
  assert.strictEqual(i18n.language(), 'fr');
  assert.strictEqual(i18n.setLanguage('zz'), false);
  assert.strictEqual(i18n.language(), 'fr');
});

test('mêmes clés en français et en anglais', () => {
  const i18n = loadI18n();
  const en = Object.keys(i18n.messages('en')).sort();
  const fr = Object.keys(i18n.messages('fr')).sort();
  assert.deepStrictEqual(fr, en);
});

test('mêmes {paramètres} pour chaque clé', () => {
  const i18n = loadI18n();
  const en = i18n.messages('en');
  const fr = i18n.messages('fr');
  for (const key of Object.keys(en)) {
    assert.deepStrictEqual(
      placeholders(fr[key]), placeholders(en[key]),
      `paramètres divergents pour « ${key} »`
    );
  }
});

test('interpolation de {paramètres}', () => {
  const i18n = loadI18n();
  i18n.setLanguage('en');
  assert.strictEqual(
    i18n.t('errors.noCompatibleFile', { extensions: '.xml, .mxl' }),
    'No compatible file (.xml, .mxl)'
  );
  i18n.setLanguage('fr');
  assert.strictEqual(
    i18n.t('errors.sourceSkipped', { name: 'a.mscz', error: 'illisible' }),
    'Fichier ignoré (a.mscz) : illisible'
  );
  // Un paramètre absent laisse le marqueur tel quel.
  assert.match(i18n.t('errors.sharedRead'), /\{error\}/);
});

test('pluriel par Intl.PluralRules', () => {
  const i18n = loadI18n();
  i18n.setLanguage('en');
  assert.strictEqual(i18n.t('library.fileCount', { count: 1 }), '1 file');
  assert.strictEqual(i18n.t('library.fileCount', { count: 2 }), '2 files');
  i18n.setLanguage('fr');
  // En français, 0 et 1 sont au singulier.
  assert.strictEqual(i18n.t('library.fileCount', { count: 0 }), '0 fichier');
  assert.strictEqual(i18n.t('library.fileCount', { count: 1 }), '1 fichier');
  assert.strictEqual(i18n.t('library.fileCount', { count: 2 }), '2 fichiers');
  assert.strictEqual(
    i18n.t('tempo.unit.quarter', { count: 80 }), 'noires'
  );
});

test('clé absente d’une langue : repli sur l’anglais', () => {
  const i18n = loadI18n();
  i18n.registerLanguage('zz', 'Test', {});
  assert.strictEqual(i18n.setLanguage('zz'), true);
  assert.strictEqual(i18n.t('settings.title'), 'Settings');
});

test('clé absente de l’anglais : erreur en console et clé affichée', () => {
  const i18n = loadI18n();
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    assert.strictEqual(i18n.t('cle.inexistante'), 'cle.inexistante');
  } finally {
    console.error = original;
  }
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /cle\.inexistante/);
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
