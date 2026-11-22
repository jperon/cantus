#!/usr/bin/env node
'use strict';

// Vérifie l'ordonnancement daté du moteur d'échantillons : chaque note part
// avec start(when, offset, duration) à l'instant exact de la partition,
// playbackRate porte la hauteur (transposition comprise), la boucle et
// l'enveloppe sont programmées sur les nœuds natifs. Pause, seek, stop et
// transposition coupent immédiatement (fondu < 10 ms) sans purge différée.
//
// Usage : node tests/unit/audio-schedule.test.js

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
const approx = (actual, expected, label, eps = 2e-3) => {
  assert.ok(Math.abs(actual - expected) <= eps,
    `${label} : attendu ${expected}, obtenu ${actual}`);
};

const NOTES = [
  { start: 0.10, dur: 0.10, pitch: 60, velocity: 90 },
  { start: 0.35, dur: 0.15, pitch: 62, velocity: 90 },
  { start: 0.70, dur: 0.10, pitch: 64, velocity: 90 },
];

function noteZone(extra = {}) {
  return {
    keyLo: 0, keyHi: 127, velLo: 0, velHi: 127,
    root: 60, tune: 0, offset: 0, frames: 32000,
    loop: false, loopStart: 0, loopEnd: 0,
    gain: 1, attack: 0.005, hold: 0, decay: 0.1,
    sustain: 0.8, release: 0.2, ...extra,
  };
}

function manifestWith(zone) {
  return {
    version: 1,
    source: { name: 'test', license: 'MIT' },
    programs: {
      0: { file: '0.ogg', rate: 32000, zones: [zone] },
      drums: { file: 'drums.ogg', rate: 32000, zones: [zone] },
    },
  };
}

function install(zone = noteZone()) {
  const tracks = [{
    index: 0,
    channel: 0,
    program: 0,
    notes: NOTES,
  }];
  const harness = fake.installWindow({
    midi: { duration: 1000, tracks },
    manifest: manifestWith(zone),
  });
  const engine = audio.createEngine();
  engine.load({ midi: 'x', duration: 1000, segments: [{ fromMs: 0, toMs: 1000, offsetMs: 0 }] });
  return { engine, harness, ctx: () => harness.context() };
}

function startCtxTime(engine, ctx) {
  return ctx.currentTime - engine.position();
}

function bufferSources(counters) {
  return counters.sources;
}

