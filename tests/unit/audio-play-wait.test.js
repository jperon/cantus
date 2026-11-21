#!/usr/bin/env node
'use strict';

// Vérifie que api.play attend la résolution de ensureEngine() avant de lancer
// l'horloge et l'ordonnanceur : aucune note d'oscillateur ne doit partir
// pendant le chargement du moteur, même lent, et un pause survenu pendant
// l'attente doit empêcher tout démarrage.
//
// Usage : node tests/unit/audio-play-wait.test.js

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
const SLOW_BANK_MS = 120;

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

// Compteur partagé par tous les doubles d'un scénario.
function makeCounters() {
  return { oscillators: 0, notes: 0, banks: 0, synths: 0, contexts: 0, modules: 0 };
}

function makeContext(counters, initialState = 'running') {
  return class FakeContext {
    constructor() {
      counters.contexts += 1;
      this.t0 = Date.now();
      this.state = initialState;
      this.destination = new FakeNode();
      this.audioWorklet = {
        addModule: async () => {
          counters.modules += 1;
        },
      };
    }
    get currentTime() { return (Date.now() - this.t0) / 1000; }
    createGain() { return new FakeGain(); }
    createOscillator() {
      counters.oscillators += 1;
      return new FakeSource();
    }
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
    close() { return Promise.resolve(); }
  };
}

// Synthé dont la banque met SLOW_BANK_MS à charger : tant qu'elle n'est pas
// prête, le moteur reste en mode null (chargement en cours).
function makeSlowSynth(counters) {
  return class FakeSynth {
    constructor() {
      counters.synths += 1;
      this.isReady = Promise.resolve();
      this.notes = [];
      this.midiChannels = Array.from({ length: 16 }, () => ({ setDrums() {} }));
      this.soundBankManager = {
        addSoundBank: () => {
          counters.banks += 1;
          return sleep(SLOW_BANK_MS);
        },
      };
    }
    programChange() {}
    noteOn(channel, pitch, velocity) { counters.notes += 1; this.notes.push({ channel, pitch, velocity }); }
    noteOff() {}
    stopAll() {}
    connectChannel(node) { return node; }
    disconnectChannel() {}
    destroy() {}
  };
}

function installWindow(counters, initialState = 'running') {
  const previous = global.window;
  const tracks = [{
    index: 0,
    channel: 0,
    program: 0,
    notes: [
      { start: 0.05, dur: 0.2, pitch: 60, velocity: 90 },
      { start: 0.55, dur: 0.2, pitch: 62, velocity: 90 },
    ],
  }];
  global.window = {
    AudioContext: makeContext(counters, initialState),
    __musicaMidi: {
      parseBase64: () => ({ duration: 1, tracks }),
      decodeBase64: () => new Uint8Array([0, 0, 0, 0]),
    },
    __musicaSoundfontB64: 'AAAA',
    __musicaSpessaWorkletUrl: 'fake-worklet.js',
    __musicaSpessa: { WorkletSynthesizer: makeSlowSynth(counters) },
  };
  return () => { global.window = previous; };
}

async function waitForMode(engine, timeout = 3000) {
  const started = Date.now();
  while (engine.getEngineMode() === null && Date.now() - started < timeout) {
    await sleep(5);
  }
  return engine.getEngineMode();
}

