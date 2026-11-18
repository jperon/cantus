// Scénario 6e — robustesse de la lecture : changement de fichier ou
// redimensionnement pendant la lecture, erreur de données de lecture et MIDI
// vide. index.html et spa.html.
const C = require('./s6-common');
const L = C.L;
const {
  WAIT, bounded, waitReady, waitFirstSvg, waitBackgroundLoaded, reloadPage,
  state, waitState, transportHidden, positionGrowing, horizontalScrollPos,
  seekFraction, alignedOnSystem, storedParts, partVolumeValues, playbackSample,
  displayedPageNumber, waitLibraryReady, MOVEMENTS_FIXTURE,
} = C;

async function runPage(browser, url, pageName, results) {
  // Robustesse : changer de fichier ou redimensionner pendant la lecture,
  // puis les chemins d'erreur (MIDI vide, mouvement sans données).
  {
    const { page, ctx: ctx5, errors: errors5 } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(800);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForTimeout(400);

      // Changement de fichier en pleine lecture : la lecture est arrêtée,
      // le nouveau document se charge, aucune exception JS.
      await L.importFile(page, MOVEMENTS_FIXTURE);
      await waitFirstSvg(page);
      await bounded('arrêt après changement de fichier', WAIT.playbackStop, page.waitForFunction(() => {
        const s = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
        return s && s.state === 'stopped' && s.position === 0;
      }, null, { timeout: WAIT.playbackStop, polling: 100 }));
      const afterChange = await state(page);
      L.record(results, '6. Changement de fichier pendant la lecture : lecture arrêtée', pageName,
        afterChange.state === 'stopped' && afterChange.position === 0 ? 'OK' : 'ÉCHEC',
        `état ${afterChange.state}, position ${afterChange.position} ms, transport masqué ${await transportHidden(page)}`);

      // Rotation / redimensionnement pendant la lecture : le re-rendu repart
      // de zéro sans laisser le transport en lecture.
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.setViewportSize({ width: 900, height: 500 });
      await bounded('arrêt après redimensionnement', WAIT.playbackStop, page.waitForFunction(() => {
        const s = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
        return s && s.state === 'stopped';
      }, null, { timeout: WAIT.playbackStop, polling: 150 }));
      const afterResize = await state(page);
      L.record(results, '6. Redimensionnement pendant la lecture : lecture arrêtée', pageName,
        afterResize.state === 'stopped' ? 'OK' : 'ÉCHEC',
        `état ${afterResize.state}, position ${afterResize.position} ms`);
      await page.setViewportSize({ width: 500, height: 900 });
      await page.waitForTimeout(400);
    } catch (e) {
      L.record(results, '6. Robustesse lecture', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errors5);
    L.record(results, '6. Erreurs JS (changement de fichier / redimensionnement)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctx5.close();
  }

  // Chemins d'erreur : message playbackError et données de lecture vides.
  // On intercepte getPlaybackData pour injecter la réponse sans dépendre du
  // worker réel ; l'application doit masquer le transport sans erreur JS.
  {
    const { page, ctx: ctx6, errors: errors6 } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(600);
      await page.evaluate(() => {
        const w = window.__musicaWorker;
        w.__testPostMessage = w.postMessage.bind(w);
        w.postMessage = function (msg) {
          if (msg && msg.type === 'getPlaybackData') return;
          return w.__testPostMessage(msg);
        };
      });

      await page.click('#transport-play');
      await page.evaluate(() => {
        window.__musicaWorker.onmessage({
          data: { type: 'playbackError', movementId: 1, message: 'MIDI vide (test)' },
        });
      });
      await waitState(page, 'stopped');
      const afterError = await state(page);
      const hiddenAfterError = await transportHidden(page);
      L.record(results, '6. Erreur de données de lecture : transport masqué, état arrêté', pageName,
        afterError.state === 'stopped' && hiddenAfterError ? 'OK' : 'ÉCHEC',
        `état ${afterError.state}, transport masqué ${hiddenAfterError}`);

      // Le transport est masqué après l'erreur : le raccourci clavier reste
      // le moyen de relancer une demande de lecture.
      await page.keyboard.press('p');
      await page.evaluate(() => {
        window.__musicaWorker.onmessage({
          data: {
            type: 'playbackData', movementId: 1, midi: '', syncMarks: [],
            staffLabels: [], trackMap: {}, duration: 0,
          },
        });
      });
      await waitState(page, 'stopped');
      const afterEmpty = await state(page);
      const hiddenAfterEmpty = await transportHidden(page);
      L.record(results, '6. MIDI vide (durée nulle) : transport masqué, pas de lecture', pageName,
        afterEmpty.state === 'stopped' && hiddenAfterEmpty && afterEmpty.position === 0 ? 'OK' : 'ÉCHEC',
        `état ${afterEmpty.state}, position ${afterEmpty.position} ms, transport masqué ${hiddenAfterEmpty}`);
    } catch (e) {
      L.record(results, '6. Chemins d\'erreur de lecture', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errors6);
    L.record(results, '6. Erreurs JS (chemins d\'erreur)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctx6.close();
  }
}

// Durées observées le 18/11/2026 (index.html + spa.html) : 14 à 28 s selon la
// charge ; budget large (fichier court, on garde surtout de quoi diagnostiquer
// un blocage).
C.main(runPage, { budgetMs: 120000, summary: 'S6E' });
