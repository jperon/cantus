// Banc de mesure — rechargement à XML inchangé (commit 184f9de).
//
// Objet : mesurer ce que coûte, au démarrage de la lecture, un rechargement de
// la partition par changement de zoom (`reloadScore`, qui passait par
// `startLoad` sans conserver les sources du worker avant 184f9de).
//
// Scénario par fichier : import, première lecture (données prêtes dans le
// worker et dans les caches), arrêt, puis N fois : changement de zoom (appelle
// `reloadScore`), attente de la fin du rechargement, puis mesure du délai
// entre le clic sur « lecture » et le passage effectif à l'état « playing ».
//
// Critère principal (100 % observable depuis la page, aucun fichier de src/
// modifié) : clic sur #transport-play → l'attribut aria-label du bouton passe
// à « Pause ». C'est exactement l'instant où startPlayback a fini de charger
// les données de lecture et où beginPlayback écrit playback.state = "playing"
// (juste avant renderTransport). Un MutationObserver le voit dans la
// microtâche suivante : précision inférieure à la milliseconde, et le clic
// comme la fin sont horodatés dans la page (performance.now()), donc aucun
// aller-retour Playwright ne s'ajoute à la mesure. Le délai inclut le trajet
// complet visible par l'utilisateur : demande `getPlaybackData` au worker,
// décodage MIDI et engine.load, puis lancement du moteur audio.
//
// Critère secondaire (explicatif) : réception du message worker
// « playbackData » — la fin du calcul (MIDI + timeline scoretk) que le commit
// évite de refaire. Il est absent (= 0) quand les données viennent du cache
// persistant sans passer par le worker.
//
// Diagnostic complémentaire : `clearMovements.keepSources` reçu par le worker
// et nombre de `registerSource` réémis pendant le rechargement. Avec 184f9de,
// un rechargement de zoom porte keepSources=true et n'émet aucun nouveau
// registerSource ; avant, il vide les sources et les réenregistre, ce qui
// provoque le recalcul par loadSourcePlayback.
//
// Usage (Chromium de la campagne ; TMPDIR court obligatoire) :
//   TMPDIR=$(mktemp -d /tmp/ct.XXXX) nix develop -c bash -c \
//     'env -u LD_LIBRARY_PATH CHROMIUM=/run/current-system/sw/bin/chromium \
//      BENCH_LABEL=apres node tests/bench-reload.js'
// Variables : BENCH_N (défaut 5), BENCH_SCALES (crans de zoom successifs),
// BENCH_LABEL (étiquette des lignes), BENCH_MAGNIFICAT / BENCH_LA_FOULE
// (chemins des partitions, si la révision testée ne les connaît pas encore).
const fs = require('fs');
const L = require('./lib');

const N = Number(process.env.BENCH_N || 5);
// Cinq crans distincts du curseur (30..80 par pas de 5), tous différents du
// zoom initial 40 : chaque rechargement a une géométrie inédite, donc la clé du
// cache persistant de lecture est un manque (sinon aucune donnée ne serait
// demandée au worker et la mesure ne dirait rien). Le nombre de mesures est
// plafonné par le nombre de crans disponibles.
const SCALES = (process.env.BENCH_SCALES || '45,50,55,35,60')
  .split(',').map((v) => parseInt(v, 10)).filter((v) => Number.isFinite(v));
const LABEL = process.env.BENCH_LABEL ? process.env.BENCH_LABEL + ' ' : '';
const SETTLE_MS = Number(process.env.BENCH_SETTLE || 500);

const FILES = [
  {
    name: 'Magnificat_Bach (mvt 1)',
    // BENCH_MAGNIFICAT permet de rejouer le banc sur une révision dont
    // tests/lib.js ne connaît pas encore ce fichier.
    file: process.env.BENCH_MAGNIFICAT || L.FILES.magnificatBachMscz || '',
    timeout: 300000,
  },
  {
    name: 'La_foule',
    file: process.env.BENCH_LA_FOULE || L.FILES.laFouleMxl || '',
    timeout: 180000,
  },
];

function round(value, digits = 1) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function stats(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { n: v.length, median: round(median), min: round(v[0]), max: round(v[v.length - 1]) };
}

async function state(page) {
  return page.evaluate(() => (window.__musicaPlaybackState ? window.__musicaPlaybackState() : null));
}

async function waitState(page, expected, timeout = 60000) {
  await page.waitForFunction((name) => {
    const s = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
    return s && s.state === name;
  }, expected, { timeout, polling: 50 });
}

