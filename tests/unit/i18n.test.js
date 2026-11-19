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
  // L'anglais d'abord (référence), puis tous les autres dictionnaires présents :
  // ajouter src/i18n/es.coffee suffit pour que la cohérence soit vérifiée.
  const others = fs.readdirSync(path.join(src, 'i18n'))
    .filter((file) => file.endsWith('.coffee') && file !== 'en.coffee')
    .sort();
  const files = ['i18n.coffee', 'i18n/en.coffee', ...others.map((file) => path.join('i18n', file))];
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
  const languages = i18n.languages();
  assert.strictEqual(languages[0].code, 'en');
  assert.strictEqual(languages[0].name, 'English');
  assert.deepStrictEqual(
    languages.find((lang) => lang.code === 'fr'),
    { code: 'fr', name: 'Français' }
  );
  assert.strictEqual(i18n.language(), 'en');
  assert.strictEqual(i18n.setLanguage('fr'), true);
  assert.strictEqual(i18n.language(), 'fr');
  assert.strictEqual(i18n.setLanguage('zz'), false);
  assert.strictEqual(i18n.language(), 'fr');
});

test('mêmes clés dans chaque dictionnaire et en anglais', () => {
  const i18n = loadI18n();
  const en = Object.keys(i18n.messages('en')).sort();
  for (const { code } of i18n.languages()) {
    if (code === 'en') continue;
    assert.deepStrictEqual(Object.keys(i18n.messages(code)).sort(), en,
      `clés divergentes pour « ${code} »`);
  }
});

test('mêmes {paramètres} pour chaque clé', () => {
  const i18n = loadI18n();
  const en = i18n.messages('en');
  for (const { code } of i18n.languages()) {
    if (code === 'en') continue;
    const dict = i18n.messages(code);
    for (const key of Object.keys(en)) {
      assert.deepStrictEqual(
        placeholders(dict[key]), placeholders(en[key]),
        `paramètres divergents pour « ${key} » en « ${code} »`
      );
    }
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

// L'application est concaténée en une seule portée CoffeeScript (build.js,
// APP_SOURCES) : une affectation dans une fonction à un nom déjà défini au
// niveau supérieur réécrit cette variable globale. C'est le bogue « TypeError:
// t is not a function » (une locale `t = Number mark.t` écrasait la fonction
// de traduction). On interdit donc toute affectation interne à un nom
// top-level qui porte une fonction (t, $, ...).
test('aucune affectation n’écrase une fonction globale de l’application', () => {
  const appDir = path.join(__dirname, '..', '..', 'src', 'app');
  const sources = new Map(
    fs.readdirSync(appDir)
      .filter((file) => file.endsWith('.coffee'))
      .sort()
      .map((file) => [file, fs.readFileSync(path.join(appDir, file), 'utf8')])
  );
  const functions = new Map();
  for (const [file, src] of sources) {
    for (const line of src.split('\n')) {
      const top = line.match(/^([A-Za-z_$][\w$]*)\s*=\s*(\(.*?\)\s*)?(->|=>)/);
      if (top) functions.set(top[1], file);
    }
  }
  const offenders = [];
  for (const [file, src] of sources) {
    src.split('\n').forEach((line, index) => {
      if (/^[ \t]*#/.test(line)) return;
      // Indentation > 0 : l'affectation est dans une fonction.
      const inner = line.match(/^[ \t]+([A-Za-z_$][\w$]*)\s*=(?!=)/);
      if (inner && functions.has(inner[1])) {
        offenders.push(
          `${file}:${index + 1} affecte « ${inner[1]} » (défini dans ${functions.get(inner[1])})`
        );
      }
    });
  }
  assert.deepStrictEqual(offenders, []);
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