function sourceForPitch(counters, pitch) {
  const rate = Math.pow(2, (pitch - 60) / 12);
  return bufferSources(counters).find((source) =>
    Math.abs(source.playbackRate.value - rate) < 1e-6);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('start(when, offset, duration) à l’instant exact de chaque note', async () => {
  const { engine, harness, ctx } = install();
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'samples');
    await sleep(700);
    const live = ctx();
    const base = startCtxTime(engine, live);
    assert.strictEqual(bufferSources(harness.counters).length, 3, 'trois notes programmées');
    for (const note of NOTES) {
      const source = sourceForPitch(harness.counters, note.pitch);
      assert.ok(source, `source pour la hauteur ${note.pitch}`);
      approx(source.started.when, base + note.start, `début de la note ${note.pitch}`);
      approx(source.started.offset, 0, 'offset dans le tampon');
      approx(source.started.duration, 1, 'durée de zone (32000 / 32000)');
      // Le stop est placé après l'enveloppe : fin musicale + relâchement.
      const end = source.started.when + Math.max(0.03, note.dur);
      approx(source.stopped, end + 0.2 + 0.02, `arrêt de la note ${note.pitch}`, 5e-3);
    }
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('playbackRate : hauteur relative à la root key, transposition comprise', async () => {
  const { engine, harness, ctx } = install();
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'samples');
    await sleep(450);
    // La note 62 (ré) est deux demi-tons au-dessus de la root 60.
    const source = sourceForPitch(harness.counters, 62);
    assert.ok(source, 'source de la note 62');
    approx(source.playbackRate.value, Math.pow(2, 2 / 12), 'rapport de hauteur', 1e-9);
    // Transposition : toutes les hauteurs montent de 2 demi-tons, les
    // sources précédentes sont coupées et la lecture repart aussitôt.
    const before = bufferSources(harness.counters).length;
    const cutAt = ctx().currentTime;
    engine.setTranspose(2);
    for (const old of bufferSources(harness.counters).slice(0, before)) {
      assert.ok(old.stopped !== null, 'toute source active est arrêtée');
      approx(old.stopped, cutAt + 0.008 + 0.001, 'fondu de coupure ≤ 10 ms', 5e-3);
    }
    await sleep(120);
    const after = bufferSources(harness.counters).slice(before);
    assert.ok(after.length > 0, 'la lecture reprend immédiatement');
    const rates = after.map((source) => source.playbackRate.value);
    // À la position de reprise (~0,45 s), la prochaine note est 64 (0,70 s),
    // jouée deux demi-tons plus haut : 66.
    assert.ok(rates.some((rate) => Math.abs(rate - Math.pow(2, 6 / 12)) < 1e-6),
      'une note transposée de 64 vers 66 est jouée');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('enveloppe : attaque, tenue, décroissance, relâchement sur le GainNode', async () => {
  const { engine, harness } = install();
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'samples');
    await sleep(220);
    const source = sourceForPitch(harness.counters, 60);
    assert.ok(source, 'source de la note 60');
    const gain = source.destinations[0];
    assert.ok(gain, 'la source passe par un GainNode d’enveloppe');
    const ops = gain.gain.ops;
    assert.strictEqual(ops[0][0], 'set', 'départ à zéro');
    assert.strictEqual(ops[0][1], 0);
    const attack = ops.find((op) => op[0] === 'linear');
    assert.ok(attack && attack[2] > ops[0][2], 'rampe d’attaque après le départ');
    assert.ok(ops.some((op) => op[0] === 'cancel'), 'les rampes sont coupées à la fin musicale');
    const release = ops.find((op) => op[0] === 'exponential');
    assert.ok(release && release[1] > 0 && release[1] < 0.001, 'relâchement exponentiel vers zéro');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('boucle : loopStart/loopEnd en secondes, offset de zone, durée libre', async () => {
  const zone = noteZone({
    frames: 24000, loop: true, loopStart: 1000, loopEnd: 20000,
    offset: 0, release: 0.15,
  });
  const { engine, harness } = install(zone);
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'samples');
    await sleep(220);
    const source = sourceForPitch(harness.counters, 60);
    assert.ok(source, 'source de la note 60');
    assert.strictEqual(source.loop, true, 'la source boucle');
    approx(source.loopStart, 1000 / 32000, 'loopStart', 1e-9);
    approx(source.loopEnd, 20000 / 32000, 'loopEnd', 1e-9);
    assert.strictEqual(source.started.duration, undefined,
      'une source bouclée n’est pas limitée à la longueur de zone');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('pause : stop immédiat avec fondu, reprise sans attente', async () => {
  const { engine, harness, ctx } = install();
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'samples');
    await sleep(130);
    const before = bufferSources(harness.counters).length;
    assert.ok(before > 0, 'des notes sont programmées');
    const cutAt = ctx().currentTime;
    engine.pause();
    for (const source of bufferSources(harness.counters).slice(0, before)) {
      assert.ok(source.stopped !== null, 'source coupée');
      approx(source.stopped, cutAt + 0.008 + 0.001, 'fondu de pause', 5e-3);
    }
    engine.play(0);
    await sleep(60);
    assert.ok(bufferSources(harness.counters).length > before,
      'les notes repartent dès le premier tick, sans purge différée');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('seek : les notes de l’ancienne position sont coupées, les nouvelles partent', async () => {
  const { engine, harness, ctx } = install();
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'samples');
    await sleep(200);
    const before = bufferSources(harness.counters).length;
    const cutAt = ctx().currentTime;
    engine.seek(0.6);
    for (const source of bufferSources(harness.counters).slice(0, before)) {
      assert.ok(source.stopped !== null, 'source de l’ancienne position coupée');
      approx(source.stopped, cutAt + 0.009, 'fondu de seek', 5e-3);
    }
    await sleep(80);
    const after = bufferSources(harness.counters).slice(before);
    assert.ok(after.length > 0, 'les notes après 0,6 s sont programmées');
    const base = startCtxTime(engine, ctx());
    assert.ok(after.every((source) => source.started.when >= base + 0.6 - 0.01),
      'aucune note antérieure au seek');
    assert.ok(after.some((source) => Math.abs(source.started.when - (base + 0.70)) < 0.01),
      'la note à 0,70 s part à sa nouvelle échéance');
  } finally {
    engine.destroy();
    harness.restore();
  }
});

test('stop : toutes les sources coupées, position revenue à zéro', async () => {
  const { engine, harness, ctx } = install();
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'samples');
    await sleep(130);
    const cutAt = ctx().currentTime;
    engine.stop();
    assert.strictEqual(engine.position(), 0, 'position remise à zéro');
    assert.strictEqual(engine.isPlaying(), false);
    for (const source of bufferSources(harness.counters)) {
      assert.ok(source.stopped !== null, 'toutes les sources sont arrêtées');
      approx(source.stopped, cutAt + 0.009, 'fondu d’arrêt', 5e-3);
    }
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
