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

  // Chemins d'erreur : le préchargement de l'ouverture est piégé
  // (interception de getPlaybackData AVANT l'import). Une erreur ou des
  // données vides au préchargement laissent le transport visible et la barre
  // inactive ; un ▶ sur le même chemin masque ensuite le transport, comme
  // avant. Deux contextes indépendants : erreur, puis données vides.
  const runPreloadFailure = async (kind) => {
    const empty = kind === 'vide';
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      // Le préchargement est posté après le chargement du mouvement : piéger
      // getPlaybackData dès maintenant évite qu'il aboutisse avant le test.
      await page.evaluate(() => {
        const w = window.__musicaWorker;
        window.__pbDropped = 0;
        w.__testPostMessage = w.postMessage.bind(w);
        w.postMessage = function (msg) {
          if (msg && msg.type === 'getPlaybackData') {
            window.__pbDropped += 1;
            return;
          }
          return w.__testPostMessage(msg);
        };
      });
      const snapshot = () => page.evaluate(() => ({
        hidden: document.getElementById('transport').classList.contains('hidden'),
        disabled: document.getElementById('transport-seek').disabled,
        state: window.__musicaPlaybackState(),
        dropped: window.__pbDropped,
      }));
      // Même réponse que le worker pour une erreur (playbackError) ou un MIDI
      // vide (playbackData à durée nulle et sans marqueur).
      const inject = () => page.evaluate((isEmpty) => {
        window.__musicaWorker.onmessage({
          data: isEmpty
            ? {
                type: 'playbackData', movementId: 1, midi: '', syncMarks: [],
                staffLabels: [], trackMap: {}, duration: 0,
              }
            : { type: 'playbackError', movementId: 1, message: 'MIDI vide (test)' },
        });
      }, empty);

      await L.importFile(page, L.FILES.telemannXml);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await bounded('préchargement intercepté', WAIT.playbackData, page.waitForFunction(
        () => window.__pbDropped >= 1, null, { timeout: WAIT.playbackData, polling: 50 }));
      await page.waitForTimeout(200);
      const before = await snapshot();
      await inject();
      await page.waitForTimeout(300);
      const preload = await snapshot();
      L.record(results, `6. ${empty ? 'Données vides' : 'Erreur'} au préchargement : transport visible, barre désactivée, état arrêté`, pageName,
        preload.hidden === false && preload.disabled === true &&
          preload.state.state === 'stopped' && preload.state.hasData === false &&
          preload.state.duration === 0 && preload.state.position === 0 &&
          before.disabled === true ? 'OK' : 'ÉCHEC',
        `demandes interceptées ${before.dropped}, transport visible ${!preload.hidden}, ` +
        `barre désactivée ${preload.disabled}, état ${preload.state.state}, ` +
        `données ${preload.state.hasData}, durée ${preload.state.duration} ms, ` +
        `position ${preload.state.position} ms`);

      // ▶ sur le même chemin : erreur injectée pendant le chargement, ou
      // données vides déjà en cache mémoire. Le transport est masqué et la
      // lecture ne démarre pas.
      const beforePlay = await snapshot();
      await page.click('#transport-play');
      if (!empty) {
        await bounded('état loading avant injection', WAIT.transportState,
          page.waitForFunction(() => window.__musicaPlaybackState?.().state === 'loading',
            null, { timeout: WAIT.transportState, polling: 20 }));
        await inject();
      }
      await waitState(page, 'stopped');
      await page.waitForTimeout(150);
      const played = await snapshot();
      L.record(results,
        empty
          ? '6. MIDI vide (durée nulle) : transport masqué, pas de lecture'
          : '6. Erreur de données de lecture : transport masqué, état arrêté',
        pageName,
        played.state.state === 'stopped' && played.hidden === true &&
          (empty ? played.state.position === 0 : true) ? 'OK' : 'ÉCHEC',
        `état ${played.state.state}, position ${played.state.position} ms, ` +
        `transport masqué ${played.hidden}, demandes interceptées ` +
        `${beforePlay.dropped} → ${played.dropped}`);
    } catch (e) {
      L.record(results, `6. Chemins d'erreur de lecture (${kind})`, pageName, 'ÉCHEC',
        'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errors);
    L.record(results, `6. Erreurs JS (chemin d'erreur ${kind})`, pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctx.close();
  };
  await runPreloadFailure('erreur');
  await runPreloadFailure('vide');
}

// Durées observées le 18/11/2026 (index.html + spa.html) : 14 à 28 s selon la
// charge ; budget large (fichier court, on garde surtout de quoi diagnostiquer
// un blocage).
C.main(runPage, { budgetMs: 120000, summary: 'S6E' });
