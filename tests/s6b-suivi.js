// Scénario 6b — suivi du défilement et cale de la tête de lecture sur la page
// affichée : suivi horizontal (Fauré), sauts avant/arrière, granularité en
// demi-pages, puis cale au premier marqueur de la page après un changement de
// page. index.html et spa.html.
const C = require('./s6-common');
const L = C.L;
const {
  WAIT, bounded, waitReady, waitFirstSvg, waitBackgroundLoaded, reloadPage,
  state, waitState, transportHidden, positionGrowing, horizontalScrollPos,
  seekFraction, alignedOnSystem, storedParts, partVolumeValues, playbackSample,
  displayedPageNumber, waitLibraryReady,
} = C;

async function runPage(browser, url, pageName, results) {
  // Suivi en mode horizontal (Fauré : une page = un système) : la page
  // affichée change et contient toujours un SVG, y compris en revenant en
  // arrière.
  {
    const { page, ctx: ctx3, errors: errors3 } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      await L.importFile(page, L.FILES.faureMscz);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(800);
      const first = await L.pageInfo(page);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      const seen = [];
      let horizontalOk = true;
      for (const fraction of [0.1, 0.3, 0.5, 0.2]) {
        await seekFraction(page, fraction);
        await page.waitForTimeout(400);
        // Le rendu de la page cible est asynchrone : attendre son SVG plutôt
        // qu'une durée fixe (la campagne complète ralentit le worker).
        await bounded('rendu de la page cible (suivi horizontal)', WAIT.pageRendered, page.waitForFunction(() => {
          const txt = document.getElementById('page-number')?.textContent || '';
          const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
          const top = m ? parseInt(m[1], 10) : null;
          const pages = [...document.querySelectorAll('#page-current .scroll-page')].map((d) => ({
            page: parseInt(d.dataset.page, 10),
            hasSvg: !!d.querySelector('svg'),
          }));
          const topPage = pages.find((p) => p.page === top);
          return !!(topPage && topPage.hasSvg && pages.some((p) => p.hasSvg));
        }, null, { timeout: WAIT.pageRendered, polling: 100 }));
        const view = await page.evaluate(() => {
          const txt = document.getElementById('page-number')?.textContent || '';
          const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
          const top = m ? parseInt(m[1], 10) : null;
          const pages = [...document.querySelectorAll('#page-current .scroll-page')].map((d) => ({
            page: parseInt(d.dataset.page, 10),
            hasSvg: !!d.querySelector('svg'),
          }));
          const topPage = pages.find((p) => p.page === top);
          return { top, pages, topHasSvg: !!(topPage && topPage.hasSvg) };
        });
        const hasAnySvg = view.pages.some((p) => p.hasSvg);
        horizontalOk = horizontalOk && view.topHasSvg && hasAnySvg;
        seen.push(`p.${view.top}`);
      }
      const wentForward = seen[0] !== seen[1] && seen[1] !== seen[2];
      const wentBack = parseInt(seen[3].slice(2), 10) < parseInt(seen[2].slice(2), 10);
      L.record(results, '6. Suivi horizontal : sauts avant/arrière sans page blanche', pageName,
        horizontalOk && wentForward && wentBack ? 'OK' : 'ÉCHEC',
        `page de départ p.${first.page}, cibles ${seen.join(' → ')}, SVG affiché : ${horizontalOk}`);

      // Granularité : pendant la lecture naturelle (sans saut), le suivi doit
      // parcourir les DEUX demi-pages d'une même page, +1 cran à la fois et
      // sans revenir en arrière. On part à ~6 s (page 2, première moitié) :
      // scoretk ne pose qu'un marqueur par début de mesure, et la page 1 de
      // Fauré n'a qu'une mesure (t = 0), donc partir plus tôt ferait traverser
      // deux demi-pages d'un coup sans second marqueur.
      const duration = (await state(page)).duration;
      const startMs = 6000;
      await seekFraction(page, startMs / duration);
      await page.waitForTimeout(700);
      const startPos = await horizontalScrollPos(page);
      const follow = await page.evaluate((until) => new Promise((resolve) => {
        const read = () => {
          const first = document.querySelector('#page-current .scroll-page');
          const wrapper = document.querySelector('#page-current .scroll-wrapper');
          if (!first || !wrapper) return null;
          const pageNumber = parseInt(first.dataset.page, 10);
          if (!Number.isFinite(pageNumber)) return null;
          const m = /translateX\(-([\d.]+)vw\)/.exec(wrapper.style.transform || '');
          const half = m && parseFloat(m[1]) >= 25 ? 1 : 0;
          return (pageNumber - 1) * 2 + half;
        };
        const changes = [];
        const t0 = performance.now();
        const timer = setInterval(() => {
          const pos = read();
          if (pos != null && changes[changes.length - 1] !== pos) changes.push(pos);
          const now = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
          if ((now && now.position >= until) || performance.now() - t0 > 25000) {
            clearInterval(timer);
            resolve({ changes, endPosition: now ? now.position : null, ms: performance.now() - t0 });
          }
        }, 50);
      }), startMs + 12000);
      const changes = follow.changes;
      const diffs = changes.slice(1).map((p, i) => p - changes[i]);
      const forwardOnly = diffs.every((d) => d >= 0);
      const oneHalfMax = diffs.every((d) => d <= 1);
      const hasEven = changes.some((p) => p % 2 === 0);
      const hasOdd = changes.some((p) => p % 2 === 1);
      const bothHalvesOfOnePage = changes.some((p, i) =>
        i > 0 && p === changes[i - 1] + 1 && Math.floor(p / 2) === Math.floor(changes[i - 1] / 2));
      const pageChanges = diffs.filter((d, i) =>
        Math.floor(changes[i + 1] / 2) !== Math.floor(changes[i] / 2)).length;
      const halfTransitions = Math.max(0, changes.length - 1 - pageChanges);
      const perMinute = (n) => follow.ms > 0 ? Math.round((n * 60000) / follow.ms) : 0;
      L.record(results, '6. Suivi horizontal : demi-pages paires et impaires, +1 cran max, sans retour', pageName,
        startPos != null && hasEven && hasOdd && bothHalvesOfOnePage &&
          forwardOnly && oneHalfMax ? 'OK' : 'ÉCHEC',
        `départ ${startPos}, suite ${changes.join(' → ')} (${follow.ms.toFixed(0)} ms, fin ${follow.endPosition} ms), ` +
        `paires ${hasEven}, impaires ${hasOdd}, deux moitiés d’une page ${bothHalvesOfOnePage}, ` +
        `deltas [${diffs.join(',')}], avant seulement ${forwardOnly}, max 1 ${oneHalfMax}`);
      L.record(results, '6. Granularité horizontale : ~2 changements par page, dont une demi-page', pageName,
        oneHalfMax && halfTransitions >= 1 ? 'OK' : 'ÉCHEC',
        `${changes.length - 1} changements (${perMinute(changes.length - 1)}/min) dont ${pageChanges} changements de page ` +
        `et ${halfTransitions} demi-pages (${perMinute(halfTransitions)}/min) ; ancien suivi page entière : ${perMinute(pageChanges)}/min`);
      await page.click('#transport-stop');
    } catch (e) {
      L.record(results, '6. Suivi horizontal', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errors3);
    L.record(results, '6. Erreurs JS (suivi horizontal)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctx3.close();
  }

  // Cale de la tête de lecture sur la page affichée : un changement de page
  // (défilement manuel, boutons, goto) amène la lecture au premier marqueur de
  // cette page, après un debounce. Le suivi automatique ne doit pas provoquer
  // de seek en retour (drapeau anti-boucle).
  {
    const { page, ctx: ctxSeek, errors: errorsSeek } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(800);

      // Temps du premier marqueur de chaque page (telemann : une page par
      // mouvement de 30 s). Les marqueurs sont en ms, la page est locale au
      // mouvement.
      const sample = await playbackSample(page, 1);
      const firstOfPage = {};
      for (const mark of sample.syncMarks) {
        if (!(mark.page in firstOfPage)) firstOfPage[mark.page] = mark.t;
      }

      // 1. Aucune donnée de lecture chargée : changer de page ne doit déclencher
      // ni chargement (getPlaybackData) ni déplacement.
      await page.evaluate(() => {
        const w = window.__musicaWorker;
        window.__pbRequestsAfterChange = 0;
        const orig = w.postMessage.bind(w);
        w.__testPostMessage = orig;
        w.postMessage = function (msg) {
          if (msg && msg.type === 'getPlaybackData') window.__pbRequestsAfterChange += 1;
          return orig(msg);
        };
      });
      await L.tap(page, 'right');
      await bounded('changement de page', WAIT.pageChange, L.waitPageChange(page, 1, WAIT.pageChange));
      await page.waitForTimeout(700);
      const noData = await page.evaluate(() => ({
        page: (() => {
          const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
          return m ? parseInt(m[1], 10) : null;
        })(),
        state: window.__musicaPlaybackState(),
        requests: window.__pbRequestsAfterChange,
      }));
      const noDataOk = noData.page === 2 && noData.state.state === 'stopped' &&
        noData.state.position === 0 && noData.state.hasData === false && noData.requests === 0;
      L.record(results, '6. Sans données : changer de page ne charge rien et ne déplace pas la lecture', pageName,
        noDataOk ? 'OK' : 'ÉCHEC',
        `page ${noData.page}, état ${noData.state.state}, position ${noData.state.position} ms, ` +
        `données ${noData.state.hasData}, demandes getPlaybackData ${noData.requests}`);

      // 2. Lecture en cours + page suivante : la tête se cale au premier
      // marqueur de la nouvelle page et la lecture continue. La page de départ
      // est lue après stabilisation du suivi (il peut ramener l'écran sur la
      // page de la position courante, ici le début).
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForTimeout(600);
      const playingStartPage = await displayedPageNumber(page);
      await L.tap(page, 'right');
      const targetPlayingPage = playingStartPage + 1;
      const targetPlaying = firstOfPage[targetPlayingPage];
      let reachedPlaying = null;
      try {
        reachedPlaying = await bounded('cale de la tête sur la nouvelle page', WAIT.seekToPage,
          page.waitForFunction(({ target, expected }) => {
            const s = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
            const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
            const shown = m ? parseInt(m[1], 10) : null;
            if (!s || shown !== expected) return false;
            return Math.abs(s.position - target) <= 150 ? { position: s.position, state: s.state } : false;
          }, { target: targetPlaying, expected: targetPlayingPage },
          { timeout: WAIT.seekToPage, polling: 20 }).then((h) => h.jsonValue()));
      } catch {
        reachedPlaying = null;
      }
      const playingAfter = await state(page);
      const playingPage = await displayedPageNumber(page);
      L.record(results, '6. Lecture en cours + page suivante : tête calée au premier marqueur, lecture poursuivie', pageName,
        reachedPlaying && reachedPlaying.state === 'playing' && playingPage === targetPlayingPage ? 'OK' : 'ÉCHEC',
        `page ${playingStartPage} → ${targetPlayingPage}, cible ${targetPlaying} ms, ` +
        `position atteinte ${reachedPlaying ? reachedPlaying.position : 'aucune'} ms ` +
        `(constatée ${playingAfter.position} ms), état ${playingAfter.state}`);
      await page.click('#transport-stop');
      await waitState(page, 'stopped');

      // 3. Lecture arrêtée + page suivante : la position est calée sur le début
      // de la page, et un appui sur lecture démarre à cet endroit.
      const stoppedStartPage = await displayedPageNumber(page);
      const targetStoppedPage = stoppedStartPage + 1;
      const targetStopped = firstOfPage[targetStoppedPage];
      await L.tap(page, 'right');
      await page.waitForTimeout(700);
      const stoppedSeek = await state(page);
      const stoppedPage = await displayedPageNumber(page);
      const stoppedOk = stoppedPage === targetStoppedPage && stoppedSeek.state === 'stopped' &&
        Math.abs(stoppedSeek.position - targetStopped) <= 150;
      L.record(results, '6. Lecture arrêtée + page suivante : position calée sur le début de page', pageName,
        stoppedOk ? 'OK' : 'ÉCHEC',
        `page ${stoppedStartPage} → ${stoppedPage}, position ${stoppedSeek.position} ms ` +
        `(cible ${targetStopped} ms), état ${stoppedSeek.state}`);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      const resumed = await state(page);
      const resumedOk = Math.abs(resumed.position - targetStopped) <= 150;
      L.record(results, '6. Lecture après cale : démarre au début de la page affichée', pageName,
        resumedOk ? 'OK' : 'ÉCHEC',
        `position ${resumed.position} ms (cible ${targetStopped} ms), état ${resumed.state}`);

      // 4. Pas d'oscillation : après un changement de page en pause, la page et
      // la position restent stables sans nouvelle action.
      await page.waitForTimeout(400);
      await page.click('#transport-play');
      await waitState(page, 'paused');
      const pausedStartPage = await displayedPageNumber(page);
      const targetPausedPage = pausedStartPage + 1;
      const targetPaused = firstOfPage[targetPausedPage];
      await L.tap(page, 'right');
      await page.waitForTimeout(700);
      const stable1 = { state: await state(page), page: await displayedPageNumber(page) };
      await page.waitForTimeout(1000);
      const stable2 = { state: await state(page), page: await displayedPageNumber(page) };
      const stableOk = stable1.page === targetPausedPage && stable2.page === targetPausedPage &&
        stable1.state.state === 'paused' && stable2.state.state === 'paused' &&
        Math.abs(stable1.state.position - targetPaused) <= 150 &&
        Math.abs(stable2.state.position - stable1.state.position) <= 100;
      L.record(results, '6. Pas d’oscillation : page et position stables après la cale', pageName,
        stableOk ? 'OK' : 'ÉCHEC',
        `page ${pausedStartPage} → p.${stable1.page}/${stable1.state.position} ms → p.${stable2.page}/${stable2.state.position} ms ` +
        `(cible ${targetPaused} ms, états ${stable1.state.state}/${stable2.state.state})`);

      // 5. Suivi désactivé : la cale manuelle reste active (comportement
      // indépendant du réglage followPlayback).
      await page.click('#transport-stop');
      await waitState(page, 'stopped');
      await L.openSettings(page);
      await page.$eval('#follow-playback', (el) => {
        el.checked = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await L.closeSettings(page);
      const followOffStartPage = await displayedPageNumber(page);
      const targetFollowOffPage = followOffStartPage + 1;
      const targetFollowOff = firstOfPage[targetFollowOffPage];
      await L.tap(page, 'right');
      await page.waitForTimeout(700);
      const followOffSeek = await state(page);
      const followOffPage = await displayedPageNumber(page);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      const followOffPlay = await state(page);
      const followOffOk = followOffPage === targetFollowOffPage && followOffSeek.state === 'stopped' &&
        Math.abs(followOffSeek.position - targetFollowOff) <= 150 &&
        Math.abs(followOffPlay.position - targetFollowOff) <= 150;
      L.record(results, '6. followPlayback=false : la cale manuelle sur la page reste active', pageName,
        followOffOk ? 'OK' : 'ÉCHEC',
        `page ${followOffStartPage} → ${followOffPage}, arrêté ${followOffSeek.position} ms, ` +
        `lecture ${followOffPlay.position} ms (cible ${targetFollowOff} ms)`);
      await page.click('#transport-stop');
      // Réactiver le suivi pour ne pas laisser de réglage inattendu
      await L.openSettings(page);
      await page.$eval('#follow-playback', (el) => {
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await L.closeSettings(page);
    } catch (e) {
      L.record(results, '6. Cale de la lecture sur la page affichée', pageName, 'ÉCHEC',
        'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errorsSeek);
    L.record(results, '6. Erreurs JS (cale de lecture sur la page)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctxSeek.close();
  }

  // Fixture synthétique : deux parties, chacune dans un <part-group>. Masquer
  // la seconde vide son groupe ; Verovio rend encore les pages mais n'émet
  // plus de timemap du tout, donc plus aucun marqueur de suivi alors que la
  // lecture continue. La correction retire les part-group devenus caducs.
  {
    const { page, ctx: ctxGroups, errors: errorsGroups } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      await L.importFile(page, L.FILES.suiviGroupesXml);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(600);
      const before = await playbackSample(page, 1);

      // Masquer la seconde partie (Réduction) : son part-group devient vide.
      await L.markSvg(page);
      await L.openSettings(page);
      await page.waitForFunction(
        () => document.querySelectorAll('#parts-list .part-row').length >= 2,
        null, { timeout: WAIT.pageChange, polling: 100 });
      await page.click('#parts-list .part-display >> nth=1');
      let hidden = true;
      try {
        await page.waitForFunction(() => {
          const row = document.querySelectorAll('#parts-list .part-row')[1];
          const button = row && row.querySelector('.part-display');
          return !!button && button.getAttribute('aria-pressed') === 'false';
        }, null, { timeout: WAIT.pageChange, polling: 100 });
      } catch {
        hidden = false;
      }
      await L.closeSettings(page);
      await bounded('re-rendu après masquage d’une voix groupée', WAIT.backgroundLoaded,
        page.waitForFunction(
          () => !document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
          null, { timeout: WAIT.backgroundLoaded, polling: 100 }));
      await page.waitForSelector('#page-current .scroll-page svg', { timeout: WAIT.pageRendered });
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(800);

      // Le worker fait foi : il reconstruit les marqueurs sur le XML rechargé.
      const after = await playbackSample(page, 1);
      L.record(results, '6. Voix groupée masquée : les marqueurs de suivi restent', pageName,
        hidden && before.syncMarks.length > 0 && after.syncMarks.length === before.syncMarks.length
          ? 'OK' : 'ÉCHEC',
        `marqueurs ${before.syncMarks.length} → ${after.syncMarks.length} après masquage ` +
        `(voix masquée : ${hidden})`);

      // Lecture puis saut : la page doit suivre les marqueurs retrouvés.
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForTimeout(500);
      const appData = await page.evaluate(() => window.__musicaPlaybackProbe());
      const pages = (await L.pageInfo(page)).total;
      let followOk = true;
      let detail = `${appData.syncMarksCount} marqueur(s) dans l’application, ${pages} page(s)`;
      if (pages > 1) {
        const from = await displayedPageNumber(page);
        // Viser le premier marqueur de la page suivante : la fraction est la
        // même dans le temps source et dans le temps de lecture (mise à
        // l'échelle du tempo).
        const next = after.syncMarks.find((mark) => Number(mark.page) > 1);
        const fraction = next && after.duration > 0
          ? Math.min(0.99, (Number(next.t) + 500) / after.duration)
          : 0.9;
        await seekFraction(page, fraction);
        followOk = false;
        try {
          await bounded('suivi après masquage d’une voix groupée', WAIT.seekToPage,
            page.waitForFunction((prev) => {
              const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
              return m && parseInt(m[1], 10) !== prev;
            }, from, { timeout: WAIT.seekToPage, polling: 100 }));
          followOk = true;
        } catch {
          // laissé à false : la page n'a pas suivi
        }
        detail += `, page ${from} → ${await displayedPageNumber(page)}`;
      }
      L.record(results, '6. Voix groupée masquée : le défilement suit la lecture', pageName,
        appData.syncMarksCount === before.syncMarks.length && followOk ? 'OK' : 'ÉCHEC', detail);
      await page.click('#transport-stop');
    } catch (e) {
      L.record(results, '6. Voix groupée masquée', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errorsGroups);
    L.record(results, '6. Erreurs JS (voix groupée masquée)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctxGroups.close();
  }

}

// Durées observées le 18/11/2026 (index.html + spa.html) : 53 à 71 s selon
// la charge ; budget ~2,5× le maximum.
C.main(runPage, { budgetMs: 180000, summary: 'S6B' });
