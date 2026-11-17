#!/usr/bin/env node
'use strict';

// Tests unitaires de la timeline pure (src/timeline.coffee), sur les fixtures
// RÉELLES de scoretk (tests/fixtures/scoretk/, voir son README) : pas
// d'objets inventés pour les cas couverts par le paquet.
//
// Usage : node tests/unit/timeline.test.js  (code 0 si tout passe, 1 sinon)

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const CoffeeScript = require('coffeescript');

function loadTimeline() {
  const file = path.join(__dirname, '..', '..', 'src', 'timeline.coffee');
  const js = CoffeeScript.compile(fs.readFileSync(file, 'utf8'), { bare: true });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
  return mod.exports;
}

const timeline = loadTimeline();
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'scoretk');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
}

function names(measures) {
  return measures.map((m) => m.measure);
}

function distinct(values) {
  return new Set(values).size;
}

// Vérifie que les offsets sont la somme cumulée des durées de segments, que
// les segments sont contigus et que le total vaut `totalMs`.
function checkSegments(segments, totalMs) {
  let offset = 0;
  segments.forEach((seg, i) => {
    assert.ok(seg.toMs >= seg.fromMs, `segment ${i} : toMs < fromMs`);
    assert.strictEqual(seg.offsetMs, offset, `segment ${i} : offset cumulé`);
    if (i > 0) assert.strictEqual(seg.fromMs, segments[i - 1].toMs, `segment ${i} : contiguïté`);
    offset += seg.toMs - seg.fromMs;
  });
  assert.strictEqual(offset, totalMs, 'somme des durées de segments');
  if (segments.length) {
    assert.strictEqual(segments[0].fromMs, 0, 'premier segment au début du slice');
    assert.strictEqual(segments[segments.length - 1].toMs, totalMs, 'dernier segment à la fin du slice');
  }
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('D (anacrouse + reprise) : premières mesures et durées réelles', () => {
  const tl = fixture('D-expanded');
  assert.strictEqual(tl.measures.length, 6);
  assert.strictEqual(distinct(names(tl.measures)), 4);

  const slice = timeline.movementSlice(tl, 0, 4);
  assert.strictEqual(slice.measures.length, 6);
  assert.deepStrictEqual(names(slice.measures), [0, 1, 2, 1, 2, 3]);

  // L'anacrouse (mesure 0) dure 480 ticks / 500 ms, la mesure 1 2000 ms.
  assert.strictEqual(slice.measures[0].endTimeUs - slice.measures[0].timeUs, 500000);
  assert.strictEqual(slice.measures[1].endTimeUs - slice.measures[1].timeUs, 2000000);
  assert.deepStrictEqual(slice.measures.map((m) => m.timeMs), [0, 500, 2500, 4500, 6500, 8500]);

  const segments = timeline.buildSegments(slice);
  assert.deepStrictEqual(segments.map((s) => s.fromMs), [0, 500, 2500, 4500, 6500, 8500]);
  assert.deepStrictEqual(segments.map((s) => s.toMs), [500, 2500, 4500, 6500, 8500, 10500]);
  assert.strictEqual(slice.durationMs, 10500);
  assert.strictEqual(slice.durationMs, Math.round(tl.measures[tl.measures.length - 1].endTimeUs / 1000));
  checkSegments(segments, slice.durationMs);
});

test('E (D.C.) : 10 occurrences, 4 mesures écrites, 3 passes, passage ignoré', () => {
  const tl = fixture('E-expanded');
  const slice = timeline.movementSlice(tl, 0, 4);
  assert.strictEqual(slice.measures.length, 10);
  assert.strictEqual(distinct(names(slice.measures)), 4);
  // `segment` (0, 1, 2) est le seul discriminant de passe ; `passage` n'en est
  // pas un (le D.C. donne segment=1 avec passage=2).
  assert.deepStrictEqual([...new Set(slice.measures.map((m) => m.segment))], [0, 1, 2]);
  assert.strictEqual(distinct(slice.measures.map((m) => m.passage)), 2);

  const segments = timeline.buildSegments(slice);
  assert.strictEqual(segments.length, 10);
  assert.deepStrictEqual(segments.map((s) => s.measure), names(slice.measures));
  assert.deepStrictEqual(segments.map((s) => s.fromMs), [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000]);
  assert.strictEqual(slice.durationMs, 20000);
  checkSegments(segments, slice.durationMs);

  // Retirer `passage` ne change rien : il n'est pas utilisé.
  const stripped = {
    ...tl,
    measures: tl.measures.map((m) => {
      const copy = { ...m };
      delete copy.passage;
      return copy;
    }),
  };
  const withoutPassage = timeline.buildSegments(timeline.movementSlice(stripped, 0, 4));
  assert.deepStrictEqual(withoutPassage, segments);
});

test('La_foule : 98 occurrences (expanded) et 72 (linear), offsets cumulés', () => {
  const expanded = fixture('La_foule-expanded');
  const linear = fixture('La_foule-linear');

  const expSlice = timeline.movementSlice(expanded, 0, 72);
  assert.strictEqual(expSlice.measures.length, 98);
  assert.strictEqual(distinct(names(expSlice.measures)), 72);
  const expSegments = timeline.buildSegments(expSlice);
  assert.strictEqual(expSegments.length, 98);
  assert.strictEqual(expSlice.durationMs, Math.round(expanded.measures[expanded.measures.length - 1].endTimeUs / 1000));
  checkSegments(expSegments, expSlice.durationMs);

  const linSlice = timeline.movementSlice(linear, 0, 72);
  assert.strictEqual(linSlice.measures.length, 72);
  assert.strictEqual(distinct(names(linSlice.measures)), 72);
  const linSegments = timeline.buildSegments(linSlice);
  assert.strictEqual(linSegments.length, 72);
  assert.strictEqual(linSlice.durationMs, Math.round(linear.measures[linear.measures.length - 1].endTimeUs / 1000));
  checkSegments(linSegments, linSlice.durationMs);

  // Les reprises allongent bien la durée d'exécution.
  assert.ok(expSlice.durationMs > linSlice.durationMs);
});

test('pause_basic : la pause étend toMs jusqu’à sa fin, total conservé', () => {
  const tl = fixture('pause_basic-expanded');
  const slice = timeline.movementSlice(tl, 0, 4);
  assert.strictEqual(slice.measures.length, 4);
  assert.strictEqual(slice.pauses.length, 3);

  // Détection par coïncidence : chaque pause commence à la fin d'une mesure.
  for (const pause of slice.pauses) {
    assert.ok(slice.measures.some((m) => m.endTick === pause.tick), `pause tick ${pause.tick}`);
  }

  assert.strictEqual(slice.pauses[0].timeMs, 2000);
  assert.strictEqual(slice.pauses[0].endTimeMs, 5000);
  assert.strictEqual(slice.measures[0].endTimeMs, 2000);

  const segments = timeline.buildSegments(slice);
  assert.deepStrictEqual(segments.map((s) => s.fromMs), [0, 5000, 10000, 15000]);
  assert.deepStrictEqual(segments.map((s) => s.toMs), [5000, 10000, 15000, 17000]);
  assert.deepStrictEqual(segments.map((s) => s.offsetMs), [0, 5000, 10000, 15000]);
  // Le segment 0 va jusqu'à la FIN de la pause (5000), pas à la fin de la
  // mesure (2000), et le suivant démarre après.
  assert.strictEqual(segments[0].toMs, slice.pauses[0].endTimeMs);
  assert.strictEqual(segments[1].fromMs, slice.pauses[0].endTimeMs);

  assert.strictEqual(slice.durationMs, 17000);
  checkSegments(segments, slice.durationMs);
});

test('pause_repeats : pause après mesure rejouée, total conservé', () => {
  const tl = fixture('pause_repeats-expanded');
  const slice = timeline.movementSlice(tl, 0, 2);
  assert.strictEqual(slice.measures.length, 4);
  assert.deepStrictEqual(names(slice.measures), [0, 0, 1, 1]);
  assert.strictEqual(slice.pauses.length, 2);
  assert.deepStrictEqual(slice.pauses.map((p) => p.tick), [1920, 5760]);
  for (const pause of slice.pauses) {
    assert.ok(slice.measures.some((m) => m.endTick === pause.tick));
  }

  const segments = timeline.buildSegments(slice);
  assert.deepStrictEqual(segments.map((s) => s.fromMs), [0, 5000, 10000, 12000]);
  assert.deepStrictEqual(segments.map((s) => s.toMs), [5000, 10000, 12000, 14000]);
  assert.strictEqual(segments[0].toMs, slice.pauses[0].endTimeMs);
  assert.strictEqual(segments[1].toMs, slice.pauses[1].endTimeMs);

  assert.strictEqual(slice.durationMs, 14000);
  checkSegments(segments, slice.durationMs);
});

test('buildSyncMarks réel : pageByWrittenIndex partiel, unresolved et tri', () => {
  const tl = fixture('E-expanded');
  const slice = timeline.movementSlice(tl, 0, 4);
  // Seules les mesures écrites 0 et 1 ont une page.
  const { marks, unresolved } = timeline.buildSyncMarks(slice, [1, 2], 0);
  assert.strictEqual(unresolved, 4);
  assert.deepStrictEqual(marks.map((m) => m.t), [0, 2000, 6000, 8000, 12000, 14000]);
  assert.deepStrictEqual(marks.map((m) => m.page), [1, 2, 1, 2, 1, 2]);
  assert.deepStrictEqual(marks.map((m) => m.id), ['m0', 'm1', 'm0', 'm1', 'm0', 'm1']);
  for (let i = 1; i < marks.length; i += 1) assert.ok(marks[i].t >= marks[i - 1].t);
});

test('pauseAt réel : bornes exactes issues de timeUs', () => {
  const tl = fixture('pause_basic-expanded');
  const pause = tl.pauses[0];
  assert.strictEqual(pause.timeUs, 2000000);
  assert.strictEqual(pause.endTimeUs, 5000000);
  assert.strictEqual(timeline.pauseAt(tl.pauses, 1999), null);
  assert.strictEqual(timeline.pauseAt(tl.pauses, 2000), pause);
  assert.strictEqual(timeline.pauseAt(tl.pauses, 4999), pause);
  assert.strictEqual(timeline.pauseAt(tl.pauses, 5000), null); // fin exclusive
});

test('synthétique : timeline sans mesures, durée dérivée des ticks et du tempo', () => {
  const tl = {
    division: 480,
    ticks: 1920,
    tempo: [{ tick: 0, timeUs: 0, microsecondsPerQuarter: 500000 }],
    measures: [],
    pauses: [],
  };
  const slice = timeline.movementSlice(tl, 0, null);
  assert.strictEqual(slice.measures.length, 0);
  assert.strictEqual(slice.durationUs, 2000000);
  assert.strictEqual(slice.durationMs, 2000);
  assert.strictEqual(slice.endTick, 1920);
  assert.deepStrictEqual(timeline.buildSegments(slice), []);
});

test('synthétique : page non résolue et page zéro comptées, marqueurs triés', () => {
  const slice = {
    measureStart: 0,
    durationMs: 3000,
    measures: [
      { measure: 0, tick: 0, endTick: 480, timeUs: 0, endTimeUs: 1000000, timeMs: 0 },
      { measure: 1, tick: 480, endTick: 960, timeUs: 1000000, endTimeUs: 2000000, timeMs: 1000 },
      { measure: 2, tick: 960, endTick: 1440, timeUs: 2000000, endTimeUs: 3000000, timeMs: 2000 },
    ],
    pauses: [],
  };
  const { marks, unresolved } = timeline.buildSyncMarks(slice, [7, 0, undefined], 0);
  assert.strictEqual(unresolved, 2);
  assert.deepStrictEqual(marks, [{ t: 0, page: 7, id: 'm0' }]);
});

test('synthétique : slice vide bien formé et pauseAt hors listes', () => {
  const tl = fixture('D-expanded');
  const empty = timeline.movementSlice(tl, 99, 100);
  assert.deepStrictEqual(empty.measures, []);
  assert.deepStrictEqual(empty.pauses, []);
  assert.strictEqual(empty.durationMs, 0);
  assert.deepStrictEqual(timeline.buildSegments(empty), []);
  assert.strictEqual(timeline.pauseAt([], 0), null);
  assert.strictEqual(timeline.pauseAt(null, 0), null);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`OK   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`ÉCHEC ${name}\n     ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests timeline`);
process.exit(failed ? 1 : 0);
