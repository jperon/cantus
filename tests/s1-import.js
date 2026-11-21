// Scénario 1 — import d'un fichier seul (.xml, .mxl, .mscz, .ly, .abc, .mid),
// navigation, découpage en mouvements, réouverture à la page mémorisée.
const path = require('path');
const L = require('./lib');

const PAGES = ['index.html', 'spa.html'];

async function navigate(page) {
  const initial = await L.pageInfo(page);
  let n = 0;
  while (n < 3) {
    await L.pressArrow(page, 'right');
    await page.waitForTimeout(900);
    n++;
    const now = await L.pageInfo(page);
    if (now.page !== initial.page) break;
  }
  const afterRight = await L.pageInfo(page);
  const rightChanged = afterRight.page !== initial.page;
  // retour vers la page initiale (le nombre de pressions peut différer :
  // en mode vertical l’indicateur saute une page courte)
  for (let i = 0; i < 4; i++) {
    if ((await L.pageInfo(page)).page === initial.page) break;
    await L.pressArrow(page, 'left'); await page.waitForTimeout(700);
  }
  const afterLeft = await L.pageInfo(page);
  // tap droit (autant de fois que nécessaire), puis tap gauche
  let t = 0;
  while (t < 3) {
    await L.tap(page, 'right');
    await page.waitForTimeout(900);
    t++;
    const now = await L.pageInfo(page);
    if (now.page !== initial.page) break;
  }
  const afterTap = await L.pageInfo(page);
  const tapChanged = afterTap.page !== initial.page;
  for (let i = 0; i < 4; i++) {
    if ((await L.pageInfo(page)).page === initial.page) break;
    await L.tap(page, 'left'); await page.waitForTimeout(700);
  }
  const afterTapBack = await L.pageInfo(page);
  return {
    initial: initial.page, afterRight: afterRight.page, afterLeft: afterLeft.page,
    afterTap: afterTap.page, afterTapBack: afterTapBack.page,
    rightChanged, tapChanged,
    leftRestored: afterLeft.page === initial.page,
    tapRestored: afterTapBack.page === initial.page,
  };
}

async function saveLog(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('musica');
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('positions')) return resolve([]);
      const all = db.transaction('positions', 'readonly').objectStore('positions').getAll();
      all.onsuccess = () => resolve(all.result);
      all.onerror = () => resolve([]);
    };
    req.onerror = () => resolve([]);
  }));
}

async function reopenFromLibrary(page) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await L.waitReady(page, 60000);
  await page.waitForTimeout(400);
  await L.openLibraryEntry(page, 0);
  await L.waitFirstSvg(page, 180000);
  await L.waitBackgroundLoaded(page, 300000).catch(() => {});
  await page.waitForTimeout(4000);
  return L.pageInfo(page);
}

