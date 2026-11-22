#!/usr/bin/env node
'use strict';

// Mesure comparative de deux moteurs audio (SpessaSynth / échantillons natifs)
// sur la même partition, avec le même protocole :
//   - Chromium headless, service worker bloqué (téléchargements réels) ;
//   - CPU bridé ×6 (Emulation.setCPUThrottlingRate) pendant la mesure ;
//   - 20 s de lecture, temps CPU du processus (toute l'arborescence Chromium)
//     et du fil principal (Performance.getMetrics), mémoire JS, octets audio
//     téléchargés, temps de chargement du moteur, régularité.
//   - rendu WAV de 20 s de la même partition par chaque moteur.
//
// Usage :
//   env -u LD_LIBRARY_PATH node tests/bench-audio.js \
//     --spessa /tmp/cantus-natif/spessa-dist --samples dist \
//     --out /tmp/cantus-natif
//
// Le premier dossier est le build SpessaSynth de référence, le second le build
// courant. Les scénarios Playwright ne lancent pas ce script.

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const THROTTLE = 6;
const PLAY_SECONDS = Number(process.env.BENCH_SECONDS) || 20;
const IDLE_SECONDS = Number(process.env.BENCH_IDLE_SECONDS) || 10;

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const SPESSA_DIST = path.resolve(arg('spessa', '/tmp/cantus-natif/spessa-dist'));
const SAMPLES_DIST = path.resolve(arg('samples', path.join(__dirname, '..', 'dist')));
const OUT = path.resolve(arg('out', '/tmp/cantus-natif'));

// CPU (s) par type de processus Chromium, via CDP SystemInfo : le processus
// navigateur agrège le service audio, les rendus (dont AudioWorklet) et le
// compositeur, seul moyen d'attribuer le coût réel des deux moteurs.
async function cpuSnapshot(session) {
  const info = await session.send('SystemInfo.getProcessInfo');
  const byType = {};
  let total = 0;
  for (const process of info.processInfo) {
    const type = process.type || 'autre';
    const cpu = Number(process.cpuTime) || 0;
    byType[type] = (byType[type] || 0) + cpu;
    total += cpu;
  }
  return { total, byType };
}

function cpuDelta(before, after) {
  const byType = {};
  for (const type of new Set([...Object.keys(before.byType), ...Object.keys(after.byType)])) {
    byType[type] = Math.max(0, (after.byType[type] || 0) - (before.byType[type] || 0));
  }
  return { total: Math.max(0, after.total - before.total), byType };
}

