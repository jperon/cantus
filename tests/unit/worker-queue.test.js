#!/usr/bin/env node
'use strict';

// Tests unitaires de la file d'attente du worker (src/worker.coffee) : les
// messages reçus avant l'initialisation du toolkit doivent être rejoués dans
// leur ordre d'arrivée. registerSource en fait partie : sinon un clearMovements
// mis en file puis rejoué efface la source enregistrée entre-temps, et
// « Source 0 inconnue dans le worker » apparaît plus tard.
//
// Le worker n'est pas un module : on l'évalue avec un `self` factice qui capture
// postMessage, puis on utilise les crochets __test exposés en mode Node.
//
// Usage : node tests/unit/worker-queue.test.js  (code 0 si tout passe, 1 sinon)

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const CoffeeScript = require('coffeescript');

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Voix</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note></measure>
  </part>
</score-partwise>`;

function loadWorker() {
  const file = path.join(__dirname, '..', '..', 'src', 'worker.coffee');
  const js = CoffeeScript.compile(fs.readFileSync(file, 'utf8'), { bare: true });
  const mod = { exports: {} };
  const posted = [];
  const self = {
    postMessage(msg) {
      posted.push(msg);
    },
    addEventListener() {},
    onmessage: null,
  };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', 'self', js)(mod, mod.exports, require, self);
  return { worker: mod.exports, self, posted };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('clearMovements puis registerSource avant ready : la source survit au flush', () => {
  const { worker, self, posted } = loadWorker();
  const hooks = worker.__test;

  // Rien n'est encore prêt : les deux messages partent en file, dans l'ordre.
  self.onmessage({ data: { type: 'clearMovements' } });
  self.onmessage({ data: { type: 'registerSource', sourceId: 0, xml: XML } });

  // Le toolkit devient disponible : notifyReady rejoue la file. Si clearMovements
  // est rejoué après que registerSource a été appliqué tout de suite, la source
  // disparaît : c'est exactement le bug « Source 0 inconnue dans le worker ».
  hooks.setToolkit({});
  hooks.notifyReady();

  const sources = hooks.getSources();
  assert.ok(sources[0], 'la source 0 doit encore être présente après le flush');
  assert.strictEqual(sources[0].xml, XML);
  assert.strictEqual(hooks.getPending().length, 0, 'la file doit être vidée');
  assert.ok(posted.some((msg) => msg.type === 'ready'), 'le message ready doit être posté');
});

test('registerSource avant ready puis flush : source disponible, sans clearMovements', () => {
  const { worker, self } = loadWorker();
  const hooks = worker.__test;

  self.onmessage({ data: { type: 'registerSource', sourceId: 1, xml: XML } });
  assert.strictEqual(hooks.getPending().length, 1);

  hooks.setToolkit({});
  hooks.notifyReady();

  assert.ok(hooks.getSources()[1], 'la source 1 doit être enregistrée après le flush');
});

test('clearMovements keepSources : source et lecture conservées', () => {
  const { worker, self } = loadWorker();
  const hooks = worker.__test;

  hooks.setToolkit({});
  self.onmessage({ data: { type: 'registerSource', sourceId: 0, xml: XML } });
  hooks.setSourcePlayback('0:expanded', { midi: 'AAA', timeline: { measures: [] } });

  self.onmessage({ data: { type: 'clearMovements', keepSources: true } });

  assert.ok(hooks.getSources()[0], 'la source doit survivre à un rechargement');
  assert.strictEqual(hooks.getSources()[0].xml, XML);
  assert.ok(hooks.getSourcePlayback()['0:expanded'],
    'le MIDI et la timeline scoretk doivent survivre à un rechargement');
});

test('clearMovements sans keepSources : tout est vidé', () => {
  const { worker, self } = loadWorker();
  const hooks = worker.__test;

  hooks.setToolkit({});
  self.onmessage({ data: { type: 'registerSource', sourceId: 0, xml: XML } });
  hooks.setSourcePlayback('0:expanded', { midi: 'AAA', timeline: { measures: [] } });

  self.onmessage({ data: { type: 'clearMovements' } });

  assert.strictEqual(Object.keys(hooks.getSources()).length, 0, 'les sources doivent être vidées');
  assert.strictEqual(Object.keys(hooks.getSourcePlayback()).length, 0,
    'les données de lecture doivent être vidées');
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
