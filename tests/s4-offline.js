// Scénario 4 — hors ligne (index.html seulement) : le service worker doit
// s'installer au chargement, mettre les trois fichiers scoretk en cache,
// puis un rechargement hors ligne doit permettre d'importer un .mscz.
// Chaque attente a un délai borné ; en cas d'échec on diagnostique l'étape.
const L = require('./lib');

async function registrations(page) {
  return page.evaluate(async () => (await navigator.serviceWorker.getRegistrations())
    .map((r) => ({ scope: r.scope, active: r.active?.state, waiting: r.waiting?.state })));
}

async function manualRegister(page) {
  return page.evaluate(async () => {
    const r = await navigator.serviceWorker.register('./sw.js');
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error('navigator.serviceWorker.ready : délai de 20 s dépassé')), 20000)),
    ]);
    return { scope: r.scope, active: r.active?.state, controller: !!navigator.serviceWorker.controller };
  });
}

async function cachedMscz(page) {
  return page.evaluate(async () => {
    const want = ['scoretk.js', 'scoretk_wasm.js', 'scoretk_wasm_bg.wasm'];
    const found = {};
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      for (const name of want) {
        if (await cache.match('./scoretk/' + name)) found[name] = key;
      }
    }
    return { found, keys: await caches.keys() };
  });
}

// Lecture hors ligne : le transport doit apparaître, la lecture démarrer et la
// position progresser. Que les échantillons soient précachés (manifeste + Ogg) ou
// non (repli oscillateur), seule la lecture compte ici.
async function offlinePlayback(page) {
  await page.waitForFunction(() => {
    const el = document.getElementById('transport');
    return el && !el.classList.contains('hidden');
  }, null, { timeout: 30000, polling: 100 });
  await page.click('#transport-play');
  await page.waitForFunction(() => {
    const s = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
    return s && s.state === 'playing';
  }, null, { timeout: 30000, polling: 100 });
  const before = await page.evaluate(() => window.__musicaPlaybackState());
  await page.waitForTimeout(1100);
  const after = await page.evaluate(() => window.__musicaPlaybackState());
  return { before, after, grew: after.position > before.position + 100 };
}

