#!/usr/bin/env node
'use strict';

// Tests unitaires du parseur SMF (src/midi.coffee), sans navigateur.
// Compile le CoffeeScript à la volée et construit les fichiers MIDI octet par
// octet. Sort en code 0 si tout passe, 1 sinon.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const CoffeeScript = require('coffeescript');

function loadMidi() {
  const file = path.join(__dirname, '..', '..', 'src', 'midi.coffee');
  const js = CoffeeScript.compile(fs.readFileSync(file, 'utf8'), { bare: true });
  const mod = { exports: {} };
  // Le module compilé n'utilise require() que s'il est chargé comme fichier.
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
  return mod.exports;
}

const midi = loadMidi();

// --- Construction de SMF à la main ----------------------------------------

const vlq = (n) => {
  if (n < 0) throw new Error('VLQ négatif');
  const out = [n & 0x7f];
  n = Math.floor(n / 128);
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  return out;
};

const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

const chunk = (id, body) => [
  ...id.split('').map((c) => c.charCodeAt(0)),
  ...u32(body.length),
  ...body,
];

const header = (format, ntrks, division) =>
  chunk('MThd', [...u16(format), ...u16(ntrks), ...u16(division)]);

const ev = (delta, ...data) => ({ delta, data });

const trackChunk = (events) => {
  const body = [];
  for (const e of events) body.push(...vlq(e.delta || 0), ...e.data);
  return chunk('MTrk', body);
};

const noteOn = (delta, ch, pitch, vel) => ev(delta, 0x90 | ch, pitch, vel);
const noteOff = (delta, ch, pitch, vel = 0) => ev(delta, 0x80 | ch, pitch, vel);
const programChange = (delta, ch, p) => ev(delta, 0xc0 | ch, p);
const tempoMeta = (delta, us) =>
  ev(delta, 0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff);
// Les noms de piste sont écrits en UTF-8 (comme la plupart des fichiers réels)
const trackNameMeta = (delta, str) => {
  const encoded = Array.from(Buffer.from(str, 'utf8'));
  return ev(delta, 0xff, 0x03, ...vlq(encoded.length), ...encoded);
};
const endOfTrack = (delta = 0) => ev(delta, 0xff, 0x2f, 0x00);

const smf = (...chunks) => Uint8Array.from(chunks.flat());

