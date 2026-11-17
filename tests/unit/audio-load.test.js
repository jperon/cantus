#!/usr/bin/env node
'use strict';

// Vérifie que le soundfont n'est chargé/décodé qu'UNE fois, quel que soit le
// nombre de pistes. On remplace window.Soundfont et window.AudioContext par
// des doubles mesurant l'appel à Soundfont.instrument et le délai total.
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
    this.currentTime = 0;
    this.state = 'running';
    this.destination = new FakeNode();
  }
  createGain() { return new FakeGain(); }
  createBufferSource() { return new FakeSource(); }
  createOscillator() { return new FakeSource(); }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}

async function measure(trackCount) {
  let instrumentCalls = 0;
  const tracks = [];
  for (let i = 0; i < trackCount; i += 1) {
    tracks.push({ index: i, notes: [{ start: 0, dur: 0.4, pitch: 60 + i * 4, velocity: 80 }] });
  }
  const previousWindow = global.window;
  global.window = {
    AudioContext: FakeContext,
    __musicaMidi: {
      parseBase64: () => ({ duration: 1, tracks }),
    },
    MIDI: { Soundfont: { acoustic_grand_piano: { C4: 'data:audio/mp3;base64,AA==' } } },
    Soundfont: {
      instrument: () => {
        instrumentCalls += 1;
        return new Promise((resolve) => setTimeout(() => resolve({
          buffers: { 60: { duration: 1 }, 64: { duration: 1 }, 68: { duration: 1 } },
          play: () => null,
        }), 80));
      },
    },
  };
  const run = async () => {
    const engine = audio.createEngine();
    engine.load({ midi: 'x', duration: 1000 });
    const started = Date.now();
    engine.play(0);
    while (engine.getEngineMode() !== 'soundfont' && Date.now() - started < 3000) {
      await sleep(5);
    }
    const elapsed = Date.now() - started;
    const mode = engine.getEngineMode();
    engine.destroy();
    return { elapsed, mode };
  };
  try {
    // Échauffement (JIT, timers) hors mesure : seuls le nombre de chargements
    // et le temps du second passage sont comparés.
    await run();
    instrumentCalls = 0;
    const { elapsed, mode } = await run();
    return { instrumentCalls, elapsed, mode };
  } finally {
    global.window = previousWindow;
  }
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('nearestSampleKey : choisit le buffer voisin et corrige par playbackRate', () => {
  const buffers = { 36: {}, 40: {}, 44: {}, 48: {} };
  assert.strictEqual(audio.nearestSampleKey(buffers, 41), 40);
  assert.strictEqual(audio.nearestSampleKey(buffers, 43), 44);
  assert.strictEqual(audio.nearestSampleKey(buffers, 60), 48);
  assert.strictEqual(audio.nearestSampleKey(null, 60), null);
  assert.strictEqual(audio.nearestSampleKey({}, 60), null);
  assert.ok(Math.abs(audio.samplePlaybackRate(40, 41) - Math.pow(2, 1 / 12)) < 1e-12);
  assert.strictEqual(audio.samplePlaybackRate(40, 40), 1);
});

test('Soundfont.instrument appelé une seule fois pour 1 piste', async () => {
  const result = await measure(1);
  console.log(`       1 piste : ${result.instrumentCalls} chargement, ${result.elapsed} ms, moteur ${result.mode}`);
  assert.strictEqual(result.instrumentCalls, 1, 'un seul chargement pour une piste');
  assert.strictEqual(result.mode, 'soundfont');
  result.oneTrack = result.elapsed;
  global.__oneTrack = result;
});

test('Soundfont.instrument appelé une seule fois pour 3 pistes, temps comparable', async () => {
  const one = global.__oneTrack || await measure(1);
  const three = await measure(3);
  console.log(`       3 pistes : ${three.instrumentCalls} chargement, ${three.elapsed} ms, moteur ${three.mode}`);
  assert.strictEqual(three.instrumentCalls, 1, 'un seul chargement pour trois pistes');
  assert.strictEqual(three.mode, 'soundfont');
  assert.ok(
    Math.abs(three.elapsed - one.elapsed) < 80,
    `chargement indépendant du nombre de pistes (1 piste ${one.elapsed} ms, 3 pistes ${three.elapsed} ms)`
  );
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
