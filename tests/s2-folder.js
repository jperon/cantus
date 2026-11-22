// Scénario 2 — dossier Magnificat (12 .mscz) : bouton dossier et sélection
// multiple, une seule entrée, premier affichage avant la fin des conversions,
// parcours des mouvements, page mémorisée, suppression pendant le chargement.
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const PAGES = ['index.html', 'spa.html'];
const DIR = L.FILES.magnificatDir;
const MSCZ = fs.readdirSync(DIR).filter((f) => f.endsWith('.mscz')).sort().map((f) => path.join(DIR, f));

async function importFolderAndWait(page) {
  await page.setInputFiles('#folder-input', DIR);
  const first = await L.waitFirstSvg(page, 180000);
  const infoFirst = await L.pageInfo(page);
  await L.waitBackgroundLoaded(page, 300000);
  await page.waitForTimeout(800);
  const infoAll = await L.pageInfo(page);
  return { first, infoFirst, infoAll };
}

async function nextMovement(page, timeout = 30000) {
  const before = await L.pageInfo(page);
  await page.click('.nav-btn[data-action="next-mov"]');
  try {
    await L.waitPageChange(page, before.page, timeout);
  } catch (e) { /* pas de changement */ }
  await page.waitForTimeout(600);
  return { before, after: await L.pageInfo(page) };
}

async function dbPositions(page) {
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

async function dbFiles(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('musica');
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) return resolve([]);
      const all = db.transaction('files', 'readonly').objectStore('files').getAll();
      all.onsuccess = () => resolve(all.result.map((f) => f.name));
      all.onerror = () => resolve([]);
    };
    req.onerror = () => resolve([]);
  }));
}

async function reopenFolder(page) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await L.waitReady(page, 60000);
  await page.waitForTimeout(400);
  await L.openLibraryEntry(page, 0);
  await L.waitFirstSvg(page, 180000);
  await L.waitBackgroundLoaded(page, 300000);
  await page.waitForTimeout(4000);
  return L.pageInfo(page);
}

