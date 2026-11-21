#!/usr/bin/env node
'use strict';

// Vérifie que la banque SpessaSynth n'est chargée qu'UNE fois, quel que soit le
// nombre de pistes, et que chaque piste reçoit son programme GM sur son canal.
// On remplace window.__musicaSpessa et window.AudioContext par des doubles
// mesurant les appels à addSoundBank, programChange et noteOn.
//
// Usage : node tests/unit/audio-load.test.js

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
  constructor() { super(); this.playbackRate = new FakeParam(); this.frequency = new FakeParam(); }
  start() {}
  stop() {}
}
class FakeContext {
  constructor() {
    this.t0 = Date.now();
    this.state = 'running';
    this.destination = new FakeNode();
    this.audioWorklet = { addModule: async () => { this.moduleCalls += 1; } };
    this.moduleCalls = 0;
  }
  get currentTime() { return (Date.now() - this.t0) / 1000; }
  createGain() { return new FakeGain(); }
  createBufferSource() { return new FakeSource(); }
  createOscillator() { return new FakeSource(); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

// Faux synthétiseur : enregistre les programmes, les notes et les connexions
// de sorties de canal. `failBank` simule une banque illisible.
function makeFakeSynth(counters, failBank = false) {
  return class FakeSynth {
    constructor(ctx) {
      this.ctx = ctx;
      this.programs = [];
      this.notes = [];
      this.connected = [];
      this.stopped = 0;
      this.destroyed = false;
      counters.synths += 1;
      this.isReady = Promise.resolve();
      this.soundBankManager = {
        addSoundBank: () => {
          counters.banks += 1;
          return failBank
            ? Promise.reject(new Error('banque illisible'))
            : sleep(30);
        },
      };
      this.midiChannels = Array.from({ length: 16 }, () => ({ setDrums() {} }));
      counters.last = this;
    }
    programChange(channel, program) { this.programs.push({ channel, program }); }
    noteOn(channel, pitch, velocity) { this.notes.push({ channel, pitch, velocity }); }
    noteOff() {}
    stopAll() { this.stopped += 1; }
    connectChannel(node, channel) { this.connected.push(channel); return node; }
    disconnectChannel() {}
    destroy() { this.destroyed = true; }
  };
}

async function measure(trackCount, { failBank = false } = {}) {
  const counters = { banks: 0, synths: 0, last: null };
  const tracks = [];
  for (let i = 0; i < trackCount; i += 1) {
    tracks.push({
      index: i,
      channel: 0,
      program: i * 10,
      notes: [{ start: 0.2, dur: 0.4, pitch: 60 + i, velocity: 80 }],
    });
  }
  const previousWindow = global.window;
  global.window = {
    AudioContext: FakeContext,
    __musicaMidi: { parseBase64: () => ({ duration: 1, tracks }) },
    __musicaSoundfontB64: 'AAAA',
    __musicaSpessaWorkletUrl: 'fake-worklet.js',
    __musicaSpessa: { WorkletSynthesizer: makeFakeSynth(counters, failBank) },
  };
  const run = async () => {
    const engine = audio.createEngine();
    engine.load({ midi: 'x', duration: 1000, segments: [{ fromMs: 0, toMs: 1000, offsetMs: 0 }] });
    const started = Date.now();
    engine.play(0);
    while (engine.getEngineMode() === null && Date.now() - started < 3000) {
      await sleep(5);
    }
    // Laisse passer l'ordonnancement de la note (début 0,2 s) une fois le
    // moteur prêt : les premières notes ne partent plus en oscillateur.
    if (engine.getEngineMode() === 'soundfont') await sleep(350);
    const elapsed = Date.now() - started;
    const result = {
      elapsed,
      mode: engine.getEngineMode(),
      programs: engine.getProgramChanges(),
      assignments: engine.getChannelAssignments(),
      notes: counters.last ? counters.last.notes.slice() : [],
      connections: counters.last ? counters.last.connected.slice() : [],
    };
    engine.destroy();
    return result;
  };
  try {
    // Échauffement (JIT, timers) hors mesure : seuls le nombre de chargements
    // et le temps du second passage sont comparés.
    await run();
    counters.banks = 0;
    counters.synths = 0;
    counters.last = null;
    const result = await run();
    result.banks = counters.banks;
    result.synths = counters.synths;
    return result;
  } finally {
    global.window = previousWindow;
  }
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('addSoundBank appelé une seule fois pour 1 piste', async () => {
  const result = await measure(1);
  console.log(`       1 piste : ${result.banks} banque(s), ${result.synths} synthé(s), ${result.elapsed} ms, moteur ${result.mode}`);
  assert.strictEqual(result.banks, 1, 'une seule banque pour une piste');
  assert.strictEqual(result.synths, 1, 'un seul synthétiseur');
  assert.strictEqual(result.mode, 'soundfont');
  global.__oneTrack = result;
});

test('addSoundBank appelé une seule fois pour 3 pistes, temps comparable', async () => {
  const one = global.__oneTrack || await measure(1);
  const three = await measure(3);
  console.log(`       3 pistes : ${three.banks} banque(s), ${three.synths} synthé(s), ${three.elapsed} ms, moteur ${three.mode}`);
  assert.strictEqual(three.banks, 1, 'une seule banque pour trois pistes');
  assert.strictEqual(three.synths, 1, 'un seul synthétiseur pour trois pistes');
  assert.strictEqual(three.mode, 'soundfont');
  assert.ok(
    Math.abs(three.elapsed - one.elapsed) < 80,
    `chargement indépendant du nombre de pistes (1 piste ${one.elapsed} ms, 3 pistes ${three.elapsed} ms)`
  );
});

test('programmes différents : canaux, programChange et noteOn distincts', async () => {
  const result = await measure(3);
  const melodic = result.assignments.filter((entry) => !entry.percussion);
  assert.deepStrictEqual(melodic.map((entry) => entry.program), [0, 10, 20]);
  const channels = melodic.map((entry) => entry.channel);
  assert.strictEqual(new Set(channels).size, channels.length, 'un canal par piste mélodique');
  assert.deepStrictEqual(
    result.programs.map((entry) => entry.program).sort((a, b) => a - b),
    [0, 10, 20],
    'un programChange par programme'
  );
  const notesByChannel = new Map(result.notes.map((note) => [note.channel, note.pitch]));
  for (const entry of melodic) {
    assert.ok(notesByChannel.has(entry.channel), `note envoyée sur le canal ${entry.channel}`);
  }
  assert.deepStrictEqual(
    result.connections.slice().sort((a, b) => a - b),
    channels.slice().sort((a, b) => a - b),
    'une sortie de canal connectée par piste'
  );
});

test('banque illisible : repli immédiat sur l’oscillateur', async () => {
  const result = await measure(1, { failBank: true });
  assert.strictEqual(result.mode, 'oscillator', 'mode oscillateur après échec de la banque');
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