// Sonde posée une fois par page. Elle ne modifie ni l'application ni son
// worker : elle horodate le clic, observe l'attribut aria-label du bouton
// lecture et écoute les messages du worker.
async function installProbe(page) {
  await page.evaluate(() => {
    const btn = document.getElementById('transport-play');
    const w = window.__musicaWorker;
    const bench = {
      clickAt: 0,        // performance.now() au clic sur lecture
      playingAt: 0,      // performance.now() quand aria-label devient « Pause »
      dataAt: 0,         // performance.now() à la réception de playbackData
      dataCount: 0,
      requestAt: 0,      // performance.now() à l'envoi de getPlaybackData
      registerSources: 0, // registerSource émis par l'app depuis le début
      clearKeep: null,    // dernier clearMovements : keepSources ?
      playbackRequests: 0,
    };
    window.__bench = bench;

    // Le clic de l'utilisateur arme la mesure : chaque nouveau clic remet les
    // horodatages à zéro (les clics « arrêt » ne passent pas par ici).
    btn.addEventListener('click', () => {
      bench.clickAt = performance.now();
      bench.playingAt = 0;
      bench.dataAt = 0;
      bench.dataCount = 0;
      bench.requestAt = 0;
    }, true);

    // L'état du transport est rendu dans cet attribut : « Pause » signifie
    // playing (cf. renderTransport dans src/app/transport-suivi.coffee).
    const observer = new MutationObserver(() => {
      if (!bench.clickAt || bench.playingAt) return;
      if (btn.getAttribute('aria-label') === 'Pause') bench.playingAt = performance.now();
    });
    observer.observe(btn, { attributes: true, attributeFilter: ['aria-label'] });

    // La donnée de lecture arrive par ce message. L'écouteur de l'application,
    // enregistré avant le nôtre, traite l'événement en premier (décodage MIDI,
    // engine.load) : notre horodatage inclut donc ce traitement synchrone, ce
    // qui le place au même instant que le passage à playing. On ne filtre donc
    // pas sur playingAt ici.
    w.addEventListener('message', (e) => {
      const d = e.data || {};
      if (d.type === 'playbackData' && bench.clickAt && !bench.dataAt) {
        bench.dataCount += 1;
        bench.dataAt = performance.now();
      }
    });

    // Compteurs de messages app → worker : ils disent quel chemin de code a
    // été pris sans toucher à src/.
    const original = w.postMessage.bind(w);
    w.postMessage = (msg) => {
      if (msg && msg.type === 'registerSource') bench.registerSources += 1;
      if (msg && msg.type === 'getPlaybackData') {
        bench.playbackRequests += 1;
        if (bench.clickAt && !bench.requestAt) bench.requestAt = performance.now();
      }
      if (msg && msg.type === 'clearMovements') bench.clearKeep = msg.keepSources === true;
      return original(msg);
    };
  });
}

async function readProbe(page) {
  return page.evaluate(() => {
    const b = window.__bench;
    return {
      clickAt: b.clickAt,
      playingAt: b.playingAt,
      dataAt: b.dataAt,
      dataCount: b.dataCount,
      requestAt: b.requestAt,
      registerSources: b.registerSources,
      clearKeep: b.clearKeep,
      playbackRequests: b.playbackRequests,
    };
  });
}

