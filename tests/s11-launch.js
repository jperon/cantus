// Scénario 11 — lancement par « Ouvrir avec Cantus » (file_handlers).
// Playwright ne peut pas déclencher un vrai lancement système : on remplace
// window.launchQueue avant le chargement par un faux objet qui retient le
// consumer et l'appelle avec un fichier .mscz, comme Chromium le fait pour un
// lancement en attente.
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const PAGES = ['index.html', 'spa.html'];
const MSCZ = L.FILES.byrdMscz;

// Ouvre une page en installant le faux launchQueue avant tout script de
// l'application, et renvoie aussi les erreurs JS.
async function newLaunchPage(browser, url, pageName, b64) {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 900 } });
  await L.forceLanguage(ctx);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 500, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  await page.addInitScript(({ data }) => {
    window.__launchRegistered = false;
    // launchQueue est un accesseur en lecture seule du prototype de window :
    // une simple affectation serait ignorée, il faut une propriété propre.
    Object.defineProperty(window, 'launchQueue', {
      configurable: true,
      writable: true,
      value: {
        setConsumer(fn) {
          window.__launchRegistered = true;
          const bin = atob(data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const handle = {
            getFile: async () => new File([bytes], 'x.mscz', { type: 'application/octet-stream' }),
          };
          // Comme Chromium : le consumer est appelé après l'enregistrement, pas
          // pendant que le script d'initialisation s'exécute encore.
          setTimeout(() => fn({ files: [handle] }), 0);
        },
      },
    });
  }, { data: b64 });
  await page.goto(`${url}/${pageName}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { page, ctx, errors };
}

async function runPage(browser, url, pageName, b64, results) {
  const { page, ctx, errors } = await newLaunchPage(browser, url, pageName, b64);
  try {
    await L.waitReady(page);
    // Le consumer doit être enregistré sans lancement préalable.
    let registered = true;
    try {
      await page.waitForFunction(() => window.__launchRegistered === true, null,
        { timeout: 10000, polling: 100 });
    } catch (e) {
      registered = false;
    }
    L.record(results, '11. window.launchQueue.setConsumer enregistré au démarrage', pageName,
      registered ? 'OK' : 'ÉCHEC', registered ? '' : 'aucun consumer enregistré');

    if (registered) {
      const first = await L.waitFirstSvg(page, 180000);
      await L.waitBackgroundLoaded(page, 180000);
      await page.waitForTimeout(700);
      const info = await L.pageInfo(page);
      L.record(results, '11. Lancement d’un .mscz : partition importée et affichée', pageName,
        first.svgCount > 0 && info.total > 1 && info.importHidden ? 'OK' : 'ÉCHEC',
        `1er SVG en ${first.ms} ms, ${info.page}/${info.total}, écran d’import affiché : ${!info.importHidden}`);

      let entries = [];
      try {
        await L.openLibrary(page);
        entries = await L.libraryEntries(page);
        await page.click('#library-close');
      } catch (e) { entries = [{ name: `(bibliothèque indisponible : ${e.message})` }]; }
      const relevant = L.summarize(errors);
      L.record(results, '11. Nom du fichier lancé conservé, aucune erreur JS', pageName,
        entries.some((e) => e.name === 'x') && !relevant.length ? 'OK' : 'ÉCHEC',
        `noms ${JSON.stringify(entries.map((e) => e.name))}, erreurs : ${relevant.join(' | ') || 'aucune'}`);
    }
  } catch (e) {
    L.record(results, '11. Lancement d’un .mscz', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

(async () => {
  const results = [];
  if (!fs.existsSync(MSCZ)) {
    L.record(results, '11. Lancement d’un .mscz', '-', 'SAUTÉ', `fichier de test absent : ${MSCZ}`);
  } else {
    const b64 = fs.readFileSync(MSCZ).toString('base64');
    const { server, url } = await L.startServer();
    const browser = await L.launch();
    try {
      for (const pageName of PAGES) await runPage(browser, url, pageName, b64, results);
    } catch (e) {
      console.log('ERREUR GÉNÉRALE', e.stack);
    }
    console.log('\n=== RÉSUMÉ S11 ===');
    console.log(JSON.stringify(results, null, 1));
    await browser.close();
    server.close();
  }
})();
