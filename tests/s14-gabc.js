// Scénario 14 — ouverture d'un fichier gabc en notation carrée (exsurge),
// sans scoretk ni Verovio : import direct, une ligne de chant par page,
// titre/initiale, source-index et paroles, zoom, disposition horizontale,
// réouverture depuis la bibliothèque, transport masqué, export refusé, gabc
// invalide signalé, contenu malveillant neutralisé, hors ligne (PWA), puis
// retour à un MusicXML normal (worker et transport).
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const PAGES = ['index.html', 'spa.html'];
const GABC_DIR = path.join(__dirname, 'fixtures', 'gabc');
const KYRIE = path.join(GABC_DIR, 'kyrie.gabc');
const INVALIDE = path.join(GABC_DIR, 'invalide.gabc');
const MALVEILLANT = path.join(GABC_DIR, 'malveillant.gabc');
const XML = path.join(__dirname, 'fixtures', 'enchainement.xml');

// Instrumente le worker et le cache SVG avant le premier import : le gabc ne
// doit envoyer ni loadMovement, ni registerSource, ni requête de lecture, et
// ne doit rien écrire dans svgStore.
async function instrument(page) {
  await page.evaluate(() => {
    window.__s14msgs = [];
    const worker = window.__musicaWorker;
    const post = worker.postMessage.bind(worker);
    worker.postMessage = function (msg, ...rest) {
      window.__s14msgs.push(msg && msg.type);
      return post(msg, ...rest);
    };
    window.__s14sets = 0;
    const store = window.__svgCache;
    const set = store.set.bind(store);
    store.set = function (...args) {
      window.__s14sets += 1;
      return set(...args);
    };
  });
}

async function openLibraryForTest(page) {
  await page.waitForTimeout(300);
  const visible = await page.evaluate(() =>
    !document.getElementById('library-overlay').classList.contains('hidden'));
  if (!visible) {
    await page.evaluate(() => document.getElementById('btn-library').click());
    await page.waitForFunction(() =>
      !document.getElementById('library-overlay').classList.contains('hidden'), null, { timeout: 10000 });
  }
  await page.waitForSelector('#library-list .library-item:nth-child(1)', { state: 'visible' });
}

async function gabcState(page) {
  return page.evaluate(() => {
    const slot = document.getElementById('page-current');
    const svgs = [...slot.querySelectorAll('.scroll-page svg')];
    const text = [...slot.querySelectorAll('svg text')].map((el) => el.textContent).join(' ');
    const total = document.getElementById('page-number')?.textContent || '';
    return {
      svgs: svgs.length,
      chantLines: slot.querySelectorAll('g.chantLine').length,
      sourceIndex: slot.querySelectorAll('svg [source-index]').length,
      text,
      title: text.includes('Kyrie'),
      lyrics: /lé|ison|ri-e/.test(text),
      total,
      hasVerticalWrapper: !!slot.querySelector('.scroll-wrapper.vertical'),
      transportHidden: document.getElementById('transport').classList.contains('hidden'),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      slotOverflow: slot.scrollWidth - slot.clientWidth,
      svgRights: svgs.map((svg) => Math.round(svg.getBoundingClientRect().right)),
      firstHeight: svgs[0] ? svgs[0].getBoundingClientRect().height : 0,
      exsurge: !!window.exsurge,
      pwned: window.__gabcPwned,
      scripts: slot.querySelectorAll('script').length,
      onAttributes: [...slot.querySelectorAll('*')]
        .filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length,
      msgs: window.__s14msgs || [],
      sets: window.__s14sets || 0,
      errorText: document.getElementById('protocol-error')?.textContent || '',
      errorVisible: document.getElementById('protocol-error')?.style.display === 'block',
      importHidden: document.getElementById('import-section').classList.contains('hidden'),
    };
  });
}

async function importGabc(page, file, timeout = 60000) {
  await page.setInputFiles('#file-input', file);
  const first = await L.waitFirstSvg(page, timeout);
  await L.waitBackgroundLoaded(page, timeout);
  await page.waitForTimeout(400);
  return first;
}

