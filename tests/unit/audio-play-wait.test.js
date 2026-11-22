#!/usr/bin/env node
'use strict';

// Vérifie que api.play attend la résolution de ensureEngine() (manifeste et
// décodage des échantillons utilisés) avant de lancer l'horloge : aucune note
// d'oscillateur ne part pendant un décodage lent, et un pause ou un seek
// survenu pendant l'attente est respecté. Les instruments déjà décodés ne le
// sont jamais deux fois.
//
// Usage : node tests/unit/audio-play-wait.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const CoffeeScript = require('coffeescript');
const fake = require('./audio-fake');

function loadAudio() {
  const file = path.join(__dirname, '..', '..', 'src', 'audio.coffee');
  const js = CoffeeScript.compile(fs.readFileSync(file, 'utf8'), { bare: true });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
  return mod.exports;
}

const audio = loadAudio();
const { sleep, waitForMode } = fake;
const SLOW_DECODE_MS = 120;

const TRACKS = [{
  index: 0,
  channel: 0,
  program: 0,
  notes: [
    { start: 0.05, dur: 0.2, pitch: 60, velocity: 90 },
    { start: 0.55, dur: 0.2, pitch: 62, velocity: 90 },
  ],
}];

function install(extra = {}) {
  return fake.installWindow({
    midi: { duration: 1000, tracks: TRACKS },
    programs: ['0'],
    decodeDelay: SLOW_DECODE_MS,
    ...extra,
  });
}

function loadEngine() {
  const engine = audio.createEngine();
  engine.load({ midi: 'x', duration: 1000, segments: [{ fromMs: 0, toMs: 1000, offsetMs: 0 }] });
  return engine;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('play : position figée pendant le décodage, aucune note d’oscillateur', async () => {
  const harness = install();
  const engine = loadEngine();
  try {
    engine.startNoteLog();
    engine.play(0);
    assert.strictEqual(engine.isPlaying(), true, 'state.playing reste vrai pendant l’attente');
    assert.strictEqual(engine.getEngineMode(), null, 'moteur pas encore prêt');
    await sleep(SLOW_DECODE_MS / 2);
    assert.strictEqual(engine.position(), 0, 'position figée sur from pendant l’attente');
    assert.strictEqual(harness.counters.oscillators.length, 0,
      'aucun oscillateur avant la fixation du mode');
    assert.strictEqual(harness.counters.sources.length, 0,
      'aucune source programmée avant la fixation du mode');
    assert.strictEqual(await waitForMode(engine), 'samples');
    await sleep(300);
    assert.ok(harness.counters.sources.length > 0, 'les échantillons partent une fois prêts');
    assert.strictEqual(harness.counters.oscillators.length, 0, 'toujours aucun oscillateur');
    assert.ok(engine.position() > 0, 'la position avance après le départ de l’horloge');
    const log = engine.getScheduledNotes();
    assert.ok(log.length > 0, 'des notes ont été ordonnancées');
    assert.ok(log.every((n) => n.offset >= n.start - 0.001),
      'l’ordonnanceur part de la position de départ');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('play : pause pendant l’attente du moteur -> rien ne démarre', async () => {
  const harness = install();
  const engine = loadEngine();
  try {
    engine.play(0);
    await sleep(SLOW_DECODE_MS / 3);
    engine.pause();
    assert.strictEqual(engine.isPlaying(), false, 'pause prise en compte pendant l’attente');
    assert.strictEqual(engine.position(), 0, 'position conservée à la pause');
    assert.strictEqual(await waitForMode(engine), 'samples', 'le moteur finit de charger');
    await sleep(250);
    assert.strictEqual(harness.counters.sources.length, 0,
      'aucune source après une pause pendant le chargement');
    assert.strictEqual(harness.counters.oscillators.length, 0, 'aucun oscillateur');
    assert.strictEqual(engine.isPlaying(), false, 'lecture toujours en pause');
    assert.strictEqual(engine.getScheduledNotes().length, 0, 'aucune note ordonnancée');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('play : seek pendant l’attente -> départ à la nouvelle position', async () => {
  const harness = install();
  const engine = loadEngine();
  try {
    engine.startNoteLog();
    engine.play(0);
    await sleep(SLOW_DECODE_MS / 3);
    engine.seek(0.5);
    assert.strictEqual(engine.position(), 0.5, 'position déplacée pendant l’attente');
    assert.strictEqual(await waitForMode(engine), 'samples');
    await sleep(200);
    assert.ok(engine.position() >= 0.5, 'l’horloge part de la position demandée');
    const log = engine.getScheduledNotes();
    assert.ok(log.length > 0, 'des notes ont été ordonnancées');
    assert.ok(log.every((n) => n.start >= 0.5 && n.offset >= n.start - 0.001),
      'aucune note antérieure au seek n’est jouée');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('load sans play : contexte créé, instruments préchargés une seule fois', async () => {
  const harness = install({ initialState: 'suspended' });
  const engine = audio.createEngine();
  try {
    engine.load({ midi: 'x', duration: 1000, segments: [{ fromMs: 0, toMs: 1000, offsetMs: 0 }] });
    assert.strictEqual(harness.counters.contexts, 1, 'un AudioContext créé au chargement');
    assert.strictEqual(engine.getEngineMode(), null, 'chargement en cours, pas encore de mode');
    assert.strictEqual(await waitForMode(engine), 'samples', 'moteur chargé sans play');
    assert.strictEqual(harness.counters.decodes, 1, 'un seul décodage');
    assert.deepStrictEqual(harness.counters.sampleReads, ['0'], 'un seul instrument lu');
    engine.play(0);
    await sleep(50);
    assert.strictEqual(harness.counters.decodes, 1, 'play ne redécode pas');
    assert.strictEqual(harness.counters.sampleReads.length, 1, 'play ne relit pas');
    assert.strictEqual(harness.counters.contexts, 1, 'play ne recrée pas le contexte');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('load répété pendant le décodage : un seul chargement partagé', async () => {
  const harness = install();
  const engine = audio.createEngine();
  const data = { midi: 'x', duration: 1000, segments: [{ fromMs: 0, toMs: 1000, offsetMs: 0 }] };
  try {
    engine.load(data);
    engine.load(data);
    assert.strictEqual(await waitForMode(engine), 'samples');
    assert.strictEqual(harness.counters.contexts, 1, 'un seul contexte');
    assert.strictEqual(harness.counters.decodes, 1, 'un seul décodage');
    assert.strictEqual(harness.counters.sampleReads.length, 1, 'un seul téléchargement');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

(async () => {
  let passed = 0;
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
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
})();
