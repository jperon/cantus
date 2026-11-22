#!/usr/bin/env node
'use strict';

// Doubles Web Audio partagés par les tests unitaires du moteur audio : un
// AudioContext minimal qui enregistre les sources, les gains et leur
// automation, et un manifeste d'échantillons en mémoire.
//
// Aucun son n'est produit : les nœuds sont des espions. Les tests vérifient
// les instants passés à start()/stop(), les playbackRate, les points de boucle
// et les rampes d'enveloppe.

class FakeParam {
  constructor(label = '') {
    this.label = label;
    this.value = 0;
    this.ops = [];
  }
  setValueAtTime(value, time) {
    this.value = value;
    this.ops.push(['set', value, time]);
    return this;
  }
  linearRampToValueAtTime(value, time) {
    this.value = value;
    this.ops.push(['linear', value, time]);
    return this;
  }
  exponentialRampToValueAtTime(value, time) {
    this.value = value;
    this.ops.push(['exponential', value, time]);
    return this;
  }
  setTargetAtTime(value, time, constant) {
    this.value = value;
    this.ops.push(['target', value, time, constant]);
    return this;
  }
  cancelScheduledValues(time) {
    this.ops.push(['cancel', time]);
    return this;
  }
}

class FakeNode {
  constructor(counters, kind) {
    this.counters = counters;
    this.kind = kind;
    this.destinations = [];
  }
  connect(destination) {
    this.destinations.push(destination);
    return destination;
  }
  disconnect() {
    this.destinations = [];
  }
}

class FakeGain extends FakeNode {
  constructor(counters, index) {
    super(counters, 'gain');
    this.index = index;
    this.gain = new FakeParam(`gain${index}`);
  }
}

class FakeSource extends FakeNode {
  constructor(counters, kind = 'buffer') {
    super(counters, kind);
    this.playbackRate = new FakeParam('rate');
    this.frequency = new FakeParam('frequency');
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.started = null;
    this.stopped = null;
    this.onended = null;
    this.buffer = null;
  }
  start(when = 0, offset = 0, duration) {
    this.started = { when, offset, duration };
    this.counters.starts.push(this);
  }
  stop(when = 0) {
    this.stopped = when;
    this.counters.stops.push({ source: this, when });
    // Un stop programmé avant le début d'une source Web Audio l'empêche de
    // jouer ; le double le signale par endedAt pour les assertions.
    this.endedAt = when;
  }
}

