#!/usr/bin/env node
'use strict';

// Tests unitaires de src/app/accords-lilypond.coffee : analyse des noms
// d'accords LilyPond (chordmode, nederlands) trouvés dans les [alt:] du gabc,
// affichage en symbole usuel, transposition visuelle et réécriture du gabc.
//
// Le module est évalué en CommonJS, sans DOM ni navigateur.
//
// Usage : node tests/unit/accords-lilypond.test.js  (code 0 si tout passe, 1 sinon)

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const CoffeeScript = require('coffeescript');

function loadAccords() {
  const file = path.join(__dirname, '..', '..', 'src', 'app', 'accords-lilypond.coffee');
  const js = CoffeeScript.compile(fs.readFileSync(file, 'utf8'), { bare: true });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', js)(mod, mod.exports);
  return mod.exports;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Symbole affiché, transposé de `demiTons`.
function symbole(accords, texte, demiTons = 0) {
  const accord = accords.analyserAccord(texte);
  assert.ok(accord, `« ${texte} » devrait être un accord valide`);
  return accords.afficherAccord(accords.transposerAccord(accord, demiTons));
}

test('accords valides : symboles usuels', () => {
  const accords = loadAccords();
  assert.strictEqual(symbole(accords, 'fis:m7/a'), 'F♯m7/A');
  assert.strictEqual(symbole(accords, 'bes:maj7'), 'B♭maj7');
  assert.strictEqual(symbole(accords, 'c:7.9-'), 'C7♭9');
  assert.strictEqual(symbole(accords, 'c:m7.5-'), 'Cm7♭5');
  assert.strictEqual(symbole(accords, 'd:sus4.7'), 'D7sus4');
  assert.strictEqual(symbole(accords, 'e:dim7'), 'Edim7');
  assert.strictEqual(symbole(accords, 'g:aug'), 'Gaug');
  assert.strictEqual(symbole(accords, 'a:m'), 'Am');
  assert.strictEqual(symbole(accords, 'b:6'), 'B6');
  assert.strictEqual(symbole(accords, 'c:9'), 'C9');
});

test('noms nederlands et altérations : es, as, bes, isis, ees', () => {
  const accords = loadAccords();
  assert.strictEqual(symbole(accords, 'es:m'), 'E♭m');
  assert.strictEqual(symbole(accords, 'as:maj7'), 'A♭maj7');
  assert.strictEqual(symbole(accords, 'beses'), 'B♭♭');
  assert.strictEqual(symbole(accords, 'ees:m'), 'E♭m');
  assert.strictEqual(symbole(accords, 'fisis:m'), 'F♯♯m');
  assert.strictEqual(symbole(accords, 'bis'), 'B♯');
});

test('durée optionnelle ignorée', () => {
  const accords = loadAccords();
  assert.strictEqual(symbole(accords, 'c4:m7'), 'Cm7');
  assert.strictEqual(symbole(accords, 'a2.'), 'A');
  assert.strictEqual(symbole(accords, 'd4*3/2:sus2'), 'Dsus2');
});

test('basse : /fis et /+fis', () => {
  const accords = loadAccords();
  assert.strictEqual(symbole(accords, 'c:m7/+fis'), 'Cm7/F♯');
  assert.strictEqual(symbole(accords, 'bes:maj7/as'), 'B♭maj7/A♭');
});

test('modificateurs divers : retrait, quinte seule, septième majeure mineure', () => {
  const accords = loadAccords();
  assert.strictEqual(symbole(accords, 'c:7^3'), 'C7(no3)');
  assert.strictEqual(symbole(accords, 'c:5'), 'C5');
  assert.strictEqual(symbole(accords, 'c:m.maj'), 'CmMaj7');
  assert.strictEqual(symbole(accords, 'c:maj.9'), 'Cmaj9');
  assert.strictEqual(symbole(accords, 'c:m.maj.9'), 'CmMaj9');
  assert.strictEqual(symbole(accords, 'c:min'), 'Cm');
  assert.strictEqual(symbole(accords, 'c:sus'), 'Csus4');
});

test('texte ordinaire ou syntaxe invalide : null, sans erreur', () => {
  const accords = loadAccords();
  for (const texte of ['Gm', 'Organum', 'H', 'c:', 'c:huh', 'c:7/', 'c:7.', 'c:7..9', '', null]) {
    assert.strictEqual(accords.analyserAccord(texte), null, `« ${texte} » ne devrait pas être un accord`);
  }
});

test('transposition +2 : orthographe des altérations', () => {
  const accords = loadAccords();
  assert.strictEqual(symbole(accords, 'fis:m7/a', 2), 'G♯m7/B');
  assert.strictEqual(symbole(accords, 'bes:maj7', 2), 'Cmaj7');
  assert.strictEqual(symbole(accords, 'c:7.9-', 2), 'D7♭9');
  assert.strictEqual(symbole(accords, 'e:sus4', 2), 'F♯sus4');
  assert.strictEqual(symbole(accords, 'a:m', 2), 'Bm');
});

test('transposition descendante : bémols plutôt que doubles dièses', () => {
  const accords = loadAccords();
  assert.strictEqual(symbole(accords, 'gis:m', -1), 'Gm');
  assert.strictEqual(symbole(accords, 'e:m', -1), 'E♭m');
  assert.strictEqual(symbole(accords, 'es:maj7', -2), 'D♭maj7');
  assert.strictEqual(symbole(accords, 'fis:m', -2), 'Em');
  assert.strictEqual(symbole(accords, 'bes:maj7/a', -2), 'A♭maj7/G');
});

test('transposition +1 / -1 et octave', () => {
  const accords = loadAccords();
  assert.strictEqual(symbole(accords, 'c', 1), 'C♯');
  assert.strictEqual(symbole(accords, 'b', -1), 'B♭');
  assert.strictEqual(symbole(accords, 'fis:m7', 12), 'F♯m7');
  assert.strictEqual(symbole(accords, 'fis:m7', -12), 'F♯m7');
});

test('réécriture du gabc : option inactive inchangée, active symboles seuls', () => {
  const accords = loadAccords();
  const gabc = '%%\n(c4) ([alt:fis:m7/a]k)ý(g)ri(e) ([alt:Organum]le)([alt:bes:maj7]e) (::)';
  assert.strictEqual(accords.reecrireTexteGabc(gabc, { actif: false }), gabc);
  const actif = accords.reecrireTexteGabc(gabc, { actif: true, transpose: 2 });
  assert.ok(actif.includes('[alt:G♯m7/B]'), actif);
  assert.ok(actif.includes('[alt:Organum]'), actif);
  assert.ok(actif.includes('[alt:Cmaj7]'), actif);
  assert.ok(!actif.includes('fis:m7/a'), actif);
  assert.ok(!actif.includes('bes:maj7'), actif);
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`[OK] ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`[ÉCHEC] ${name}`);
    console.log(`   ${err.message.split('\n').join('\n   ')}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} test(s) unitaire(s) réussi(s)`);
process.exit(failures ? 1 : 0);
