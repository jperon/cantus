#!/usr/bin/env node
'use strict';

// Vérifie l'ordonnancement daté de SpessaSynth : noteOn et noteOff partent à
// l'avance avec l'heure du processeur (échéance - décalage d'horloge du
// worklet), et pause/seek/transposition détruisent le worklet pour purger sa
// file d'événements (aucune note fantôme ne repart après le transport).
//
// Usage : node tests/unit/audio-schedule.test.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const CoffeeScript = require('coffeescript');

function loadAudio() {
  const file = path.join(__dirname, '..', '..', 'src', 'audio.coffee');
  const js = CoffeeScript.compile(fs.readFileSync(file, 'utf8'), { bare: true });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
  return mod.exports;
}

const audio = loadAudio();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OFFSET = 0.25;

class FakeParam {
  constructor() { this.value = 0; }
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
  cancelScheduledValues() {}
}
class FakeNode {
  connect() { return this; }
  disconnect() {}
}
class FakeGain extends FakeNode {
  constructor() { super(); this.gain = new FakeParam(); }
}
class FakeSource extends FakeNode {
  constructor() { super(); this.frequency = new FakeParam(); }
  start() {}
  stop() {}
}

function makeContext(counters) {
  return class FakeContext {
    constructor() {
      counters.contexts += 1;
      this.t0 = Date.now();
      this.state = 'running';
      this.destination = new FakeNode();
      this.audioWorklet = { addModule: async () => { counters.modules += 1; } };
      counters.lastCtx = this;
    }
    get currentTime() { return (Date.now() - this.t0) / 1000; }
    createGain() { return new FakeGain(); }
    createOscillator() { return new FakeSource(); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { return Promise.resolve(); }
  };
}

function makeSynth(counters) {
  return class FakeSynth {
    constructor(ctx) {
      counters.synths += 1;
      this.ctx = ctx;
      this.isReady = Promise.resolve();
      this.notesOn = [];
      this.notesOff = [];
      this.stopped = 0;
      this.destroyed = false;
      this.soundBankManager = { addSoundBank: () => sleep(5) };
      this.midiChannels = Array.from({ length: 16 }, () => ({ setDrums() {} }));
      counters.last = this;
      // Message du processeur portant son horloge, pour mesurer le décalage
      // avec AudioContext.currentTime (le wrapper est posé juste après le
      // constructeur).
      setTimeout(() => {
        this.handleMessages([{ type: 'isFullyInitialized', currentTime: this.ctx.currentTime - OFFSET }]);
      }, 5);
    }
    handleMessages() {}
    programChange() {}
    noteOn(channel, pitch, velocity, options = {}) {
      this.notesOn.push({ channel, pitch, velocity, time: options.time });
    }
    noteOff(channel, pitch, options = {}) {
      this.notesOff.push({ channel, pitch, time: options.time });
    }
    stopAll() { this.stopped += 1; }
    connectChannel(node) { return node; }
    disconnectChannel() {}
    destroy() { this.destroyed = true; }
  };
}

function installWindow(counters) {
  const previous = global.window;
  const tracks = [{
    index: 0,
    channel: 0,
    program: 0,
    notes: [
      { start: 0.10, dur: 0.10, pitch: 60, velocity: 90 },
      { start: 0.35, dur: 0.15, pitch: 62, velocity: 90 },
      { start: 0.70, dur: 0.10, pitch: 64, velocity: 90 },
    ],
  }];
  global.window = {
    AudioContext: makeContext(counters),
    __musicaMidi: {
      parseBase64: () => ({ duration: 1, tracks }),
      decodeBase64: () => new Uint8Array([0, 0, 0, 0]),
    },
    __musicaSoundfontB64: 'AAAA',
    __musicaSpessaWorkletUrl: 'fake-worklet.js',
    __musicaSpessa: { WorkletSynthesizer: makeSynth(counters) },
  };
  return () => { global.window = previous; };
}

async function waitForMode(engine, timeout = 3000) {
  const started = Date.now();
  while (engine.getEngineMode() === null && Date.now() - started < timeout) await sleep(5);
  return engine.getEngineMode();
}

function loadEngine() {
  const engine = audio.createEngine();
  engine.load({ midi: 'x', duration: 1000, segments: [{ fromMs: 0, toMs: 1000, offsetMs: 0 }] });
  return engine;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const approx = (actual, expected, msg, eps = 0.03) => {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg} : attendu ${expected}, obtenu ${actual}`);
};

test('noteOn et noteOff partent à l’avance avec l’heure du processeur', async () => {
  const counters = { contexts: 0, modules: 0, synths: 0, last: null, lastCtx: null };
  const restore = installWindow(counters);
  const engine = loadEngine();
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'soundfont');
    await sleep(450);
    const synth = counters.last;
    assert.ok(synth.notesOn.length >= 2, 'plusieurs noteOn envoyés');
    assert.ok(synth.notesOff.length >= 1, 'des noteOff sont envoyés à l’avance');
    const startCtxTime = counters.lastCtx.currentTime - engine.position();
    const notes = engine.getNotes();
    for (const sent of synth.notesOn) {
      const note = notes.find((n) => Math.round(n.pitch) === sent.pitch);
      assert.ok(note, `note ${sent.pitch} retrouvée`);
      assert.ok(Number.isFinite(sent.time), 'noteOn daté');
      approx(sent.time, startCtxTime + note.start - OFFSET, `noteOn ${sent.pitch} datée dans l’horloge du processeur`);
    }
    for (const sent of synth.notesOff) {
      const note = notes.find((n) => Math.round(n.pitch) === sent.pitch);
      assert.ok(Number.isFinite(sent.time), 'noteOff daté');
      approx(sent.time, startCtxTime + note.start + Math.max(0.02, note.dur) - OFFSET,
        `noteOff ${sent.pitch} daté à la fin de la note`);
    }
  } finally {
    engine.destroy();
    restore();
  }
});

test('pause : stopAll immédiat puis différé, moteur conservé, aucune note fantôme', async () => {
  const counters = { contexts: 0, modules: 0, synths: 0, last: null, lastCtx: null };
  const restore = installWindow(counters);
  const engine = loadEngine();
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'soundfont');
    await sleep(120);
    const synth = counters.last;
    const sentBefore = synth.notesOn.length;
    assert.ok(sentBefore > 0, 'des notes ont été programmées');
    engine.pause();
    assert.strictEqual(synth.destroyed, false, 'le moteur reste chargé');
    assert.strictEqual(synth.stopped, 1, 'stopAll immédiat');
    assert.strictEqual(engine.getEngineMode(), 'soundfont', 'moteur toujours prêt');
    const countAfter = synth.notesOn.length;
    await sleep(400);
    assert.strictEqual(counters.last, synth, 'aucun nouveau worklet');
    assert.ok(synth.stopped >= 2, 'second stopAll après l’anticipation');
    assert.strictEqual(synth.notesOn.length, countAfter, 'aucun noteOn ne part après la pause');
  } finally {
    engine.destroy();
    restore();
  }
});

test('reprise immédiate après pause : rien n’est programmé avant la purge', async () => {
  const counters = { contexts: 0, modules: 0, synths: 0, last: null, lastCtx: null };
  const restore = installWindow(counters);
  const engine = loadEngine();
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'soundfont');
    await sleep(120);
    const synth = counters.last;
    engine.pause();
    const count = synth.notesOn.length;
    engine.play(0);
    await sleep(20);
    assert.strictEqual(engine.isPlaying(), true, 'lecture demandée');
    assert.strictEqual(synth.notesOn.length, count, 'aucune note de la nouvelle génération pendant la purge');
    await sleep(400);
    assert.strictEqual(counters.last, synth, 'toujours le même moteur');
    assert.ok(synth.notesOn.length > count, 'les notes repartent après la purge');
  } finally {
    engine.destroy();
    restore();
  }
});

test('transposition en lecture : purge puis reprise avec les nouvelles hauteurs', async () => {
  const counters = { contexts: 0, modules: 0, synths: 0, last: null, lastCtx: null };
  const restore = installWindow(counters);
  const engine = loadEngine();
  try {
    engine.play(0);
    assert.strictEqual(await waitForMode(engine), 'soundfont');
    await sleep(120);
    const synth = counters.last;
    const before = synth.notesOn.length;
    engine.setTranspose(2);
    assert.strictEqual(synth.destroyed, false, 'le moteur est conservé');
    assert.strictEqual(counters.last, synth, 'toujours le même worklet');
    await sleep(400);
    const after = synth.notesOn.slice(before);
    assert.ok(after.length > 0, 'la lecture a repris');
    assert.ok(after.every((n) => n.pitch >= 62), 'les notes jouées sont transposées');
    assert.ok(after.every((n) => n.velocity >= 1), 'vélocités valides');
    assert.ok(synth.stopped >= 2, 'stopAll immédiat puis différé');
  } finally {
    engine.destroy();
    restore();
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
