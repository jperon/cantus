#!/usr/bin/env node
'use strict';

// Tests unitaires de la timeline pure (src/timeline.coffee), sans DOM et sans
// scoretk : les timelines sont synthétiques et construites à la main.
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

const TPQ = 480;
const measure = (index, tick, endTick, timeUs, endTimeUs, extra = {}) => ({
  measure: index,
  segment: 0,
  passage: 'A',
  xmlId: `m${index}`,
  tick,
  endTick,
  timeUs,
  endTimeUs,
  timeMs: Math.round(timeUs / 1000),
  durationTicks: endTick - tick,
  durationUs: endTimeUs - timeUs,
  pauseBefore: 0,
  ...extra,
});

const makeTimeline = (measures, pauses = [], durationUs = 0, durationTicks = 0) => ({
  expandRepeats: true,
  division: TPQ,
  ticksPerQuarter: TPQ,
  durationTicks: durationTicks || (measures.length ? measures[measures.length - 1].endTick : 0),
  durationUs: durationUs || (measures.length ? measures[measures.length - 1].endTimeUs : 0),
  tempo: [{ tick: 0, timeUs: 0, microsecondsPerQuarter: 500000 }],
  measures,
  pauses,
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('movementSlice : mouvement au milieu du fichier, temps relatifs et offset', () => {
  const measures = [];
  for (let i = 0; i < 6; i += 1) {
    measures.push(measure(i, i * TPQ, (i + 1) * TPQ, i * 1000000, (i + 1) * 1000000));
  }
  const tl = makeTimeline(measures, [], 6000000, 6 * TPQ);
  const slice = timeline.movementSlice(tl, 2, 5);
  assert.strictEqual(slice.measures.length, 3);
  assert.deepStrictEqual(slice.measures.map((m) => m.measure), [2, 3, 4]);
  assert.deepStrictEqual(slice.measures.map((m) => m.timeMs), [0, 1000, 2000]);
  assert.deepStrictEqual(slice.measures.map((m) => m.timeUs), [0, 1000000, 2000000]);
  assert.deepStrictEqual(slice.measures.map((m) => m.tick), [0, TPQ, 2 * TPQ]);
  assert.strictEqual(slice.offsetUs, 2000000);
  assert.strictEqual(slice.offsetMs, 2000);
  assert.strictEqual(slice.offsetTick, 2 * TPQ);
  assert.strictEqual(slice.durationUs, 3000000);
  assert.strictEqual(slice.durationMs, 3000);
  assert.deepStrictEqual(slice.measures.map((m) => m.offsetMs), [2000, 2000, 2000]);
});

test('mesure répétée : deux entrées, deux segments, deux marqueurs même page', () => {
  const measures = [
    measure(0, 0, TPQ, 0, 1000000, { passage: 'A' }),
    measure(1, TPQ, 2 * TPQ, 1000000, 2000000),
    measure(0, 2 * TPQ, 3 * TPQ, 2000000, 3000000, { passage: 'A-rend2' }),
    measure(2, 3 * TPQ, 4 * TPQ, 3000000, 4000000),
  ];
  const tl = makeTimeline(measures, [], 4000000, 4 * TPQ);
  const slice = timeline.movementSlice(tl, 0, 3);
  assert.deepStrictEqual(slice.measures.map((m) => m.measure), [0, 1, 0, 2]);

  const segments = timeline.buildSegments(slice);
  assert.strictEqual(segments.length, 4);
  const repeated = segments.filter((s) => s.measure === 0);
  assert.strictEqual(repeated.length, 2);
  assert.deepStrictEqual(repeated.map((s) => s.fromMs), [0, 2000]);

  const { marks, unresolved } = timeline.buildSyncMarks(slice, [10, 20, 30], 0);
  assert.strictEqual(unresolved, 0);
  assert.deepStrictEqual(marks.map((m) => m.page), [10, 20, 10, 30]);
  assert.deepStrictEqual(marks.filter((m) => m.page === 10).map((m) => m.t), [0, 2000]);
});

test('mesure écrite jamais jouée : aucun trou de segment faux', () => {
  // La mesure écrite 2 n'est jamais jouée : elle est absente de measures[].
  const measures = [
    measure(0, 0, TPQ, 0, 1000000),
    measure(1, TPQ, 2 * TPQ, 1000000, 2000000),
    measure(3, 2 * TPQ, 3 * TPQ, 2000000, 3000000),
    measure(4, 3 * TPQ, 4 * TPQ, 3000000, 4000000),
  ];
  const tl = makeTimeline(measures, [], 4000000, 4 * TPQ);
  const segments = timeline.buildSegments(timeline.movementSlice(tl, 0, 5));
  assert.deepStrictEqual(segments.map((s) => s.measure), [0, 1, 3, 4]);
  assert.deepStrictEqual(segments.map((s) => s.fromMs), [0, 1000, 2000, 3000]);
  assert.deepStrictEqual(segments.map((s) => s.toMs), [1000, 2000, 3000, 4000]);
  assert.deepStrictEqual(segments.map((s) => s.offsetMs), [0, 1000, 2000, 3000]);
});

test('pause après une mesure : toMs va jusqu’à la fin de la pause', () => {
  const measures = [
    measure(0, 0, TPQ, 0, 1000000),
    measure(1, 2 * TPQ, 3 * TPQ, 1500000, 2500000),
    measure(2, 3 * TPQ, 4 * TPQ, 2500000, 3000000),
  ];
  const pauses = [{ tick: TPQ, endTick: 2 * TPQ, timeUs: 1000000, endTimeUs: 1500000, seconds: 0.5 }];
  const tl = makeTimeline(measures, pauses, 3000000, 4 * TPQ);
  const slice = timeline.movementSlice(tl, 0, 3);
  assert.strictEqual(slice.pauses.length, 1);
  assert.strictEqual(slice.pauses[0].timeMs, 1000);
  assert.strictEqual(slice.pauses[0].endTimeMs, 1500);

  const segments = timeline.buildSegments(slice);
  assert.strictEqual(segments[0].toMs, 1500); // pas 1000 (endTimeMs de la mesure)
  assert.strictEqual(segments[1].fromMs, 1500);
  assert.strictEqual(segments[1].offsetMs, 1500);
  assert.strictEqual(segments[2].offsetMs, 2500);
  assert.strictEqual(segments[2].toMs, 3000);
});

test('pauseBefore sur une mesure (jamais la première)', () => {
  const measures = [
    measure(0, 0, TPQ, 0, 1000000),
    measure(1, 2 * TPQ, 3 * TPQ, 1500000, 2500000, { pauseBefore: 500000 }),
    measure(2, 3 * TPQ, 4 * TPQ, 2500000, 3000000),
  ];
  const pauses = [{ tick: TPQ, endTick: 2 * TPQ, timeUs: 1000000, endTimeUs: 1500000, seconds: 0.5 }];
  const tl = makeTimeline(measures, pauses, 3000000, 4 * TPQ);
  const slice = timeline.movementSlice(tl, 0, 3);
  assert.strictEqual(slice.measures[0].pauseBefore, 0);
  assert.strictEqual(slice.measures[1].pauseBefore, 500000);

  const segments = timeline.buildSegments(slice);
  assert.strictEqual(segments[0].toMs, 1500);
  assert.strictEqual(segments[1].fromMs, 1500);
  assert.strictEqual(segments[1].offsetMs, 1500);
});

test('anacrouse : première mesure plus courte', () => {
  const measures = [
    measure(0, 0, 240, 0, 250000),
    measure(1, 240, 720, 250000, 1000000),
    measure(2, 720, 1200, 1000000, 1500000),
  ];
  const tl = makeTimeline(measures, [], 1500000, 1200);
  const slice = timeline.movementSlice(tl, 0, 3);
  assert.strictEqual(slice.durationMs, 1500);
  const segments = timeline.buildSegments(slice);
  assert.deepStrictEqual(segments.map((s) => s.fromMs), [0, 250, 1000]);
  assert.deepStrictEqual(segments.map((s) => s.toMs), [250, 1000, 1500]);
  assert.deepStrictEqual(segments.map((s) => s.offsetMs), [0, 250, 1000]);
});

test('pageByWrittenIndex incomplet : unresolved compté, marqueurs valides triés', () => {
  const measures = [];
  for (let i = 0; i < 5; i += 1) {
    measures.push(measure(i, i * TPQ, (i + 1) * TPQ, i * 1000000, (i + 1) * 1000000));
  }
  const tl = makeTimeline(measures, [], 5000000, 5 * TPQ);
  const slice = timeline.movementSlice(tl, 2, 5);

  const { marks, unresolved } = timeline.buildSyncMarks(slice, [5, undefined, 7], 2);
  assert.strictEqual(unresolved, 1);
  assert.deepStrictEqual(marks, [
    { t: 0, page: 5, id: 'm2' },
    { t: 2000, page: 7, id: 'm4' },
  ]);

  const zero = timeline.buildSyncMarks(slice, [5, 0, 7], 2);
  assert.strictEqual(zero.unresolved, 1);
  assert.deepStrictEqual(zero.marks.map((m) => m.page), [5, 7]);
});

test('pauseAt : avant, pendant, à la fin, après, hors bornes', () => {
  const pauses = [{ tick: TPQ, endTick: 2 * TPQ, timeUs: 1000000, endTimeUs: 1500000, seconds: 0.5 }];
  assert.strictEqual(timeline.pauseAt(pauses, 999), null);
  assert.strictEqual(timeline.pauseAt(pauses, 1000), pauses[0]);
  assert.strictEqual(timeline.pauseAt(pauses, 1250), pauses[0]);
  assert.strictEqual(timeline.pauseAt(pauses, 1499), pauses[0]);
  assert.strictEqual(timeline.pauseAt(pauses, 1500), null); // fin exclusive
  assert.strictEqual(timeline.pauseAt(pauses, 5000), null);
  assert.strictEqual(timeline.pauseAt([], 1000), null);
  assert.strictEqual(timeline.pauseAt(null, 1000), null);
});

test('temps fractionnaires : arrondi des ms au plus proche', () => {
  const measures = [
    measure(0, 0, TPQ, 0, 500500),
    measure(1, TPQ, 2 * TPQ, 500500, 1000500),
    measure(2, 2 * TPQ, 3 * TPQ, 1000500, 1500500),
  ];
  const tl = makeTimeline(measures, [], 1500500, 3 * TPQ);
  const slice = timeline.movementSlice(tl, 0, 3);
  // 500,5 ms -> 501 ; 1000,5 ms -> 1001 ; 1500,5 ms -> 1501.
  assert.deepStrictEqual(slice.measures.map((m) => m.timeMs), [0, 501, 1001]);
  assert.deepStrictEqual(slice.measures.map((m) => m.endTimeMs), [501, 1001, 1501]);
  assert.strictEqual(slice.durationMs, 1501);

  const segments = timeline.buildSegments(slice);
  assert.deepStrictEqual(segments.map((s) => s.fromMs), [0, 501, 1001]);
  assert.deepStrictEqual(segments.map((s) => s.toMs), [501, 1001, 1501]);
  assert.deepStrictEqual(segments.map((s) => s.offsetMs), [0, 501, 1001]);
  for (const s of segments) {
    assert.ok(Number.isInteger(s.fromMs) && Number.isInteger(s.toMs) && Number.isInteger(s.offsetMs));
  }
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