async function setZoom(page, value) {
  await page.evaluate((v) => {
    const range = document.getElementById('zoom-range');
    range.value = String(v);
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function setLayout(page, layout) {
  await L.openSettings(page);
  await page.click(`.layout-btn[data-layout="${layout}"]`);
  await L.closeSettings(page);
}

async function runPage(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 360, height: 720 },
  });
  try {
    await L.waitReady(page);
    await instrument(page);
    const exsurgeBefore = await page.evaluate(() => !!window.exsurge);

    // A. Import et disposition automatique (verticale).
    const first = await importGabc(page, KYRIE);
    let state = await gabcState(page);
    L.record(results, '14. gabc importé et affiché en notation carrée', pageName,
      first.svgCount >= 2 && state.svgs >= 2 && state.chantLines >= 2 ? 'OK' : 'ÉCHEC',
      `1er SVG en ${first.ms} ms, ${state.svgs} SVG, ${state.chantLines} lignes, pages ${state.total}`);
    L.record(results, '14. Titre de l’en-tête, paroles et source-index dans le SVG', pageName,
      state.title && state.lyrics && state.sourceIndex > 0 ? 'OK' : 'ÉCHEC',
      `titre ${state.title}, paroles ${state.lyrics}, ${state.sourceIndex} éléments source-index`);
    L.record(results, '14. Au moins deux lignes à 360 px, sans débordement horizontal', pageName,
      state.svgs >= 2 && state.hasVerticalWrapper && state.overflow <= 0 &&
      state.slotOverflow <= 0 && state.svgRights.every((right) => right <= 361) ? 'OK' : 'ÉCHEC',
      `pages ${state.total}, débordement doc ${state.overflow} px, slot ${state.slotOverflow} px, bords ${JSON.stringify(state.svgRights)}`);
    const forbidden = state.msgs.filter((type) =>
      ['loadMovement', 'registerSource', 'getPlaybackData'].includes(type));
    L.record(results, '14. Aucun chargement worker ni écriture svgStore pour le gabc', pageName,
      forbidden.length === 0 && state.sets === 0 ? 'OK' : 'ÉCHEC',
      `messages ${JSON.stringify(state.msgs)}, svgStore.set ${state.sets}`);
    L.record(results, '14. Transport masqué et exsurge chargé seulement au premier gabc', pageName,
      !exsurgeBefore && state.exsurge && state.transportHidden ? 'OK' : 'ÉCHEC',
      `exsurge avant ${exsurgeBefore}, après ${state.exsurge}, transport masqué ${state.transportHidden}`);

    // B. Export refusé sans dialogue ni erreur.
    await page.click('#btn-menu');
    await page.click('#menu-export');
    await page.waitForTimeout(300);
    const exportHidden = await page.evaluate(() =>
      document.getElementById('export-overlay').classList.contains('hidden'));
    L.record(results, '14. Export désactivé pour un mouvement grégorien', pageName,
      exportHidden ? 'OK' : 'ÉCHEC', `dialogue masqué : ${exportHidden}`);

    // C. Zoom : les neumes grandissent et les lignes sont refaites.
    const beforeZoom = state;
    await setZoom(page, 80);
    await page.waitForFunction((height) => {
      const svg = document.querySelector('#page-current .scroll-page svg');
      return svg && svg.getBoundingClientRect().height > height * 1.3;
    }, beforeZoom.firstHeight, { timeout: 60000, polling: 200 });
    await L.waitBackgroundLoaded(page, 60000);
    const zoomed = await gabcState(page);
    L.record(results, '14. Zoom : neumes agrandis et lignes remises en page', pageName,
      zoomed.firstHeight > beforeZoom.firstHeight * 1.3 && zoomed.overflow <= 0 &&
      zoomed.transportHidden && zoomed.sourceIndex > 0 ? 'OK' : 'ÉCHEC',
      `hauteur ${Math.round(beforeZoom.firstHeight)} → ${Math.round(zoomed.firstHeight)} px, pages ${beforeZoom.total} → ${zoomed.total}, débordement ${zoomed.overflow} px`);

    // D. Disposition horizontale imposée par l'utilisateur.
    await setLayout(page, 'horizontal');
    await page.waitForFunction(() => {
      const wrapper = document.querySelector('#page-current .scroll-wrapper');
      return wrapper && !wrapper.classList.contains('vertical') &&
        wrapper.querySelectorAll('.scroll-page svg').length >= 2;
    }, null, { timeout: 60000, polling: 200 });
    const horizontal = await gabcState(page);
    L.record(results, '14. Disposition horizontale imposée : un système par page', pageName,
      !horizontal.hasVerticalWrapper && horizontal.svgs >= 2 && horizontal.overflow <= 0 ? 'OK' : 'ÉCHEC',
      `SVG affichés ${horizontal.svgs}, pages ${horizontal.total}, débordement ${horizontal.overflow} px`);
    // Retour à la disposition automatique et au zoom initial pour la réouverture.
    await setLayout(page, 'auto');
    await setZoom(page, 40);
    await page.waitForTimeout(1000);
    await L.waitBackgroundLoaded(page, 60000);
    const afterSettings = await gabcState(page);
    const playbackRequests = afterSettings.msgs.filter((type) =>
      ['loadMovement', 'registerSource', 'getPlaybackData'].includes(type));
    L.record(results, '14. Réglages ouverts sans requête de lecture pour le gabc', pageName,
      playbackRequests.length === 0 && afterSettings.transportHidden ? 'OK' : 'ÉCHEC',
      `messages ${JSON.stringify(afterSettings.msgs)}`);

    // E. Réouverture depuis la bibliothèque après rechargement.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page);
    await openLibraryForTest(page);
    await page.click('#library-list .library-item:nth-child(1) .library-item-info');
    await L.waitFirstSvg(page, 60000);
    await L.waitBackgroundLoaded(page, 60000);
    const reopened = await gabcState(page);
    L.record(results, '14. Réouverture depuis la bibliothèque en notation carrée', pageName,
      reopened.svgs >= 2 && reopened.sourceIndex > 0 && reopened.transportHidden &&
      reopened.hasVerticalWrapper ? 'OK' : 'ÉCHEC',
      `SVG ${reopened.svgs}, pages ${reopened.total}, transport masqué ${reopened.transportHidden}`);

    // F. Paroles et en-tête malveillants : rien ne s'exécute.
    await page.evaluate(() => { window.__gabcPwned = undefined; });
    await importGabc(page, MALVEILLANT);
    const evil = await gabcState(page);
    L.record(results, '14. Script et onload du gabc neutralisés dans le SVG injecté', pageName,
      evil.svgs >= 1 && evil.pwned === undefined && evil.scripts === 0 &&
      evil.onAttributes === 0 ? 'OK' : 'ÉCHEC',
      `pwned ${evil.pwned}, scripts ${evil.scripts}, attributs on* ${evil.onAttributes}`);

    // G. gabc invalide : message, retour à l'accueil, aucun blocage.
    await page.setInputFiles('#file-input', INVALIDE);
    await page.waitForFunction(() => {
      const el = document.getElementById('protocol-error');
      return el && el.style.display === 'block' && /gabc|invalide/i.test(el.textContent);
    }, null, { timeout: 30000, polling: 100 });
    const invalid = await gabcState(page);
    L.record(results, '14. gabc invalide : message d’erreur sans blocage', pageName,
      invalid.errorVisible && /invalide/i.test(invalid.errorText) ? 'OK' : 'ÉCHEC',
      invalid.errorText);

    // H. Un MusicXML ouvert ensuite garde transport et rendu normaux.
    await L.importFile(page, XML);
    const xmlFirst = await L.waitFirstSvg(page, 120000);
    await L.waitBackgroundLoaded(page, 120000);
    const afterXml = await page.evaluate(() => ({
      transportHidden: document.getElementById('transport').classList.contains('hidden'),
      staffs: document.querySelectorAll('#page-current .scroll-page svg g.staff').length,
      pageNumber: document.getElementById('page-number').textContent,
    }));
    L.record(results, '14. MusicXML ouvert après un gabc : transport et rendu normaux', pageName,
      xmlFirst.svgCount > 0 && !afterXml.transportHidden && afterXml.staffs > 0 ? 'OK' : 'ÉCHEC',
      `${afterXml.staffs} portées, pages ${afterXml.pageNumber}, transport masqué ${afterXml.transportHidden}`);

    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (gabc)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. Notation carrée gabc', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Hors ligne (PWA seulement) : le script exsurge doit être précaché par le
// service worker, puis un rechargement sans réseau doit rendre le gabc.
async function runOffline(browser, url, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName: 'index.html', viewport: { width: 360, height: 720 },
  });
  try {
    await L.waitReady(page, 60000);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(async () => {
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        if (await cache.match('./exsurge.min.js')) return true;
      }
      return false;
    }, null, { timeout: 60000, polling: 500 });
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page, 60000);
    await importGabc(page, KYRIE, 90000);
    const state = await gabcState(page);
    L.record(results, '14. Hors ligne : exsurge précaché et gabc rendu', 'index.html',
      state.svgs >= 2 && state.exsurge && state.sourceIndex > 0 ? 'OK' : 'ÉCHEC',
      `SVG ${state.svgs}, pages ${state.total}`);
  } catch (e) {
    L.record(results, '14. Hors ligne : exsurge précaché et gabc rendu', 'index.html', 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

(async () => {
  const { server, url } = await L.startServer();
  const browser = await L.launch();
  const results = [];
  try {
    for (const pageName of PAGES) await runPage(browser, url, pageName, results);
    await runOffline(browser, url, results);
  } catch (e) {
    console.log('ERREUR GÉNÉRALE', e.stack);
  }
  console.log('\n=== RÉSUMÉ S14 ===');
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  server.close();
})();
