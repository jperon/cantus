#!/usr/bin/env node
'use strict';

// Vérifie le chargement paresseux des échantillons : seuls les programmes
// présents dans la partition sont lus et décodés, une seule fois par session,
// et un manifeste absent ou illisible bascule sur l'oscillateur de repli.
//
// Usage : node tests/unit/audio-load.test.js

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

function track(index, program, channel = 0, pitch = 60) {
  return {
    index,
    channel,
    program,
    notes: [{ start: 0.1, dur: 0.4, pitch, velocity: 80 }],
  };
}

function midi(tracks) {
  return { duration: 1000, tracks };
}

function loadEngine(tracks) {
  const engine = audio.createEngine();
  engine.load({ midi: 'x', duration: 1000, segments: [{ fromMs: 0, toMs: 1000, offsetMs: 0 }] });
  return engine;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('seuls les programmes utilisés par la partition sont décodés', async () => {
  const tracks = [track(0, 0), track(1, 10)];
  const harness = fake.installWindow({ midi: midi(tracks), programs: ['0', '10', '55'] });
  const engine = loadEngine(tracks);
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'samples');
    assert.deepStrictEqual(harness.counters.sampleReads.sort(), ['0', '10'],
      'seuls les programmes 0 et 10 sont lus, jamais 55');
    assert.strictEqual(harness.counters.decodes, 2, 'un décodage par programme utilisé');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('un programme partagé par trois pistes n’est décodé qu’une fois', async () => {
  const tracks = [track(0, 0, 0, 60), track(1, 0, 1, 62), track(2, 0, 2, 64)];
  const harness = fake.installWindow({ midi: midi(tracks), programs: ['0'] });
  const engine = loadEngine(tracks);
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'samples');
    assert.strictEqual(harness.counters.sampleReads.filter((key) => key === '0').length, 1,
      'un seul téléchargement du programme 0');
    assert.strictEqual(harness.counters.decodes, 1, 'un seul décodage');
    assert.strictEqual(harness.counters.contexts, 1, 'un seul AudioContext');
    await sleep(60);
    assert.ok(harness.counters.sources.length >= 3, 'les trois pistes jouent un échantillon');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('pistes de percussion : chargement du kit, pas du programme mélodique', async () => {
  const tracks = [track(0, 0), track(1, 0, 9, 36)];
  const harness = fake.installWindow({ midi: midi(tracks), programs: ['0'] });
  const engine = loadEngine(tracks);
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'samples');
    const reads = harness.counters.sampleReads.sort();
    assert.deepStrictEqual(reads, ['0', 'drums'], 'programme mélodique + kit de batterie');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('load répété : les échantillons ne sont pas redécodés', async () => {
  const tracks = [track(0, 0)];
  const harness = fake.installWindow({ midi: midi(tracks), programs: ['0'] });
  const engine = audio.createEngine();
  const data = { midi: 'x', duration: 1000, segments: [{ fromMs: 0, toMs: 1000, offsetMs: 0 }] };
  try {
    engine.load(data);
    engine.load(data);
    assert.strictEqual(await waitForMode(engine), 'samples');
    assert.strictEqual(harness.counters.decodes, 1, 'un seul décodage malgré deux load()');
    assert.strictEqual(harness.counters.contexts, 1, 'un seul contexte');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('manifeste absent : repli immédiat sur l’oscillateur', async () => {
  const tracks = [track(0, 0)];
  const harness = fake.installWindow({ midi: midi(tracks), manifest: null });
  const engine = loadEngine(tracks);
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'oscillator');
    await sleep(80);
    assert.strictEqual(harness.counters.decodes, 0, 'aucun décodage');
    assert.ok(harness.counters.oscillators.length > 0, 'des oscillateurs de repli sont créés');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('échantillons illisibles : repli sur l’oscillateur sans blocage', async () => {
  const tracks = [track(0, 0)];
  const harness = fake.installWindow({ midi: midi(tracks), programs: ['0'], decodeFails: true });
  const engine = loadEngine(tracks);
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'oscillator');
    await sleep(80);
    assert.ok(harness.counters.oscillators.length > 0, 'la lecture continue en oscillateur');
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