class FakeContext {
  constructor(counters, options = {}) {
    this.counters = counters;
    this.options = options;
    this.t0 = Date.now();
    this.state = options.initialState || 'running';
    this.destination = new FakeNode(counters, 'destination');
    this.sampleRate = options.sampleRate || 44100;
    counters.contexts += 1;
    counters.lastContext = this;
  }
  get currentTime() {
    return (Date.now() - this.t0) / 1000;
  }
  createGain() {
    const gain = new FakeGain(this.counters, this.counters.gains.length);
    this.counters.gains.push(gain);
    return gain;
  }
  createBufferSource() {
    const source = new FakeSource(this.counters, 'buffer');
    this.counters.sources.push(source);
    return source;
  }
  createOscillator() {
    const source = new FakeSource(this.counters, 'oscillator');
    source.type = 'sine';
    this.counters.oscillators.push(source);
    return source;
  }
  decodeAudioData(arrayBuffer, success, failure) {
    this.counters.decodes += 1;
    const length = this.options.bufferLength || 200000;
    const buffer = { sampleRate: this.sampleRate, length, duration: length / this.sampleRate };
    const delay = this.options.decodeDelay || 0;
    // Comme les navigateurs récents, on accepte les deux conventions : rappels
    // ou promesse. Le moteur passe les rappels.
    const callbacks = typeof success === 'function' || typeof failure === 'function';
    const done = () => {
      if (this.options.decodeFails) {
        const err = new Error('décodage impossible');
        if (failure) return failure(err);
        return Promise.reject(err);
      }
      if (success) return success(buffer);
      return Promise.resolve(buffer);
    };
    if (delay > 0) {
      if (callbacks) {
        setTimeout(done, delay);
        return undefined;
      }
      return new Promise((resolve) => setTimeout(() => resolve(done()), delay));
    }
    return done();
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

// Manifeste de test : deux programmes mélodiques et la batterie. Les zones
// sont volontairement simples (une par programme, root 60) pour que les
// assertions portent sur les instants et les hauteurs.
function makeManifest(programs = ['0', '10']) {
  const entries = {};
  for (const key of programs) {
    entries[key] = {
      file: `${key}.ogg`,
      rate: 32000,
      zones: [{
        keyLo: 0, keyHi: 127, velLo: 0, velHi: 127,
        root: 60, tune: 0, offset: 0, frames: 32000,
        loop: false, loopStart: 0, loopEnd: 0,
        gain: 1, attack: 0.005, hold: 0, decay: 0.1,
        sustain: 0.8, release: 0.2,
      }],
    };
  }
  if (!entries.drums) {
    entries.drums = {
      file: 'drums.ogg',
      rate: 32000,
      zones: [{
        keyLo: 27, keyHi: 87, velLo: 0, velHi: 127,
        root: 60, tune: 0, offset: 0, frames: 16000,
        loop: false, loopStart: 0, loopEnd: 0,
        gain: 1, attack: 0.001, hold: 0, decay: 0.05,
        sustain: 0.5, release: 0.1,
      }],
    };
  }
  return {
    version: 1,
    source: { name: 'test', license: 'MIT' },
    programs: entries,
  };
}

// Installe un window factice. `manifest` null simule un build sans
// échantillons. `sampleKeys` alimente les contenus inlinés et permet de
// compter quels programmes sont lus (Proxy).
function installWindow(options = {}) {
  const counters = {
    contexts: 0,
    decodes: 0,
    sources: [],
    oscillators: [],
    gains: [],
    starts: [],
    stops: [],
    sampleReads: [],
    lastContext: null,
  };
  const manifest = options.manifest === undefined ? makeManifest(options.programs) : options.manifest;
  const base = {};
  // Tous les programmes du manifeste ont un contenu inliné : le test de
  // chargement paresseux observe les lectures, il ne les empêche pas.
  const keys = manifest ? Object.keys(manifest.programs) : (options.programs || []);
  for (const key of keys) base[key] = 'AAAA';
  const samplesData = new Proxy(base, {
    get(target, key) {
      if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(target, key)) {
        counters.sampleReads.push(key);
      }
      return target[key];
    },
  });
  const Context = class extends FakeContext {
    constructor(contextOptions) {
      super(counters, { ...options, initialState: options.initialState || 'running' });
      void contextOptions;
    }
  };
  const previous = global.window;
  const windowObject = {
    AudioContext: Context,
    location: { href: 'http://localhost/' },
    __musicaMidi: {
      parseBase64: () => options.midi || { duration: 1000, tracks: [] },
      decodeBase64: () => new Uint8Array([0, 0, 0, 0]),
    },
  };
  if (manifest) {
    windowObject.__musicaSamplesManifest = manifest;
    windowObject.__musicaSamplesData = samplesData;
    windowObject.__musicaSamplesAvailable = true;
  } else {
    windowObject.__musicaSamplesAvailable = false;
  }
  if (options.fetchSample) windowObject.fetch = options.fetchSample;
  global.window = windowObject;
  return {
    counters,
    restore() { global.window = previous; },
    context: () => counters.lastContext,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForMode(engine, timeout = 3000) {
  const started = Date.now();
  while (engine.getEngineMode() === null && Date.now() - started < timeout) await sleep(5);
  return engine.getEngineMode();
}

module.exports = {
  FakeParam,
  FakeNode,
  FakeGain,
  FakeSource,
  FakeContext,
  makeManifest,
  installWindow,
  sleep,
  waitForMode,
};