const CAPTURE_SCRIPT = () => {
  window.__musicaCapture = { master: null, starts: [] };
  const originalConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function connect(destination, ...rest) {
    try {
      if (destination === this.context?.destination && this instanceof GainNode) {
        window.__musicaCapture.master = this;
      }
    } catch { /* ignore */ }
    return originalConnect.call(this, destination, ...rest);
  };
  if (window.AudioBufferSourceNode) {
    const originalStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function start(when, offset, duration) {
      window.__musicaCapture.starts.push({ when, offset, duration });
      return originalStart.call(this, when, offset, duration);
    };
  }
  window.__startRecording = () => {
    const master = window.__musicaCapture.master;
    if (!master) throw new Error('sortie maître introuvable');
    const ctx = master.context;
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    proc.connect(sink);
    sink.connect(ctx.destination);
    master.connect(proc);
    const state = { chunks: [], on: true, proc, sink, rate: ctx.sampleRate };
    window.__musicaRecording = state;
    proc.onaudioprocess = (event) => {
      if (state.on) state.chunks.push(Float32Array.from(event.inputBuffer.getChannelData(0)));
    };
  };
  window.__stopRecording = () => {
    const state = window.__musicaRecording;
    if (!state) throw new Error('enregistrement non démarré');
    state.on = false;
    state.proc.disconnect();
    state.sink.disconnect();
    let length = 0;
    for (const chunk of state.chunks) length += chunk.length;
    const pcm = new DataView(new ArrayBuffer(44 + length * 2));
    const write = (offset, text) => {
      for (let i = 0; i < text.length; i += 1) pcm.setUint8(offset + i, text.charCodeAt(i));
    };
    write(0, 'RIFF');
    pcm.setUint32(4, 36 + length * 2, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    pcm.setUint32(16, 16, true);
    pcm.setUint16(20, 1, true);
    pcm.setUint16(22, 1, true);
    pcm.setUint32(24, state.rate, true);
    pcm.setUint32(28, state.rate * 2, true);
    pcm.setUint16(32, 2, true);
    pcm.setUint16(34, 16, true);
    write(36, 'data');
    pcm.setUint32(40, length * 2, true);
    let cursor = 44;
    for (const chunk of state.chunks) {
      for (let i = 0; i < chunk.length; i += 1) {
        const value = Math.max(-1, Math.min(1, chunk[i]));
        pcm.setInt16(cursor, value < 0 ? value * 0x8000 : value * 0x7fff, true);
        cursor += 2;
      }
    }
    const bytes = new Uint8Array(pcm.buffer);
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  };
};

function audioBytes(dist, requests) {
  const wanted = new Set(requests.filter((url) => /\/samples\/|\/soundfonts\//.test(url)));
  let total = 0;
  const files = [];
  for (const url of wanted) {
    const file = path.join(dist, decodeURIComponent(url.replace(/^\//, '')));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      total += fs.statSync(file).size;
      files.push({ url, bytes: fs.statSync(file).size });
    }
  }
  return { total, files };
}

// Le suivi visuel est désactivé : on mesure le moteur audio, pas le rendu
// des pages (commun aux deux moteurs et très coûteux sous CPU bridé).
const DISABLE_FOLLOW = () => {
  try {
    const settings = JSON.parse(localStorage.getItem('musica-settings') || '{}');
    settings.followPlayback = false;
    localStorage.setItem('musica-settings', JSON.stringify(settings));
  } catch { /* stockage indisponible */ }
};

async function openScore(context, url) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 500, height: 900 });
  await page.goto(`${url}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await L.waitReady(page, 60000);
  const score = fs.existsSync(L.FILES.magnificatBachMscz)
    ? L.FILES.magnificatBachMscz
    : L.FILES.telemannXml;
  await L.importFile(page, score);
  await L.waitFirstSvg(page, 180000);
  await L.waitBackgroundLoaded(page, 180000);
  await page.waitForTimeout(500);
  return { page, score: path.basename(score) };
}

async function measure(browser, browserSession, dist, label) {
  const { server, url, requests } = await L.startServer(dist, { log: true });
  const context = await browser.newContext({
    viewport: { width: 500, height: 900 },
    serviceWorkers: 'block',
  });
  await context.addInitScript(CAPTURE_SCRIPT);
  await context.addInitScript(DISABLE_FOLLOW);
  try {
    const { page, score } = await openScore(context, url);
    await page.evaluate(() => localStorage.setItem('musica-language', 'fr'));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

    const t0 = Date.now();
    await page.click('#transport-play');
    await page.waitForFunction(() => window.__musicaAudio.getEngineMode() !== null,
      null, { timeout: 120000, polling: 50 });
    const loadMs = Date.now() - t0;
    // La partition peut commencer par une longue introduction vide
    // (Magnificat : 67,875 s). On mesure la fenêtre de 20 s la plus dense en
    // notes, identique pour les deux moteurs.
    const startInfo = await page.evaluate((seconds) => {
      const notes = window.__musicaAudio.getNotes();
      let best = 0;
      let bestCount = -1;
      for (let i = 0; i < notes.length; i += 1) {
        const start = Math.max(0, notes[i].start);
        let count = 0;
        for (let j = i; j < notes.length && notes[j].start < start + seconds; j += 1) count += 1;
        if (count > bestCount) { bestCount = count; best = start; }
      }
      return { start: best, count: bestCount };
    }, PLAY_SECONDS);
    const startSeconds = startInfo.start;
    await page.evaluate((start) => window.__musicaAudio.seek(start), startSeconds);
    await page.waitForTimeout(300);

    // Référence à l'arrêt : on met en pause par l'interface (l'état de
    // l'application s'arrête aussi, plus de suivi ni de rafraîchissement),
    // puis on mesure le coût propre à la lecture par différence.
    await page.click('#transport-play');
    await page.waitForTimeout(400);
    const idleMetricsBefore = await cdp.send('Performance.getMetrics');
    const idleCpuBefore = await cpuSnapshot(browserSession);
    await page.waitForTimeout(IDLE_SECONDS * 1000);
    const idleCpuAfter = await cpuSnapshot(browserSession);
    const idleMetricsAfter = await cdp.send('Performance.getMetrics');
    const idleCpu = cpuDelta(idleCpuBefore, idleCpuAfter);

    await page.click('#transport-play');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.__musicaCapture.starts = [];
      window.__musicaAudio.startNoteLog();
    });

    const metricsBefore = await cdp.send('Performance.getMetrics');
    const cpuBefore = await cpuSnapshot(browserSession);
    await page.waitForTimeout(PLAY_SECONDS * 1000);
    const cpuAfter = await cpuSnapshot(browserSession);
    const cpu = cpuDelta(cpuBefore, cpuAfter);
    const metricsAfter = await cdp.send('Performance.getMetrics');

    const state = await page.evaluate(() => ({
      mode: window.__musicaAudio.getEngineMode(),
      timing: window.__musicaAudio.getTimingStats(),
      log: window.__musicaAudio.getScheduledNotes(),
      starts: window.__musicaCapture.starts.slice(),
      loadedKeys: window.__musicaAudio.getLoadedSampleKeys?.() || [],
      playback: window.__musicaPlaybackState?.(),
    }));
    const metric = (list, name) => {
      const found = list.metrics.find((item) => item.name === name);
      return found ? found.value : 0;
    };
    const taskSeconds = metric(metricsAfter, 'TaskDuration') - metric(metricsBefore, 'TaskDuration');
    const scriptSeconds = metric(metricsAfter, 'ScriptDuration') - metric(metricsBefore, 'ScriptDuration');
    const idleTaskSeconds = metric(idleMetricsAfter, 'TaskDuration') - metric(idleMetricsBefore, 'TaskDuration');
    const heapMb = metric(metricsAfter, 'JSHeapUsedSize') / 1024 / 1024;

    // Régularité des débuts : pour le moteur d'échantillons, chaque start()
    // doit porter exactement startCtxTime + note.start. On mesure la
    // dispersion de (when - offset du journal) sur les notes appariées.
    let startSpreadMs = null;
    let startPairs = 0;
    if (state.starts.length && state.log.length) {
      const count = Math.min(state.starts.length, state.log.length);
      const bases = [];
      for (let i = 0; i < count; i += 1) {
        bases.push(state.starts[i].when - state.log[i].offset);
      }
      if (bases.length) {
        const spread = Math.max(...bases) - Math.min(...bases);
        startSpreadMs = spread * 1000;
        startPairs = bases.length;
      }
    }

    const audio = audioBytes(dist, requests);
    await page.click('#transport-play').catch(() => {});
    return {
      label,
      dist,
      score,
      engineMode: state.mode,
      loadMs,
      taskSeconds,
      scriptSeconds,
      processCpuSeconds: cpu.total,
      cpuByType: cpu.byType,
      idleProcessCpuSeconds: idleCpu.total,
      idleCpuByType: idleCpu.byType,
      idleTaskSeconds,
      netProcessCpuSeconds: Math.max(0, cpu.total - idleCpu.total),
      heapMb,
      audioBytes: audio.total,
      audioFiles: audio.files.length,
      notesScheduled: state.log.length,
      events: state.starts.length,
      startSpreadMs,
      startPairs,
      timing: state.timing,
      loadedKeys: state.loadedKeys,
      positionMs: state.playback?.position ?? null,
      startSeconds,
      windowNotes: startInfo.count,
    };
  } finally {
    await context.close();
    server.close();
  }
}

async function record(browser, dist, label) {
  const { server, url } = await L.startServer(dist);
  const context = await browser.newContext({
    viewport: { width: 500, height: 900 },
    serviceWorkers: 'block',
  });
  await context.addInitScript(CAPTURE_SCRIPT);
  await context.addInitScript(DISABLE_FOLLOW);
  try {
    const { page, score } = await openScore(context, url);
    await page.click('#transport-play');
    await page.waitForFunction(() => {
      const state = window.__musicaPlaybackState?.();
      return state?.state === 'playing' && window.__musicaAudio.getEngineMode() !== null;
    }, null, { timeout: 120000, polling: 100 });
    // Même segment musical pour les deux moteurs : pause, retour à zéro,
    // enregistrement puis lecture depuis le début.
    await page.evaluate((seconds) => {
      const notes = window.__musicaAudio.getNotes();
      let start = 0;
      let bestCount = -1;
      for (let i = 0; i < notes.length; i += 1) {
        const t = Math.max(0, notes[i].start);
        let count = 0;
        for (let j = i; j < notes.length && notes[j].start < t + seconds; j += 1) count += 1;
        if (count > bestCount) { bestCount = count; start = t; }
      }
      window.__musicaAudio.pause();
      window.__musicaAudio.seek(start);
      window.__startRecording();
      window.__musicaAudio.play(start);
    }, PLAY_SECONDS);
    await page.waitForTimeout(PLAY_SECONDS * 1000);
    const base64 = await page.evaluate(() => window.__stopRecording());
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-20s.wav`);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    return { label, score, file, bytes: fs.statSync(file).size };
  } finally {
    await context.close();
    server.close();
  }
}

(async () => {
  const browser = await L.launch();
  const browserSession = await browser.newBrowserCDPSession();
  const rows = [];
  const wavs = [];
  try {
    for (const [dist, label] of [[SPESSA_DIST, 'SpessaSynth'], [SAMPLES_DIST, 'Samples']]) {
      if (!fs.existsSync(path.join(dist, 'index.html'))) {
        throw new Error(`${dist} : index.html introuvable (build manquant)`);
      }
      console.log(`mesure ${label}…`);
      rows.push(await measure(browser, browserSession, dist, label));
      console.log(`rendu WAV ${label}…`);
      wavs.push(await record(browser, dist, label));
    }
  } finally {
    await browser.close();
  }

  console.log('\n=== MESURES ===');
  console.log(JSON.stringify(rows, null, 1));
  const header = '| moteur | CPU lecture (s) | CPU à l’arrêt (s) | CPU net (s) | CPU fil principal (s) | heap JS (Mo) | chargement (ms) | audio (ko) | notes | retard max (ms) | dispersion débuts (ms) |';
  const lines = [header, '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const row of rows) {
    lines.push(`| ${row.label} | ${row.processCpuSeconds.toFixed(2)} | ` +
      `${row.idleProcessCpuSeconds.toFixed(2)} | ${row.netProcessCpuSeconds.toFixed(2)} | ` +
      `${row.taskSeconds.toFixed(2)} | ${row.heapMb.toFixed(1)} | ${row.loadMs} | ` +
      `${(row.audioBytes / 1024).toFixed(0)} | ${row.notesScheduled} | ` +
      `${row.timing ? (row.timing.max * 1000).toFixed(2) : '—'} | ` +
      `${row.startSpreadMs == null ? '—' : row.startSpreadMs.toFixed(3)} |`);
  }
  console.log(lines.join('\n'));
  console.log('\n=== WAV ===');
  for (const wav of wavs) {
    console.log(`${wav.label} : ${wav.file} (${(wav.bytes / 1024 / 1024).toFixed(2)} Mo) — ${wav.score}`);
  }
})();