const approx = (actual, expected, msg, eps = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg || 'valeur'} : attendu ${expected}, obtenu ${actual}`
  );
};

// --- Mini lanceur ----------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 1. Cas de base : format 0, une note, tempo par défaut
test('format 0, une piste, une note, tempo par défaut (500000 µs/noire)', () => {
  const data = smf(
    header(0, 1, 480),
    trackChunk([noteOn(0, 0, 60, 100), noteOff(480, 0, 60), endOfTrack(0)])
  );
  const parsed = midi.parse(data);
  assert.strictEqual(parsed.format, 0);
  assert.strictEqual(parsed.division, 480);
  assert.strictEqual(parsed.ticksPerQuarter, 480);
  assert.strictEqual(parsed.smpte, null);
  assert.strictEqual(parsed.tracks.length, 1);
  const t = parsed.tracks[0];
  assert.strictEqual(t.index, 0);
  assert.strictEqual(t.name, null);
  assert.strictEqual(t.channel, 0);
  assert.strictEqual(t.program, null);
  assert.strictEqual(t.notes.length, 1);
  const n = t.notes[0];
  assert.deepStrictEqual(Object.keys(n).sort(), ['dur', 'pitch', 'start', 'velocity']);
  assert.strictEqual(n.pitch, 60);
  assert.strictEqual(n.velocity, 100);
  approx(n.start, 0, 'note.start');
  approx(n.dur, 0.5, 'note.dur');
  approx(parsed.duration, 0.5, 'duration');
  // Un seul tempo exporté (celui par défaut, à tick 0)
  assert.strictEqual(parsed.tempos.length, 1);
  assert.strictEqual(parsed.tempos[0].microsecondsPerQuarter, 500000);
});

// 2. Plusieurs tempi : accumulation correcte
test('plusieurs tempi : accumulation des segments', () => {
  const data = smf(
    header(0, 1, 480),
    trackChunk([
      tempoMeta(0, 500000),
      noteOn(0, 0, 60, 100),
      tempoMeta(480, 1000000), // 1 s/noire à partir du tick 480
      noteOff(480, 0, 60),
      endOfTrack(0),
    ])
  );
  const parsed = midi.parse(data);
  // 0..480 à 0,5 s/noire = 0,5 s ; 480..960 à 1 s/noire = 1 s
  approx(parsed.duration, 1.5, 'duration');
  approx(parsed.tracks[0].notes[0].dur, 1.5, 'note.dur');
  assert.strictEqual(parsed.tempos.length, 2);
  assert.strictEqual(parsed.tempos[1].microsecondsPerQuarter, 1000000);
  approx(parsed.tempos[1].seconds, 0.5, 'tempos[1].seconds');
});

// 3. Running status et noteOn vélocité 0 (= noteOff)
test('running status et noteOn vélocité 0', () => {
  const data = smf(
    header(0, 1, 480),
    trackChunk([
      noteOn(0, 0, 60, 100), // statut 0x90
      ev(0, 62, 100), // running status : noteOn 62
      ev(480, 60, 0), // running status : noteOn vélocité 0 -> noteOff 60
      ev(0, 62, 0), // noteOff 62
      endOfTrack(0),
    ])
  );
  const parsed = midi.parse(data);
  const notes = parsed.tracks[0].notes;
  assert.strictEqual(notes.length, 2);
  assert.strictEqual(notes[0].pitch, 60);
  assert.strictEqual(notes[1].pitch, 62);
  approx(notes[0].dur, 0.5, 'note 60 dur');
  approx(notes[1].dur, 0.5, 'note 62 dur');
  approx(parsed.duration, 0.5, 'duration');
});

// 4. Format 1 : tempo dans la piste 0, notes et métadonnées dans la piste 1
test('format 1 : tempo global fusionné, nom de piste et programChange', () => {
  const data = smf(
    header(1, 2, 480),
    trackChunk([tempoMeta(0, 250000), endOfTrack(960)]),
    trackChunk([
      trackNameMeta(0, 'Mélodie'),
      programChange(0, 0, 40),
      noteOn(0, 0, 64, 90),
      noteOff(960, 0, 64),
      endOfTrack(0),
    ])
  );
  const parsed = midi.parse(data);
  assert.strictEqual(parsed.format, 1);
  assert.strictEqual(parsed.tracks.length, 2);
  assert.strictEqual(parsed.tracks[0].notes.length, 0);
  const t = parsed.tracks[1];
  assert.strictEqual(t.name, 'Mélodie');
  assert.strictEqual(t.channel, 0);
  assert.strictEqual(t.program, 40);
  // division 480, 250000 µs/noire : 960 ticks = 2 noires = 0,5 s
  approx(parsed.duration, 0.5, 'duration');
  approx(t.notes[0].start, 0, 'note.start');
  approx(t.notes[0].dur, 0.5, 'note.dur');
  // Le tempo par défaut est remplacé par celui de la piste 0 à tick 0
  assert.strictEqual(parsed.tempos.length, 1);
  assert.strictEqual(parsed.tempos[0].microsecondsPerQuarter, 250000);
});

// 5. noteOn sans noteOff : fermé à la fin globale
test('noteOn sans noteOff : note fermée à duration', () => {
  const data = smf(
    header(0, 1, 480),
    trackChunk([noteOn(0, 0, 67, 80), endOfTrack(960)])
  );
  const parsed = midi.parse(data);
  approx(parsed.duration, 1.0, 'duration');
  assert.strictEqual(parsed.tracks[0].notes.length, 1);
  approx(parsed.tracks[0].notes[0].dur, 1.0, 'note.dur');
});

// 6. Piste vide (endOfTrack seulement)
test('piste vide : notes [] et durée 0', () => {
  const data = smf(header(0, 1, 480), trackChunk([endOfTrack(0)]));
  const parsed = midi.parse(data);
  assert.strictEqual(parsed.tracks.length, 1);
  assert.deepStrictEqual(parsed.tracks[0].notes, []);
  approx(parsed.duration, 0, 'duration');
});

// 7. 0 piste -> erreur explicite
test('ntrks = 0 : erreur explicite', () => {
  const data = smf(header(0, 0, 480));
  assert.throws(() => midi.parse(data), /ntrks = 0/);
});

// 8. Fichier tronqué -> erreur
test('fichier tronqué : erreur explicite', () => {
  const valid = smf(
    header(0, 1, 480),
    trackChunk([noteOn(0, 0, 60, 100), noteOff(480, 0, 60), endOfTrack(0)])
  );
  // En-tête incomplet
  assert.throws(() => midi.parse(valid.slice(0, 12)), /trop court/);
  // Chunk MTrk qui annonce plus d'octets qu'il n'en reste
  assert.throws(() => midi.parse(valid.slice(0, valid.length - 2)), /tronqué/);
  // Événement de note coupé en pleine lecture des données
  const truncatedEvent = smf(
    header(0, 1, 480),
    chunk('MTrk', [...vlq(0), 0x90, 60])
  );
  assert.throws(() => midi.parse(truncatedEvent), /fin de fichier inattendue/);
});

// 9. Chunk inconnu ignoré (robustesse)
test('chunk inconnu ignoré', () => {
  const data = smf(
    header(0, 1, 480),
    chunk('XFIH', [1, 2, 3, 4]),
    trackChunk([noteOn(0, 0, 60, 100), noteOff(480, 0, 60), endOfTrack(0)])
  );
  const parsed = midi.parse(data);
  assert.strictEqual(parsed.tracks.length, 1);
  approx(parsed.duration, 0.5, 'duration');
});

// 10. Division SMPTE (best effort)
test('division SMPTE : secondes directes', () => {
  // 0xE728 : -25 fps, 40 ticks/frame -> 1000 ticks/s
  const data = smf(
    header(0, 1, 0xe728),
    trackChunk([noteOn(0, 0, 60, 100), noteOff(500, 0, 60), endOfTrack(0)])
  );
  const parsed = midi.parse(data);
  assert.strictEqual(parsed.division, 0xe728);
  assert.strictEqual(parsed.ticksPerQuarter, null);
  assert.strictEqual(parsed.smpte.fps, 25);
  assert.strictEqual(parsed.smpte.ticksPerFrame, 40);
  assert.strictEqual(parsed.smpte.ticksPerSecond, 1000);
  approx(parsed.duration, 0.5, 'duration');
  approx(parsed.tracks[0].notes[0].dur, 0.5, 'note.dur');
});

// 11. noteOff orphelin toléré
test('noteOff sans noteOn : ignoré sans erreur', () => {
  const data = smf(
    header(0, 1, 480),
    trackChunk([noteOff(0, 0, 60), noteOn(0, 0, 62, 100), endOfTrack(480)])
  );
  const parsed = midi.parse(data);
  assert.strictEqual(parsed.tracks[0].notes.length, 1);
  assert.strictEqual(parsed.tracks[0].notes[0].pitch, 62);
  approx(parsed.duration, 0.5, 'duration');
});

// 12. Format 2 : best effort, durée = maximum des pistes
test('format 2 : pistes indépendantes, durée maximale', () => {
  const data = smf(
    header(2, 2, 480),
    trackChunk([noteOn(0, 0, 60, 100), noteOff(480, 0, 60), endOfTrack(0)]),
    trackChunk([noteOn(0, 0, 62, 100), noteOff(960, 0, 62), endOfTrack(0)])
  );
  const parsed = midi.parse(data);
  assert.strictEqual(parsed.format, 2);
  assert.strictEqual(parsed.tracks.length, 2);
  approx(parsed.tracks[0].notes[0].dur, 0.5, 'piste 0');
  approx(parsed.tracks[1].notes[0].dur, 1.0, 'piste 1');
  approx(parsed.duration, 1.0, 'duration');
});

// 13. base64 / durationSeconds
test('decodeBase64, parseBase64 et durationSeconds', () => {
  const bytes = smf(
    header(0, 1, 480),
    trackChunk([noteOn(0, 0, 60, 100), noteOff(480, 0, 60), endOfTrack(0)])
  );
  const b64 = Buffer.from(bytes).toString('base64');
  const decoded = midi.decodeBase64(b64);
  assert.ok(decoded instanceof Uint8Array);
  assert.deepStrictEqual(Array.from(decoded), Array.from(bytes));
  approx(midi.durationSeconds(b64), 0.5, 'durationSeconds(base64)');
  approx(midi.durationSeconds(bytes), 0.5, 'durationSeconds(bytes)');
  const viaParseBase64 = midi.parseBase64(b64);
  approx(viaParseBase64.duration, 0.5, 'parseBase64');
  // Préfixe data URL accepté
  approx(midi.durationSeconds(`data:audio/midi;base64,${b64}`), 0.5, 'data URL');
  // Entrée invalide
  assert.throws(() => midi.decodeBase64(42), /chaîne attendue/);
});

// --- Exécution -------------------------------------------------------------

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