function loadEngine() {
  const engine = audio.createEngine();
  engine.load({ midi: 'x', duration: 1000, segments: [{ fromMs: 0, toMs: 1000, offsetMs: 0 }] });
  return engine;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('play : horloge figée pendant le chargement, aucune note d’oscillateur', async () => {
  const counters = makeCounters();
  const restore = installWindow(counters);
  const engine = loadEngine();
  try {
    engine.startNoteLog();
    engine.play(0);
    assert.strictEqual(engine.isPlaying(), true, 'state.playing reste vrai pendant l’attente');
    assert.strictEqual(engine.getEngineMode(), null, 'moteur pas encore prêt');
    // Pendant le chargement de la banque, la position ne doit pas avancer et
    // aucune source d'oscillateur ne doit être créée.
    await sleep(SLOW_BANK_MS / 2);
    assert.strictEqual(engine.position(), 0, 'position figée sur from pendant l’attente');
    assert.strictEqual(counters.oscillators, 0, 'aucun oscillateur avant la fixation du mode');
    assert.strictEqual(counters.notes, 0, 'aucune note avant la fixation du mode');
    // Puis l'horloge démarre réellement : notes envoyées au synthétiseur.
    assert.strictEqual(await waitForMode(engine), 'soundfont');
    await sleep(300);
    assert.ok(counters.notes > 0, 'les notes partent une fois le moteur prêt');
    assert.strictEqual(counters.oscillators, 0, 'toujours aucun oscillateur');
    assert.ok(engine.position() > 0, 'la position avance après le départ de l’horloge');
    const log = engine.getScheduledNotes();
    assert.ok(log.length > 0, 'des notes ont été ordonnancées');
    assert.ok(log.every((n) => n.offset >= n.start - 0.001), 'l’ordonnanceur part de la position de départ');
  } finally {
    engine.destroy();
    restore();
  }
});

test('play : pause pendant l’attente du moteur -> rien ne démarre', async () => {
  const counters = makeCounters();
  const restore = installWindow(counters);
  const engine = loadEngine();
  try {
    engine.play(0);
    await sleep(SLOW_BANK_MS / 3);
    engine.pause();
    assert.strictEqual(engine.isPlaying(), false, 'pause prise en compte pendant l’attente');
    assert.strictEqual(engine.position(), 0, 'position conservée à la pause');
    assert.strictEqual(await waitForMode(engine), 'soundfont', 'le moteur finit de charger');
    await sleep(300);
    assert.strictEqual(counters.notes, 0, 'aucune note après une pause pendant le chargement');
    assert.strictEqual(counters.oscillators, 0, 'aucun oscillateur');
    assert.strictEqual(engine.isPlaying(), false, 'lecture toujours en pause');
    assert.strictEqual(engine.getScheduledNotes().length, 0, 'aucune note ordonnancée');
  } finally {
    engine.destroy();
    restore();
  }
});

test('play : seek pendant l’attente -> départ à la nouvelle position', async () => {
  const counters = makeCounters();
  const restore = installWindow(counters);
  const engine = loadEngine();
  try {
    engine.startNoteLog();
    engine.play(0);
    await sleep(SLOW_BANK_MS / 3);
    engine.seek(0.5);
    assert.strictEqual(engine.position(), 0.5, 'position déplacée pendant l’attente');
    assert.strictEqual(await waitForMode(engine), 'soundfont');
    await sleep(200);
    assert.ok(engine.position() >= 0.5, 'l’horloge part de la position demandée');
    const log = engine.getScheduledNotes();
    assert.ok(log.length > 0, 'des notes ont été ordonnancées');
    assert.ok(
      log.every((n) => n.start >= 0.5 && n.offset >= n.start - 0.001),
      'aucune note antérieure au seek n’est jouée'
    );
  } finally {
    engine.destroy();
    restore();
  }
});

test('load sans play : AudioContext suspendu et préchargement lancé une seule fois', async () => {
  const counters = makeCounters();
  const restore = installWindow(counters, 'suspended');
  const engine = audio.createEngine();
  try {
    engine.load({ midi: 'x', duration: 1000, segments: [{ fromMs: 0, toMs: 1000, offsetMs: 0 }] });
    // Le contexte est créé dès load, sans geste utilisateur : il reste
    // suspendu et le worklet + la banque se chargent quand même.
    assert.strictEqual(counters.contexts, 1, 'un AudioContext créé au chargement');
    assert.strictEqual(engine.getEngineMode(), null, 'chargement en cours, pas encore de mode');
    assert.strictEqual(await waitForMode(engine), 'soundfont', 'moteur chargé sans play');
    assert.strictEqual(counters.banks, 1, 'une seule banque chargée');
    assert.strictEqual(counters.synths, 1, 'un seul synthétiseur');
    assert.strictEqual(counters.modules, 1, 'worklet ajouté une seule fois');
    // Le premier play() réutilise le moteur déjà chargé, sans rechargement.
    engine.play(0);
    await sleep(50);
    assert.strictEqual(counters.banks, 1, 'play ne recharge pas la banque');
    assert.strictEqual(counters.synths, 1, 'play ne recrée pas le synthétiseur');
    assert.strictEqual(counters.modules, 1, 'play ne réajoute pas le worklet');
    assert.strictEqual(counters.contexts, 1, 'play ne recrée pas le contexte');
  } finally {
    engine.destroy();
    restore();
  }
});

test('load répété pendant le chargement : le moteur n’est jamais rechargé', async () => {
  const counters = makeCounters();
  const restore = installWindow(counters);
  const engine = audio.createEngine();
  const data = { midi: 'x', duration: 1000, segments: [{ fromMs: 0, toMs: 1000, offsetMs: 0 }] };
  try {
    engine.load(data);
    // Deuxième chargement (changement de mouvement) avant la fin du premier :
    // il doit partager le chargement en cours, pas en lancer un autre.
    engine.load(data);
    assert.strictEqual(await waitForMode(engine), 'soundfont');
    assert.strictEqual(counters.contexts, 1, 'un seul contexte');
    assert.strictEqual(counters.modules, 1, 'un seul ajout de worklet');
    assert.strictEqual(counters.synths, 1, 'un seul synthétiseur');
    assert.strictEqual(counters.banks, 1, 'une seule banque');
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