// Change le zoom par le même chemin que le relâchement du curseur dans les
// réglages : l'écouteur « change » de #zoom-range met currentScale à jour puis
// appelle reloadScore. On attend ensuite la fin du rechargement (première page
// affichée + chargement de fond terminé) pour que le clic sur lecture ne soit
// pas mesuré pendant le rendu.
async function changeZoomAndWait(page, scale, timeout) {
  const before = await readProbe(page);
  await page.$eval('#zoom-range', (el, value) => {
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, scale);
  await L.waitReady(page, timeout);
  await L.waitFirstSvg(page, timeout);
  await L.waitBackgroundLoaded(page, timeout);
  await page.waitForTimeout(SETTLE_MS);
  const after = await readProbe(page);
  return {
    registerSources: after.registerSources - before.registerSources,
    clearKeep: after.clearKeep,
  };
}

async function measurePlay(page, timeout = 60000) {
  const before = await readProbe(page);
  const start = await state(page);
  // Remise à zéro juste avant le clic : la mesure ne peut pas se satisfaire
  // d'un horodatage laissé par la lecture précédente.
  await page.evaluate(() => {
    window.__bench.clickAt = 0;
    window.__bench.playingAt = 0;
    window.__bench.dataAt = 0;
    window.__bench.dataCount = 0;
    window.__bench.requestAt = 0;
  });
  await page.click('#transport-play');
  await page.waitForFunction(() => {
    const b = window.__bench;
    return b.clickAt > 0 && b.playingAt > 0;
  }, null, { timeout, polling: 10 });
  const after = await readProbe(page);
  const playing = await state(page);
  await page.click('#transport-stop');
  await waitState(page, 'stopped');
  return {
    playingMs: round(after.playingAt - after.clickAt, 1),
    dataMs: after.dataAt ? round(after.dataAt - after.clickAt, 1) : 0,
    requestMs: after.requestAt ? round(after.requestAt - after.clickAt, 1) : 0,
    dataCount: after.dataCount,
    playbackRequests: after.playbackRequests - before.playbackRequests,
    stateBefore: start?.state ?? null,
    stateAfter: playing?.state ?? null,
  };
}

async function runFile(browser, url, spec, results) {
  if (!spec.file || !fs.existsSync(spec.file)) {
    L.record(results, `Banc rechargement — ${spec.name}`, 'index.html', 'SAUTÉ',
      `fichier absent : ${spec.file || '(chemin non défini)'}`);
    return null;
  }
  const { page, ctx, errors } = await L.newPage(browser, url);
  const samples = [];
  try {
    await L.waitReady(page);
    await L.importFile(page, spec.file);
    await L.waitFirstSvg(page, spec.timeout);
    await L.waitBackgroundLoaded(page, spec.timeout);
    await page.waitForTimeout(SETTLE_MS);
    await installProbe(page);

    // Première lecture : elle peuple le cache mémoire et le cache persistant de
    // lecture, et fait convertir la source par le worker. Hors mesure.
    const warm = await measurePlay(page, spec.timeout);
    const raw = [];
    raw.push(`[banc] ${LABEL}${spec.name} préparation (hors mesure) : ` +
      `clic→playing ${warm.playingMs} ms, clic→playbackData ${warm.dataMs} ms`);

    for (let i = 0; i < Math.min(N, SCALES.length); i += 1) {
      const scale = SCALES[i];
      const reload = await changeZoomAndWait(page, scale, spec.timeout);
      const sample = await measurePlay(page, spec.timeout);
      samples.push({ scale, ...reload, ...sample });
      raw.push(`[banc] ${LABEL}${spec.name} zoom ${scale} % : ` +
        `clic→playing ${sample.playingMs} ms, clic→playbackData ${sample.dataMs} ms, ` +
        `clic→demande ${sample.requestMs} ms ` +
        `(${sample.dataCount} message(s), ${sample.playbackRequests} demande(s) worker), ` +
        `keepSources=${reload.clearKeep}, registerSource=${reload.registerSources}, ` +
        `état ${sample.stateBefore}→${sample.stateAfter}`);
    }

    const playing = stats(samples.map((s) => s.playingMs));
    const data = stats(samples.filter((s) => s.dataMs > 0).map((s) => s.dataMs));
    const request = stats(samples.filter((s) => s.requestMs > 0).map((s) => s.requestMs));
    for (const line of raw) console.log(line);
    console.log(`[banc] RÉSULTAT ${LABEL}${spec.name} ` +
      `clic→playing : médiane ${playing.median} ms, min ${playing.min} ms, max ${playing.max} ms ` +
      `(n=${playing.n}, échantillons ${samples.map((s) => s.playingMs).join(', ')})`);
    console.log(`[banc] RÉSULTAT ${LABEL}${spec.name} ` +
      `clic→playbackData : ${data ? `médiane ${data.median} ms, min ${data.min} ms, max ${data.max} ms ` +
        `(n=${data.n}, échantillons ${samples.map((s) => s.dataMs).join(', ')})` : 'aucun message worker'}`);
    console.log(`[banc] RÉSULTAT ${LABEL}${spec.name} ` +
      `clic→demande getPlaybackData : ${request ? `médiane ${request.median} ms, min ${request.min} ms, ` +
        `max ${request.max} ms (n=${request.n})` : 'aucune demande'}`);

    const ok = samples.every((s) => s.stateAfter === 'playing' && s.playingMs > 0);
    L.record(results, `Banc rechargement — ${spec.name}`, 'index.html', ok ? 'OK' : 'ÉCHEC',
      `clic→playing médiane ${playing.median} ms (min ${playing.min}, max ${playing.max}), ` +
      `clic→playbackData ${data ? `médiane ${data.median} ms` : 'sans message worker'}, ` +
      `keepSources=${[...new Set(samples.map((s) => s.clearKeep))].join('/')}, ` +
      `registerSource=${samples.map((s) => s.registerSources).join('/')}`);
    return { name: spec.name, playing, data, request };
  } catch (e) {
    L.record(results, `Banc rechargement — ${spec.name}`, 'index.html', 'ÉCHEC',
      'exception du banc : ' + e.message);
    return null;
  } finally {
    const relevant = L.summarize(errors);
    L.record(results, `Banc rechargement — ${spec.name} (erreurs JS)`, 'index.html',
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctx.close();
  }
}

(async () => {
  const { server, url } = await L.startServer();
  const browser = await L.launch();
  const results = [];
  const summary = [];
  try {
    for (const spec of FILES) summary.push(await runFile(browser, url, spec, results));
  } catch (e) {
    console.log('ERREUR GÉNÉRALE', e.stack);
  }
  console.log(`\n=== BANC RECHARGEMENT ${LABEL.trim() || '(sans étiquette)'} ===`);
  console.log(JSON.stringify(summary.filter(Boolean), null, 1));
  await browser.close();
  server.close();
})();