async function runPage(browser, url, pageName, results) {
  // --- .xml ---
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      const first = await L.waitFirstSvg(page, 180000);
      const info = await L.pageInfo(page);
      const nav = await navigate(page);
      const ok = first.svgCount > 0 && info.total > 0 && nav.rightChanged && nav.leftRestored && nav.tapChanged && nav.tapRestored;
      L.record(results, '1. Import .xml seul (Telemann) : affichage + flèches + tap', pageName,
        ok ? 'OK' : 'ÉCHEC',
        ok ? `affiche en ${first.ms} ms, ${info.total} pages, flèches ${nav.initial}→${nav.afterRight}→${nav.afterLeft}, tap ${nav.initial}→${nav.afterTap}→${nav.afterTapBack}`
          : JSON.stringify({ first, info, nav }));
      // Avance d'une seule page depuis le début (mode vertical)
      await L.resetScrollTop(page);
      await page.waitForTimeout(300);
      const beforeStep = await L.pageInfo(page);
      await L.pressArrow(page, 'right');
      await page.waitForTimeout(1000);
      const afterStep = await L.pageInfo(page);
      L.record(results, '1. Avance d’une page : l’indicateur passe de 1 à 2', pageName,
        afterStep.page === beforeStep.page + 1 ? 'OK' : 'ÉCHEC',
        `page ${beforeStep.page}/${beforeStep.total} → ${afterStep.page}/${afterStep.total} (scrollTop ${afterStep.scrollTop})`);
      // Accessibilité des boutons de navigation à 500 px de large
      const hits = await page.evaluate(() => [...document.querySelectorAll('.nav-btn')].map((b) => {
        const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { action: b.dataset.action, ok: el === b || b.contains(el), hit: el?.id || el?.className || el?.tagName };
      }));
      const badHits = hits.filter((h) => !h.ok);
      L.record(results, '1. Boutons de navigation cliquables (viewport 500×900)', pageName,
        badHits.length === 0 ? 'OK' : 'ÉCHEC',
        badHits.length ? badHits.map((h) => `${h.action} recouvert par ${h.hit}`).join(', ') : 'tous accessibles');
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '1. Import .xml seul (Telemann)', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // --- .mxl ---
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await L.importFile(page, L.FILES.bachMxl);
      const first = await L.waitFirstSvg(page, 180000);
      const info = await L.pageInfo(page);
      const nav = await navigate(page);
      const ok = first.svgCount > 0 && info.total > 1 && nav.rightChanged && nav.tapChanged;
      L.record(results, '1. Import .mxl seul (Magnificat_Bach.mxl) : affichage + navigation', pageName,
        ok ? 'OK' : 'ÉCHEC',
        ok ? `${info.total} pages, flèches ${nav.initial}→${nav.afterRight}, tap →${nav.afterTap}`
          : JSON.stringify({ first, info, nav }));
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (mxl)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '1. Import .mxl seul (Bach)', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // --- .mscz + réouverture à la page mémorisée ---
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await L.importFile(page, L.FILES.byrdMscz);
      const first = await L.waitFirstSvg(page, 180000);
      await L.waitBackgroundLoaded(page, 180000);
      await page.waitForTimeout(1000);
      const info = await L.pageInfo(page);
      const nav = await navigate(page);
      L.record(results, '1. Import .mscz seul (Byrd) : affichage + navigation', pageName,
        first.svgCount > 0 && nav.rightChanged && nav.tapChanged ? 'OK' : 'ÉCHEC',
        `affiche en ${first.ms} ms, ${info.total} pages, flèches ${nav.initial}→${nav.afterRight}, tap →${nav.afterTap}`);
      // Aller jusqu'à la page 6 (le fichier en a 8) puis mémoriser
      await L.gotoPage(page, 1);
      await L.resetScrollTop(page);
      for (let i = 0; i < 5; i++) { await L.pressArrow(page, 'right'); await page.waitForTimeout(700); }
      const before = await L.pageInfo(page);
      await page.waitForTimeout(2500);
      const positions = await saveLog(page);
      const after = await reopenFromLibrary(page);
      const ok = after.page === before.page;
      L.record(results, '1. Réouverture bibliothèque à la page mémorisée (.mscz)', pageName,
        ok ? 'OK' : 'ÉCHEC',
        `avant ${before.page}/${before.total} (scrollTop ${before.scrollTop}), position en base ${JSON.stringify(positions.map((p) => p.page))}, après ${after.page}/${after.total}`);
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (mscz)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '1. Import .mscz seul + réouverture', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // --- .ly (LilyPond) via scoretk ---
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      const fixture = path.join(__dirname, 'fixtures', 'petit-essai.ly');
      await L.importFile(page, fixture);
      const first = await L.waitFirstSvg(page, 180000);
      const info = await L.pageInfo(page);
      await L.openLibrary(page);
      const names = (await L.libraryEntries(page)).map((e) => e.name);
      const ok = first.svgCount > 0 && names.includes('petit-essai');
      L.record(results, '1. Import .ly (LilyPond) : affichage + nom sans extension', pageName,
        ok ? 'OK' : 'ÉCHEC',
        ok ? `affiche en ${first.ms} ms, ${info.total} page(s), bibliothèque : ${names.join(', ')}`
          : JSON.stringify({ first, info, names }));
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (ly)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '1. Import .ly (LilyPond)', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // --- .abc via scoretk ---
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      const fixture = path.join(__dirname, 'fixtures', 'petit-essai.abc');
      await L.importFile(page, fixture);
      const first = await L.waitFirstSvg(page, 180000);
      const info = await L.pageInfo(page);
      await L.openLibrary(page);
      const names = (await L.libraryEntries(page)).map((e) => e.name);
      const ok = first.svgCount > 0 && names.includes('petit-essai');
      L.record(results, '1. Import .abc : affichage + nom sans extension', pageName,
        ok ? 'OK' : 'ÉCHEC',
        ok ? `affiche en ${first.ms} ms, ${info.total} page(s), bibliothèque : ${names.join(', ')}`
          : JSON.stringify({ first, info, names }));
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (abc)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '1. Import .abc', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // --- .mid via scoretk : transcription + indication ---
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      const fixture = path.join(__dirname, 'fixtures', 'petit-essai.mid');
      await L.importFile(page, fixture);
      await page.waitForFunction(() => {
        const el = document.getElementById('transcription-notice');
        return el && el.style.display !== 'none' && /transcri/i.test(el.textContent || '');
      }, null, { timeout: 60000 });
      const first = await L.waitFirstSvg(page, 180000);
      const info = await L.pageInfo(page);
      const notice = await page.evaluate(() => {
        const el = document.getElementById('transcription-notice');
        return el ? { text: el.textContent, visible: el.style.display !== 'none' } : null;
      });
      await L.openLibrary(page);
      const names = (await L.libraryEntries(page)).map((e) => e.name);
      const ok = first.svgCount > 0 && names.includes('petit-essai')
        && notice?.visible && /transcri/i.test(notice.text);
      L.record(results, '1. Import .mid : affichage, nom sans extension, indication de transcription', pageName,
        ok ? 'OK' : 'ÉCHEC',
        ok ? `affiche en ${first.ms} ms, ${info.total} page(s), bibliothèque : ${names.join(', ')}, indication : « ${notice.text} »`
          : JSON.stringify({ first, info, names, notice }));
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (mid)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '1. Import .mid', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // --- découpage en mouvements (fichier de test à 3 mouvements) ---
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      const fixture = path.join(__dirname, 'fixtures', 'movements.xml');
      await L.importFile(page, fixture);
      await L.waitFirstSvg(page, 60000);
      await L.waitBackgroundLoaded(page, 60000);
      await page.waitForTimeout(800);
      const info = await L.pageInfo(page);
      const starts = [];
      for (let i = 0; i < 4; i++) {
        const before = await L.pageInfo(page);
        await page.click('.nav-btn[data-action="next-mov"]');
        await page.waitForTimeout(900);
        const after = await L.pageInfo(page);
        if (after.page === before.page) break;
        starts.push(after.page);
      }
      await page.click('.nav-btn[data-action="prev-mov"]');
      await page.waitForTimeout(900);
      const back = await L.pageInfo(page);
      const ok = info.total === 3 && starts.length === 2 && back.page === 2;
      L.record(results, '1. Découpage en mouvements (3 déclarés) + mouvement précédent', pageName,
        ok ? 'OK' : 'ÉCHEC',
        `total ${info.total}, débuts suivants ${starts.join(',')}, après prev-mov ${back.page}`);
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (mouvements)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '1. Découpage en mouvements', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // --- « Début » après défilement vertical (Telemann, 6 pages verticales) ---
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await L.waitFirstSvg(page, 120000);
      await L.waitBackgroundLoaded(page, 120000);
      await page.waitForTimeout(800);
      for (let i = 0; i < 2; i++) { await L.pressArrow(page, 'right'); await page.waitForTimeout(800); }
      const before = await L.pageInfo(page);
      await L.gotoPage(page, 1);
      await page.waitForTimeout(1200);
      const after = await L.pageInfo(page);
      const ok = after.page === 1;
      L.record(results, '1. Bouton « Début » après défilement vertical', pageName,
        ok ? 'OK' : 'ÉCHEC',
        `avant ${before.page}/${before.total} (scrollTop ${before.scrollTop}), après ${after.page}/${after.total} (scrollTop ${after.scrollTop})`);
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (début)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '1. Bouton « Début »', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // --- page mémorisée en mode horizontal (Fauré) : témoin du même mécanisme ---
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await L.importFile(page, L.FILES.faureMscz);
      await L.waitFirstSvg(page, 180000);
      await L.waitBackgroundLoaded(page, 180000);
      await page.waitForTimeout(1000);
      for (let i = 0; i < 4; i++) { await L.pressArrow(page, 'right'); await page.waitForTimeout(700); }
      const before = await L.pageInfo(page);
      await page.waitForTimeout(2500);
      const positions = await saveLog(page);
      const after = await reopenFromLibrary(page);
      const ok = after.page === before.page;
      L.record(results, '1. Réouverture bibliothèque à la page mémorisée (horizontal, Fauré)', pageName,
        ok ? 'OK' : 'ÉCHEC',
        `avant ${before.page}/${before.total}, position en base ${JSON.stringify(positions.map((p) => p.page))}, après ${after.page}/${after.total}`);
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (horizontal)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '1. Réouverture page mémorisée (horizontal)', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }
}

(async () => {
  const { server, url } = await L.startServer();
  const browser = await L.launch();
  const results = [];
  try {
    for (const pageName of PAGES) await runPage(browser, url, pageName, results);
  } catch (e) {
    console.log('ERREUR GÉNÉRALE', e.stack);
  }
  console.log('\n=== RÉSUMÉ S1 ===');
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  server.close();
})();