async function runPage(browser, url, pageName, results) {
  // A. bouton dossier, entrée unique, premier affichage précoce, parcours
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      const { first, infoFirst, infoAll } = await importFolderAndWait(page);
      const early = first.backgroundLoading === true && infoAll.total > infoFirst.total;
      L.record(results, '2. Dossier Magnificat : premier affichage avant la fin des conversions', pageName,
        early ? 'OK' : 'ÉCHEC',
        `1er SVG en ${first.ms} ms, ${infoFirst.total} pages à l'affichage (chargement de fond ${first.backgroundLoading ? 'en cours' : 'terminé'}), ${infoAll.total} pages une fois tout converti`);
      await L.openLibrary(page);
      const entries = await L.libraryEntries(page);
      const one = entries.length === 1 && /12 fichiers/.test(entries[0].meta || '');
      L.record(results, '2. Dossier Magnificat par bouton : une seule entrée « 12 fichiers »', pageName,
        one ? 'OK' : 'ÉCHEC', JSON.stringify(entries));
      await page.click('#library-close');
      // Parcours par mouvement, au repos (scrollTop 0)
      await L.resetScrollTop(page);
      const starts = [];
      let transitions = 0;
      for (let i = 0; i < 20; i++) {
        const r = await nextMovement(page);
        if (r.after.page === r.before.page) break;
        transitions++;
        starts.push(r.after.page);
      }
      const movOk = transitions === 11 && starts.every((p, i) => i === 0 || p > starts[i - 1]);
      L.record(results, '2. Enchaînement des 12 mouvements (bouton mouvement suivant)', pageName,
        movOk ? 'OK' : 'ÉCHEC',
        `${transitions + 1} mouvements, débuts : 1,${starts.join(',')}`);
      // de la dernière page de mouvement jusqu'à la fin, page par page
      const lastStart = starts[starts.length - 1];
      let presses = 0;
      let info = await L.pageInfo(page);
      while (info.page < info.total && presses < 25) {
        await L.pressArrow(page, 'right');
        await page.waitForTimeout(700);
        presses++;
        info = await L.pageInfo(page);
      }
      const tailOk = info.page === info.total;
      L.record(results, '2. Dernière page atteinte page par page', pageName,
        tailOk ? 'OK' : 'ÉCHEC',
        `départ ${lastStart}, ${presses} pressions, arrivée ${info.page}/${info.total}`);
      await L.pressArrow(page, 'right');
      await page.waitForTimeout(900);
      const afterEnd = await L.pageInfo(page);
      const domPages = await page.evaluate(() => [...document.querySelectorAll('#page-current .scroll-page')].map((d) => d.dataset.page));
      L.record(results, '2. L’indicateur ne dépasse pas le nombre de pages (pression après la fin)', pageName,
        afterEnd.page <= afterEnd.total ? 'OK' : 'ÉCHEC',
        `après ${info.page}/${info.total}, une pression de plus → ${afterEnd.page}/${afterEnd.total} ; pages rendues : ${domPages.join(',')}`);
      // Enchaînement mixte : après défilement dans un mouvement, le mouvement
      // suivant doit démarrer à son début (bug attendu en mode vertical).
      const { page: page2, ctx: ctx2, errors: errors2 } = await L.newPage(browser, url, { pageName });
      try {
        await L.waitReady(page2);
        await importFolderAndWait(page2);
        // Aller au début du mouvement 4 (3 sauts), puis défiler dans ce mouvement
        let mv4 = null;
        for (let i = 0; i < 3; i++) mv4 = await nextMovement(page2);
        await L.pressArrow(page2, 'right'); await page2.waitForTimeout(800);
        await L.pressArrow(page2, 'right'); await page2.waitForTimeout(800);
        const afterScroll = await L.pageInfo(page2);
        const mv5 = await nextMovement(page2);
        const expectedNext = starts[3]; // début du mouvement 5
        L.record(results, '2. Mouvement suivant après défilement dans un mouvement (départ du mouvement 5)', pageName,
          mv5.after.page === expectedNext ? 'OK' : 'ÉCHEC',
          `mouvement 4 démarré p.${mv4.after.page}, après 2 pages p.${afterScroll.page} (scrollTop ${afterScroll.scrollTop}), ` +
          `« mouvement suivant » → p.${mv5.after.page} (scrollTop ${mv5.after.scrollTop}), attendu p.${expectedNext}`);
        await page2.click('.nav-btn[data-action="prev-mov"]');
        await page2.waitForTimeout(1200);
        const prev = await L.pageInfo(page2);
        const expectedPrev = starts[2]; // début du mouvement 4
        L.record(results, '2. Mouvement précédent après défilement (départ du mouvement 4)', pageName,
          prev.page === expectedPrev ? 'OK' : 'ÉCHEC',
          `« mouvement précédent » → p.${prev.page} (scrollTop ${prev.scrollTop}), attendu p.${expectedPrev}`);
        const relevant = L.summarize(errors2);
        L.record(results, '6. Erreurs JS (dossier, mixte)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
      } catch (e) {
        L.record(results, '2. Mouvement suivant après défilement', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
      }
      await ctx2.close();
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (dossier, parcours)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '2. Dossier Magnificat (bouton dossier)', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // B. réouverture à la page mémorisée d'un mouvement tardif
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await importFolderAndWait(page);
      await L.resetScrollTop(page);
      const starts = [];
      for (let i = 0; i < 9; i++) {
        const r = await nextMovement(page);
        if (r.after.page === r.before.page) break;
        starts.push(r.after.page);
      }
      await L.pressArrow(page, 'right'); await page.waitForTimeout(900);
      await L.pressArrow(page, 'right'); await page.waitForTimeout(1200);
      const before = await L.pageInfo(page);
      await page.waitForTimeout(2500);
      const positions = await dbPositions(page);
      const after = await reopenFolder(page);
      const ok = after.page === before.page;
      L.record(results, '2. Réouverture à la page mémorisée (mouvement 10, page suivante)', pageName,
        ok ? 'OK' : 'ÉCHEC',
        `débuts des mouvements suivants ${starts.join(',')} ; avant ${before.page}/${before.total} (scrollTop ${before.scrollTop}), ` +
        `position en base ${JSON.stringify(positions.map((p) => p.page))}, après réouverture ${after.page}/${after.total}`);
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (dossier, position)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '2. Réouverture page mémorisée', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // C. sélection multiple de 12 fichiers (sans webkitdirectory)
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await L.importFiles(page, MSCZ);
      const first = await L.waitFirstSvg(page, 180000);
      const infoFirst = await L.pageInfo(page);
      await L.waitBackgroundLoaded(page, 300000);
      await page.waitForTimeout(800);
      const infoAll = await L.pageInfo(page);
      await L.openLibrary(page);
      const entries = await L.libraryEntries(page);
      const ok = entries.length === 1 && /12 fichiers/.test(entries[0].meta || '') &&
        first.backgroundLoading === true && infoAll.total > infoFirst.total;
      L.record(results, '2. Dossier par sélection multiple : une entrée « 12 fichiers », premier affichage précoce', pageName,
        ok ? 'OK' : 'ÉCHEC',
        JSON.stringify({ entries, firstTotal: infoFirst.total, allTotal: infoAll.total, background: first.backgroundLoading }));
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (sélection multiple)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '2. Dossier par sélection multiple', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // D. suppression de l'entrée pendant le chargement de fond
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 8 });
      await page.setInputFiles('#folder-input', DIR);
      const first = await L.waitFirstSvg(page, 300000);
      const infoAtFirst = await L.pageInfo(page);
      const inProgress = infoAtFirst.loadingHidden === false;
      await L.openLibrary(page);
      const entries = await L.libraryEntries(page);
      const firstEntryName = entries[0]?.name;
      await page.click('#library-list .library-item:nth-child(1) .library-item-delete');
      await page.waitForTimeout(500);
      const afterDelete = await L.pageInfo(page);
      const pending = await dbFiles(page);
      const toast = await page.evaluate(() => {
        const t = document.querySelector('.library-toast');
        return t ? {
          text: t.querySelector('.library-toast-text')?.textContent || '',
          undo: t.querySelector('.library-toast-undo')?.textContent || '',
          undoHeight: Math.round(t.querySelector('.library-toast-undo')?.getBoundingClientRect().height || 0),
        } : null;
      });
      const listAfterDelete = await page.$$eval('#library-list .library-empty, #library-list .library-item',
        (els) => els.map((e) => e.textContent.trim().slice(0, 40)));
      const deferredOk = entries.length === 1 && afterDelete.svgCount === 0 && afterDelete.importHidden === false &&
        pending.length === 1 && (toast?.text || '').includes(`${firstEntryName} supprimé`) &&
        toast?.undo === 'Annuler' && toast.undoHeight >= 44 &&
        listAfterDelete.some((t) => /Aucun fichier/.test(t));
      L.record(results, '2. Suppression différée : entrée masquée, données gardées, bandeau « Annuler »', pageName,
        inProgress && deferredOk ? 'OK' : 'ÉCHEC',
        `chargement en cours : ${inProgress} ; 1er SVG ${first.ms} ms (${infoAtFirst.total} pages annoncées), ` +
        `SVG=${afterDelete.svgCount}, fichiers en base=${pending.length}, bandeau=${JSON.stringify(toast)}, liste=${JSON.stringify(listAfterDelete)}`);

      // « Annuler » restaure l'entrée et ses données.
      await page.click('.library-toast-undo');
      await page.waitForTimeout(700);
      const restoredEntries = await L.libraryEntries(page);
      const restoredFiles = await dbFiles(page);
      const toastGone = await page.$$eval('.library-toast', (els) => els.length);
      const undoOk = restoredEntries.length === 1 && restoredFiles.length === 1 && toastGone === 0;
      L.record(results, '2. Annuler restaure l\'entrée et ses données', pageName,
        undoOk ? 'OK' : 'ÉCHEC',
        `entrées=${JSON.stringify(restoredEntries)}, fichiers en base=${restoredFiles.length}, bandeaux=${toastGone}`);

      // Nouvelle suppression, confirmée à l'expiration du délai.
      await page.click('#library-list .library-item:nth-child(1) .library-item-delete');
      await page.waitForTimeout(7000);
      const later = await L.pageInfo(page);
      const files = await dbFiles(page);
      const list = await page.$$eval('#library-list .library-empty, #library-list .library-item',
        (els) => els.map((e) => e.textContent.trim().slice(0, 40)));
      const toastAfter = await page.$$eval('.library-toast', (els) => els.length);
      const clearHidden = await page.evaluate(() => document.getElementById('library-clear-btn').classList.contains('hidden'));
      const expiredOk = files.length === 0 && list.some((t) => /Aucun fichier/.test(t)) &&
        toastAfter === 0 && later.importHidden === false && clearHidden;
      L.record(results, '2. Suppression confirmée à l\'expiration (6 s)', pageName,
        expiredOk ? 'OK' : 'ÉCHEC',
        `fichiers en base=${files.length}, bandeaux=${toastAfter}, liste=${JSON.stringify(list)}, « Tout effacer » ${clearHidden ? 'masqué' : 'VISIBLE'}`);
      const spinnerGone = later.loadingHidden === true;
      L.record(results, '2. Suppression pendant le chargement : indicateur de chargement rangé', pageName,
        spinnerGone ? 'OK' : 'ÉCHEC',
        `7 s après la suppression : loading-indicator ${later.loadingHidden ? 'masqué' : 'TOUJOURS VISIBLE'}, page affichée ${later.page}/${later.total}, SVG=${later.svgCount}`);
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (suppression pendant chargement)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '2. Suppression pendant le chargement', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
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
  console.log('\n=== RÉSUMÉ S2 ===');
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  server.close();
})();
