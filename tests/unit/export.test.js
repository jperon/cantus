#!/usr/bin/env node
'use strict';

// Tests unitaires du remplacement des programmes General MIDI avant export
// (src/worker.coffee) : programme existant, midi-instrument absent, batterie
// ignorée, et association libellé de voix -> id de score-part.
//
// Le worker n'est pas un module : on l'évalue avec un `self` factice, comme
// tests/unit/worker-queue.test.js, puis on appelle les fonctions pures
// exposées en mode Node.
//
// Usage : node tests/unit/export.test.js  (code 0 si tout passe, 1 sinon)

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const CoffeeScript = require('coffeescript');

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1">
      <part-name>Soprano</part-name>
      <score-instrument id="P1-I1"><instrument-name>Soprano</instrument-name></score-instrument>
      <midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>1</midi-program></midi-instrument>
    </score-part>
    <score-part id="P2">
      <part-name>Alto</part-name>
    </score-part>
    <score-part id="P3">
      <part-name>Percussions</part-name>
      <score-instrument id="P3-I1"><instrument-name>Percussions</instrument-name></score-instrument>
      <midi-instrument id="P3-I1"><midi-channel>10</midi-channel><midi-program>1</midi-program></midi-instrument>
    </score-part>
    <score-part id="P4">
      <part-name>Ténor</part-name>
      <score-instrument id="P4-I1"><instrument-name>Ténor</instrument-name></score-instrument>
      <midi-instrument id="P4-I1"><midi-channel>3</midi-channel><volume>78.7402</volume><pan>0</pan></midi-instrument>
    </score-part>
    <score-part id="P5">
      <part-name>Basse</part-name>
      <score-instrument id="P5-I1"><instrument-name>Basse</instrument-name></score-instrument>
      <midi-instrument id="P5-I1"><midi-channel>4</midi-channel><midi-program>43</midi-program></midi-instrument>
    </score-part>
  </part-list>
</score-partwise>`;

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

const worker = loadWorker();
const { replaceMidiPrograms, programsByPartId } = worker;

// Extrait le bloc complet d'un score-part par son id.
function scorePart(xml, id) {
  const match = xml.match(new RegExp(`<score-part\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</score-part>`));
  assert.ok(match, `score-part ${id} introuvable`);
  return match[0];
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('programme existant : remplacé, numéroté à partir de 1 dans MusicXML', () => {
  const out = replaceMidiPrograms(XML, { P1: 73 });
  assert.match(scorePart(out, 'P1'), /<midi-program>74<\/midi-program>/);
  assert.doesNotMatch(scorePart(out, 'P1'), /<midi-program>1<\/midi-program>/);
  // Le reste du score-part est conservé.
  assert.match(scorePart(out, 'P1'), /<midi-channel>1<\/midi-channel>/);
});

test('score-part sans midi-instrument : score-instrument et midi-instrument créés', () => {
  const out = replaceMidiPrograms(XML, { P2: 40 });
  const part = scorePart(out, 'P2');
  assert.match(part, /<part-name>Alto<\/part-name>/);
  assert.match(part, /<score-instrument id="P2-I1"><instrument-name>Alto<\/instrument-name><\/score-instrument>/);
  assert.match(part, /<midi-instrument id="P2-I1"><midi-program>41<\/midi-program><\/midi-instrument>/);
  // Ordre du schéma : score-instrument puis midi-instrument, après part-name.
  assert.ok(part.indexOf('<part-name>') < part.indexOf('<score-instrument'));
  assert.ok(part.indexOf('<score-instrument') < part.indexOf('<midi-instrument'));
});

test('midi-instrument présent sans midi-program : ajouté avant volume/pan', () => {
  const out = replaceMidiPrograms(XML, { P4: 51 });
  const part = scorePart(out, 'P4');
  assert.match(part, /<midi-program>52<\/midi-program><volume>/);
  assert.match(part, /<midi-channel>3<\/midi-channel><midi-program>52<\/midi-program>/);
});

test('batterie (canal MIDI 10) ignorée', () => {
  const out = replaceMidiPrograms(XML, { P3: 0 });
  assert.strictEqual(scorePart(out, 'P3'), scorePart(XML, 'P3'));
});

test('score-part non visé et programme invalide inchangés', () => {
  const out = replaceMidiPrograms(XML, { P5: 128 });
  assert.strictEqual(scorePart(out, 'P5'), scorePart(XML, 'P5'));
  assert.strictEqual(scorePart(out, 'P1'), scorePart(XML, 'P1'));
});

test('programmes par libellé de voix : libellés du document -> ids score-part', () => {
  const ids = programsByPartId(XML, { Alto: 40, Percussions: 0, Inconnue: 5 });
  assert.deepStrictEqual(ids, { P2: 40, P3: 0 });

  // Libellé dupliqué : même convention que partLabels côté page (« #2 »).
  const duplicate = XML.replace(
    '<part-name>Basse</part-name>',
    '<part-name>Soprano</part-name>'
  );
  const mapped = programsByPartId(duplicate, { 'Soprano #2': 60 });
  assert.deepStrictEqual(mapped, { P5: 60 });
});

test('XML sans score-part : rendu inchangé, sans exception', () => {
  const plain = '<score-partwise version="3.1"></score-partwise>';
  assert.strictEqual(replaceMidiPrograms(plain, { P1: 0 }), plain);
  assert.strictEqual(replaceMidiPrograms(null, { P1: 0 }), null);
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
    console.log(`  ÉCHEC ${name}`);
  }
}

console.log(`\n${passed}/${tests.length} test(s) réussi(s)`);
if (failures.length) {
  for (const { name, err } of failures) {
    console.error(`\n--- ${name} ---\n${err.stack || err}`);
  }
  process.exit(1);
}