(async () => {
  const { server, url, requests } = await L.startServer(L.DIST, { log: true });
  const browser = await L.launch();
  const results = [];
  const diag = {};

  // 1. Chargement normal : le service worker doit s'enregistrer tout seul
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName: 'index.html' });
    try {
      await L.waitReady(page, 60000);
      let regs = [];
      try {
        await L.waitUntil(page, async () => (await navigator.serviceWorker.getRegistrations()).length > 0,
          { timeout: 10000, what: 'enregistrement du service worker' });
      } catch (e) { /* on relève l'état réel */ }
      regs = await registrations(page);
      diag.registrations = regs;
      diag.swSupport = await page.evaluate(() => ({
        brut: 'serviceWorker' in navigator,
        coffeescript: [].indexOf.call(navigator, 'serviceWorker'),
      }));
      diag.requestsAfterLoad = requests.slice();
      L.record(results, '4. Service worker enregistré automatiquement au chargement', 'index.html',
        regs.length > 0 ? 'OK' : 'ÉCHEC',
        regs.length > 0 ? JSON.stringify(regs)
          : `aucun enregistrement ; sw.js demandé au serveur : ${requests.includes('/sw.js')} ; ` +
            `test JS « serviceWorker in navigator » = ${diag.swSupport.brut}, ` +
            `forme compilée (CoffeeScript) = ${diag.swSupport.coffeescript}`);

      if (regs.length === 0) {
        // Diagnostic : enregistrer manuellement pour vérifier le reste de la chaîne
        diag.manual = await manualRegister(page).catch((e) => ({ error: e.message }));
        try {
          await L.waitUntil(page, async () => {
            const want = ['scoretk.js', 'scoretk_wasm.js', 'scoretk_wasm_bg.wasm'];
            for (const key of await caches.keys()) {
              const cache = await caches.open(key);
              if (await cache.match('./scoretk/' + want[2])) return true;
            }
            return false;
          }, { timeout: 60000, what: 'mise en cache de scoretk' });
        } catch (e) { diag.cacheWaitError = e.message; }
        const cached = await cachedMscz(page);
        diag.cached = cached;
        const count = Object.keys(cached.found).length;
        L.record(results, '4. Trois fichiers scoretk en cache après installation du SW (enregistrement manuel pour diagnostic)', 'index.html',
          count === 3 ? 'OK' : 'ÉCHEC', `${count}/3 : ${JSON.stringify(cached.found)}, caches ${JSON.stringify(cached.keys)}`);

        // Diagnostic : hors ligne avec SW enregistré manuellement
        try {
          await ctx.setOffline(true);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          await L.waitReady(page, 60000);
          await L.importFile(page, L.FILES.byrdMscz);
          const first = await L.waitFirstSvg(page, 90000);
          const info = await L.pageInfo(page);
          diag.offlineManual = { first, info: { page: info.page, total: info.total } };
          L.record(results, '4. Hors ligne réel (setOffline + rechargement + import .mscz), SW enregistré manuellement', 'index.html',
            first.svgCount > 0 && info.page >= 1 ? 'OK' : 'ÉCHEC',
            `1er SVG en ${first.ms} ms, page ${info.page}/${info.total} ; cache ${JSON.stringify(diag.cached.found)}`);
          const play = await offlinePlayback(page);
          L.record(results, '4. Lecture après rechargement hors ligne (SW manuel)', 'index.html',
            play.grew ? 'OK' : 'ÉCHEC',
            `moteur ${play.after.engine}, position ${play.before.position} → ${play.after.position} ms, durée ${play.after.duration} ms`);
        } catch (e) {
          diag.offlineManualError = e.message;
          L.record(results, '4. Hors ligne réel avec SW enregistré manuellement', 'index.html', 'ÉCHEC', e.message);
        }
        await page.waitForTimeout(500);
        const jsErrors = L.summarize(errors).filter((e) => !/service worker/i.test(e));
        L.record(results, '6. Erreurs JS (hors ligne, diagnostic)', 'index.html', jsErrors.length ? 'ÉCHEC' : 'OK', jsErrors.join(' | '));
      } else {
        // Enregistrement normal : tester directement la mise en cache et le hors ligne
        let cached = { found: {}, keys: [] };
        try {
          await L.waitUntil(page, async () => {
            for (const key of await caches.keys()) {
              const cache = await caches.open(key);
              if (await cache.match('./scoretk/scoretk_wasm_bg.wasm')) return true;
            }
            return false;
          }, { timeout: 60000, what: 'mise en cache de scoretk' });
        } catch (e) { diag.cacheWaitError = e.message; }
        cached = await cachedMscz(page);
        diag.cached = cached;
        L.record(results, '4. Trois fichiers scoretk en cache après installation du SW', 'index.html',
          Object.keys(cached.found).length === 3 ? 'OK' : 'ÉCHEC', JSON.stringify(cached));
        try {
          await ctx.setOffline(true);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
          await L.waitReady(page, 60000);
          await L.importFile(page, L.FILES.byrdMscz);
          const first = await L.waitFirstSvg(page, 90000);
          const info = await L.pageInfo(page);
          L.record(results, '4. Hors ligne réel (setOffline + rechargement + import .mscz)', 'index.html',
            first.svgCount > 0 ? 'OK' : 'ÉCHEC', `1er SVG en ${first.ms} ms, page ${info.page}/${info.total}`);
          const play = await offlinePlayback(page);
          L.record(results, '4. Lecture après rechargement hors ligne', 'index.html',
            play.grew ? 'OK' : 'ÉCHEC',
            `moteur ${play.after.engine}, position ${play.before.position} → ${play.after.position} ms, durée ${play.after.duration} ms`);
        } catch (e) {
          L.record(results, '4. Hors ligne réel', 'index.html', 'ÉCHEC', e.message);
        }
        // Hors ligne, un instrument non encore mis en cache fait échouer son
        // fetch : c'est le repli oscillateur attendu, pas une erreur JS. Les
        // échecs réseau sont donc filtrés ici (les pageerror restent testés).
        const relevant = L.summarize(errors)
          .filter((e) => !/net::ERR_(FAILED|INTERNET_DISCONNECTED)/.test(e));
        L.record(results, '6. Erreurs JS (hors ligne)', 'index.html', relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
      }
    } catch (e) {
      L.record(results, '4. Hors ligne', 'index.html', 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // 2. Diagnostic : sans service worker, un rechargement hors ligne échoue
  // (l'application enregistre désormais son SW : on le retire d'abord, sinon
  // ce scénario ne testerait plus l'absence de service worker)
  {
    const { page, ctx } = await L.newPage(browser, url, { pageName: 'index.html' });
    try {
      await L.waitReady(page, 60000);
      await page.evaluate(async () => {
        for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
        for (const key of await caches.keys()) await caches.delete(key);
      });
      const regs = await registrations(page);
      await ctx.setOffline(true);
      let reloadError = null;
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (e) { reloadError = e.message.split('\n')[0]; }
      const info = await L.pageInfo(page).catch(() => null);
      L.record(results, '4. Conséquence : rechargement hors ligne sans SW enregistré', 'index.html',
        reloadError ? 'OK' : 'ÉCHEC',
        reloadError ? `échec attendu (${reloadError}), enregistrements=${regs.length}`
          : `le rechargement a réussi alors qu'aucun SW n'était enregistré (enregistrements=${regs.length}, page=${info?.page}/${info?.total})`);
    } catch (e) {
      L.record(results, '4. Conséquence hors ligne sans SW', 'index.html', 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  console.log('\n=== RÉSUMÉ S4 ===');
  console.log(JSON.stringify({ results, diag }, null, 1));
  await browser.close();
  server.close();
})();
