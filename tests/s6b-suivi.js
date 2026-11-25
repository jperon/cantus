// Scénario 6b — suivi du défilement et cale de la tête de lecture sur la page
// affichée : suivi horizontal (Fauré), sauts avant/arrière, granularité en
// demi-pages, puis cale au premier marqueur de la page après un changement de
// page. index.html et spa.html.
const C = require('./s6-common');
const fs = require('fs');
const path = require('path');
const L = C.L;
const KYRIE = path.join(__dirname, 'fixtures', 'gabc', 'kyrie.gabc');
const {
  WAIT, bounded, waitReady, waitFirstSvg, waitBackgroundLoaded, reloadPage,
  state, waitState, transportHidden, positionGrowing, horizontalScrollPos,
  seekFraction, stopPlayback, alignedOnSystem, storedParts, partVolumeValues, playbackSample,
  displayedPageNumber, waitLibraryReady,
} = C;

async function runPage(browser, url, pageName, results) {
  // Nombre de portées du premier <g class="measure"> de chaque système : la
  // condensation Verovio retire les portées vides système par système.
  // Verovio imbrique un <svg> dans le <svg> de page : ne compter que le SVG
  // de page extérieur, dont querySelectorAll voit déjà les systèmes internes.
  const systemStaffCounts = (page) => page.evaluate(() => [...document.querySelectorAll('#page-current .scroll-page > svg')]
    .flatMap((svg) => [...svg.querySelectorAll('g.system')].map((system) => {
      const measure = system.querySelector('g.measure');
      return measure ? measure.querySelectorAll('g.staff').length : 0;
    })));

  // Le rendu des pages est asynchrone : attendre deux relevés identiques
  // avant de conclure sur le nombre de portées par système.
  const settledSystemStaffCounts = async (page) => {
    let previous = null;
    for (let i = 0; i < 20; i += 1) {
      const current = await systemStaffCounts(page);
      if (previous && JSON.stringify(current) === JSON.stringify(previous)) return current;
      previous = current;
      await page.waitForTimeout(150);
    }
    return previous;
  };
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
      // « Suivre le défilement » actif par défaut : à l'arrêt, la barre de
      // position reste visible et la touche au centre ne la masque pas.
      const barAtStop = await page.evaluate(() => ({
        follow: JSON.parse(localStorage.getItem('musica-settings') || '{}').followPlayback !== false,
        bar: !document.getElementById('command-bar').classList.contains('hidden'),
        transport: !document.getElementById('transport').classList.contains('hidden'),
      }));
      await L.tap(page, 'center');
      await page.waitForTimeout(250);
      const barAfterTap = await page.evaluate(() => ({
        bar: !document.getElementById('command-bar').classList.contains('hidden'),
        transport: !document.getElementById('transport').classList.contains('hidden'),
      }));
      L.record(results, '6. Suivre le défilement : barre de position visible à l’arrêt, touche centrale sans effet', pageName,
        barAtStop.follow && barAtStop.bar && barAtStop.transport && barAfterTap.bar && barAfterTap.transport
          ? 'OK' : 'ÉCHEC',
        `suivi ${barAtStop.follow}, barre ${barAtStop.bar} → ${barAfterTap.bar}, ` +
        `transport ${barAtStop.transport} → ${barAfterTap.transport}`);
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
      await stopPlayback(page);

      // Glissé du curseur à l'arrêt : la vue suit pendant le geste (même
      // fonction de suivi que la lecture), la position de lecture ne bouge
      // qu'au relâchement.
      await L.gotoPage(page, 1);
      await page.waitForTimeout(500);
      const dragStart = {
        page: await displayedPageNumber(page),
        pos: await horizontalScrollPos(page),
        state: await state(page),
      };
      const dragDuration = dragStart.state.duration;
      await page.$eval('#transport-seek', (el, ratio) => {
        el.value = String(Math.round(ratio * 1000));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, 0.5);
      let dragMoved = false;
      try {
        await bounded('défilement pendant le glissé du curseur', WAIT.seekToPage,
          page.waitForFunction((prev) => {
            const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
            return m && parseInt(m[1], 10) !== prev;
          }, dragStart.page, { timeout: WAIT.seekToPage, polling: 50 }));
        dragMoved = true;
      } catch {
        // laissé à false : la vue n'a pas suivi le geste
      }
      const dragDuring = {
        page: await displayedPageNumber(page),
        pos: await horizontalScrollPos(page),
        state: await state(page),
      };
      // Relâchement : comportement de seek existant, la position passe au
      // temps visé.
      await page.$eval('#transport-seek', (el) =>
        el.dispatchEvent(new Event('change', { bubbles: true })));
      await page.waitForTimeout(300);
      const dragAfter = await state(page);
      const dragExpected = 0.5 * dragDuration;
      const dragPreviewOk = dragMoved && dragDuring.pos != null && dragDuring.pos > dragStart.pos &&
        dragDuring.state.position === dragStart.state.position;
      const dragReleaseOk = dragDuration > 0 && Math.abs(dragAfter.position - dragExpected) <= 400;
      L.record(results, '6. Glissé du curseur à l’arrêt : vue déplacée pendant le geste, lecture au relâchement', pageName,
        dragPreviewOk && dragReleaseOk ? 'OK' : 'ÉCHEC',
        `vue ${dragStart.page}@${dragStart.pos} → ${dragDuring.page}@${dragDuring.pos} (déplacée ${dragMoved}), ` +
        `position pendant ${dragDuring.state.position} ms (départ ${dragStart.state.position} ms), ` +
        `relâchement ${dragAfter.position} ms (cible ${Math.round(dragExpected)} ms)`);
      await stopPlayback(page);
      await waitState(page, 'stopped');
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

      // 1. Les données du mouvement affiché sont préchargées à l'ouverture :
      // changer de page ne déclenche aucune nouvelle demande et cale la
      // position sur le début de la page, sans lancer la lecture.
      await bounded('données de lecture préchargées', WAIT.playbackData,
        page.waitForFunction(() => {
          const s = window.__musicaPlaybackState?.();
          return !!(s && s.hasData && s.duration > 0);
        }, null, { timeout: WAIT.playbackData, polling: 50 }));
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
        noData.state.hasData === true &&
        Math.abs(noData.state.position - firstOfPage[2]) <= 150 && noData.requests === 0;
      L.record(results, '6. Données préchargées : changer de page ne recharge rien et cale la position sur la page', pageName,
        noDataOk ? 'OK' : 'ÉCHEC',
        `page ${noData.page}, état ${noData.state.state}, position ${noData.state.position} ms ` +
        `(cible ${firstOfPage[2]} ms), données ${noData.state.hasData}, ` +
        `demandes getPlaybackData ${noData.requests}`);

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
      await stopPlayback(page);
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
      // L'horloge du moteur avance entre beginPlayback et la lecture de
      // l'état (attente « playing » par sondage) : tolérer cette avance.
      const resumedOk = Math.abs(resumed.position - targetStopped) <= 600;
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
      await stopPlayback(page);
      await waitState(page, 'stopped');
      await L.openSettings(page);
      await page.$eval('#follow-playback', (el) => {
        el.checked = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await L.closeSettings(page);
      // Réglage désactivé : la touche au centre retrouve son comportement
      // d'origine (masquer / réafficher).
      await L.tap(page, 'center');
      await page.waitForTimeout(250);
      const barHiddenFollowOff = await page.evaluate(
        () => document.getElementById('command-bar').classList.contains('hidden'));
      await L.tap(page, 'center');
      await page.waitForTimeout(250);
      const barShownFollowOff = await page.evaluate(
        () => !document.getElementById('command-bar').classList.contains('hidden'));
      L.record(results, '6. followPlayback=false : la touche centrale masque puis réaffiche la barre', pageName,
        barHiddenFollowOff && barShownFollowOff ? 'OK' : 'ÉCHEC',
        `masquée ${barHiddenFollowOff}, réaffichée ${barShownFollowOff}`);
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
        Math.abs(followOffPlay.position - targetFollowOff) <= 600;
      L.record(results, '6. followPlayback=false : la cale manuelle sur la page reste active', pageName,
        followOffOk ? 'OK' : 'ÉCHEC',
        `page ${followOffStartPage} → ${followOffPage}, arrêté ${followOffSeek.position} ms, ` +
        `lecture ${followOffPlay.position} ms (cible ${targetFollowOff} ms)`);
      await stopPlayback(page);
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
      await stopPlayback(page);
    } catch (e) {
      L.record(results, '6. Voix groupée masquée', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errorsGroups);
    L.record(results, '6. Erreurs JS (voix groupée masquée)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctxGroups.close();
  }

  // Portées vides masquées (option Verovio « condense ») : la voix Réduction
  // de la fixture ne joue aucune note. Le premier système garde toutes les
  // portées, les suivants sont condensés. La pagination change (variante de
  // cache) ; le suivi, le défilement et le surlignage de mesure doivent rester
  // alignés sur le SVG condensé.
  {
    const { page, ctx: ctxEmpty, errors: errorsEmpty } = await L.newPage(browser, url, {
      pageName, viewport: { width: 600, height: 800 },
    });
    try {
      try { fs.mkdirSync('/tmp/cantus-voix', { recursive: true }); } catch { /* captures */ }
      await waitReady(page);
      await L.importFile(page, L.FILES.suiviGroupesXml);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(600);
      const visibleCounts = await settledSystemStaffCounts(page);
      const visiblePages = (await L.pageInfo(page)).total;
      await page.screenshot({ path: '/tmp/cantus-voix/portees-vides-sans-masquage.png' });

      await page.evaluate(() => {
        for (const svg of document.querySelectorAll('#page-current .scroll-page svg')) {
          svg.setAttribute('data-test-mark', '1');
        }
      });
      await L.openSettings(page);
      await page.check('#hide-empty-staves');
      const savedOption = await page.evaluate(() =>
        JSON.parse(localStorage.getItem('musica-settings') || '{}').hideEmptyStaves);
      await L.closeSettings(page);
      await bounded('re-rendu après condensation des portées vides', WAIT.backgroundLoaded,
        page.waitForFunction(
          () => !document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
          null, { timeout: WAIT.backgroundLoaded, polling: 100 }));
      await page.waitForSelector('#page-current .scroll-page svg', { timeout: WAIT.pageRendered });
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(800);
      // Toutes les pages affichées doivent être celles du nouveau rendu : la
      // dernière page peut arriver après le premier SVG du rechargement.
      await page.waitForFunction(() => {
        const pages = [...document.querySelectorAll('#page-current .scroll-page')];
        return pages.length > 0 && pages.every((div) => !!div.querySelector('svg'));
      }, null, { timeout: WAIT.pageRendered, polling: 100 });

      // Attendre que le rendu condensé soit complet : premier système à deux
      // portées, tous les suivants à une seule, sur toutes les pages.
      let condensedSettled = true;
      try {
        await bounded('condensation des portées vides stabilisée', WAIT.pageRendered,
          page.waitForFunction(() => {
            const pages = [...document.querySelectorAll('#page-current .scroll-page')];
            if (pages.length === 0 || pages.some((div) => !div.querySelector('svg'))) return false;
            const counts = pages.flatMap((div) => {
              const svg = div.querySelector('svg');
              return svg ? [...svg.querySelectorAll('g.system')].map((system) => {
                const measure = system.querySelector('g.measure');
                return measure ? measure.querySelectorAll('g.staff').length : 0;
              }) : [];
            });
            return counts.length > 1 && counts[0] === 2 && counts.slice(1).every((n) => n === 1);
          }, null, { timeout: WAIT.pageRendered, polling: 100 }));
      } catch {
        condensedSettled = false;
      }
      const condensedCounts = await systemStaffCounts(page);
      const condensedPages = (await L.pageInfo(page)).total;
      const countsOk = condensedSettled && visibleCounts.length > 1 &&
        visibleCounts.every((n) => n === 2) &&
        condensedCounts.length > 1 && condensedCounts[0] === 2 &&
        condensedCounts.slice(1).every((n) => n === 1);
      L.record(results, '6. Portées vides : premier système complet, systèmes suivants condensés', pageName,
        countsOk && savedOption === true ? 'OK' : 'ÉCHEC',
        `portées par système avant ${visibleCounts.join('/')}, après ${condensedCounts.join('/')} ` +
        `(premier système 2, suivants 1 : ${countsOk}), option enregistrée ${savedOption}, ` +
        `pages ${visiblePages} → ${condensedPages}`);
      await page.screenshot({ path: '/tmp/cantus-voix/portees-vides-masquees.png' });

      // La variante de cache de rendu porte la condensation : les pages
      // resservies après ce rechargement sont bien celles de l'option active.
      const cacheVariants = await page.evaluate(async () => {
        const keys = await window.__svgCache.keys();
        return keys.map((key) => decodeURIComponent(key));
      });
      const variantOk = cacheVariants.length > 0 &&
        cacheVariants.every((key) => /\|c(?:\||$)/.test(key));
      L.record(results, '6. Portées vides : la condensation entre dans la clé de cache du rendu', pageName,
        variantOk ? 'OK' : 'ÉCHEC',
        `${cacheVariants.length} clé(s), variante « |c » dans toutes : ${variantOk}`);

      // Surlignage de la mesure jouée : rectangle sous les notes, hauteur du
      // système condensé, mis à jour au changement de mesure seulement.
      await L.openSettings(page);
      await page.check('#highlight-measure');
      await L.closeSettings(page);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForSelector('#page-current .measure-highlight', { timeout: WAIT.pageRendered });
      const first = await page.evaluate(() => {
        const rect = document.querySelector('#page-current .measure-highlight');
        const system = rect?.parentNode;
        const rb = rect?.getBBox();
        const sb = system?.getBBox();
        return {
          state: window.__musicaMeasureHighlightState(),
          systemClass: system?.getAttribute('class'),
          parent: rect?.parentNode?.tagName,
          rect: rb ? { x: rb.x, y: rb.y, width: rb.width, height: rb.height } : null,
          system: sb ? { x: sb.x, y: sb.y, width: sb.width, height: sb.height } : null,
          fill: rect ? getComputedStyle(rect).fill : null,
        };
      });
      const geometryOk = first.rect && first.system && first.parent === 'g' &&
        first.systemClass === 'system' &&
        Math.abs(first.rect.height - first.system.height) <= 1.5 &&
        first.rect.width > 0 && first.rect.x >= first.system.x - 1 &&
        first.rect.x + first.rect.width <= first.system.x + first.system.width + 1 &&
        first.fill && first.fill !== 'none';
      // Même mesure sur quelques frames : aucun recalcul (le rectangle ne doit
      // pas être réécrit à chaque frame).
      await page.waitForTimeout(700);
      const second = await page.evaluate(() => window.__musicaMeasureHighlightState());
      const stableSameMeasure = first.state.key !== second.key ||
        first.state.updates === second.updates;
      L.record(results, '6. Mesure surlignée : rectangle de fond sur toute la hauteur du système', pageName,
        geometryOk && first.state.key != null && first.state.updates >= 1 && stableSameMeasure
          ? 'OK' : 'ÉCHEC',
        `mesure ${first.state.key}, ${first.state.updates} mise(s) à jour → ${second.updates}, ` +
        `hauteur ${first.rect?.height?.toFixed(1)} / système ${first.system?.height?.toFixed(1)}, ` +
        `fond ${first.fill}, stable : ${stableSameMeasure}`);

      // Thèmes clair, sépia et sombre : le fond du rectangle change et reste
      // translucide (contraste suffisant, y compris en niveaux de gris).
      const themeFills = await page.evaluate(() => {
        const rect = document.querySelector('#page-current .measure-highlight');
        const body = document.body;
        const fills = {};
        for (const theme of ['white', 'sepia', 'dark']) {
          body.classList.remove('theme-sepia', 'theme-dark');
          if (theme !== 'white') body.classList.add(`theme-${theme}`);
          fills[theme] = getComputedStyle(rect).fill;
        }
        body.classList.remove('theme-sepia', 'theme-dark');
        return fills;
      });
      const alphaOf = (fill) => {
        const m = /rgba?\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(fill);
        return m ? Number(m[1]) : 1;
      };
      const themeOk = new Set(Object.values(themeFills)).size >= 2 &&
        Object.values(themeFills).every((fill) => fill !== 'none' &&
          alphaOf(fill) >= 0.1 && alphaOf(fill) <= 0.3);
      L.record(results, '6. Mesure surlignée : fond adapté aux thèmes clair, sépia et sombre', pageName,
        themeOk ? 'OK' : 'ÉCHEC',
        Object.entries(themeFills).map(([theme, fill]) => `${theme} ${fill}`).join(', '));
      await page.screenshot({ path: '/tmp/cantus-voix/mesure-surlignee.png' });

      // Défilement vertical avec portées condensées : le suivi amène la page
      // suivante et la mesure surlignée appartient bien à cette page.
      const beforeSeek = await displayedPageNumber(page);
      await seekFraction(page, 0.98);
      let pageChanged = false;
      try {
        await bounded('suivi vertical avec portées condensées', WAIT.seekToPage,
          page.waitForFunction((prev) => {
            const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
            return m && parseInt(m[1], 10) !== prev;
          }, beforeSeek, { timeout: WAIT.seekToPage, polling: 100 }));
        pageChanged = true;
      } catch {
        // laissé à false : la page n'a pas suivi
      }
      await page.waitForTimeout(500);
      const followed = await page.evaluate(() => {
        const rect = document.querySelector('#page-current .measure-highlight');
        const pageDiv = rect?.closest('.scroll-page');
        return {
          state: window.__musicaMeasureHighlightState(),
          current: window.__musicaPlaybackCurrentMark(),
          page: pageDiv ? parseInt(pageDiv.dataset.page, 10) : null,
          renderedPages: [...document.querySelectorAll('#page-current .scroll-page')]
            .map((div) => parseInt(div.dataset.page, 10)),
          displayed: (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//)?.[1],
        };
      });
      L.record(results, '6. Portées vides : suivi et surlignage restent alignés après défilement', pageName,
        pageChanged && followed.state.key != null && followed.current.id != null &&
          String(followed.state.key) === String(followed.current.id) &&
          followed.page != null && followed.renderedPages.includes(followed.page) &&
          String(followed.page) === String(followed.current.page) ? 'OK' : 'ÉCHEC',
        `page ${beforeSeek} → ${followed.displayed}, marqueur courant ${followed.current.id} ` +
        `(page ${followed.current.page}), mesure surlignée ${followed.state.key} ` +
        `sur la page ${followed.page} [${followed.renderedPages.join(',')}], ` +
        `mises à jour ${followed.state.updates}`);

      await stopPlayback(page);
      const afterStop = await page.evaluate(() => ({
        rectangles: document.querySelectorAll('.measure-highlight').length,
        state: window.__musicaMeasureHighlightState(),
      }));
      L.record(results, '6. Mesure surlignée : rectangle retiré à l’arrêt', pageName,
        afterStop.rectangles === 0 && afterStop.state.rect === null ? 'OK' : 'ÉCHEC',
        `${afterStop.rectangles} rectangle(s), clé ${afterStop.state.key}`);
    } catch (e) {
      L.record(results, '6. Portées vides et mesure surlignée', pageName, 'ÉCHEC',
        'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errorsEmpty);
    L.record(results, '6. Erreurs JS (portées vides, mesure surlignée)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctxEmpty.close();
  }

  // Barre de position active avant la première lecture : les données du
  // mouvement affiché sont préchargées sans lancer la lecture, si bien que la
  // navigation au curseur et un ▶ depuis une page fonctionnent dès
  // l'ouverture.
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);

      // (a) Aucune lecture lancée : curseur actif, libellé de durée non nul,
      // état arrêté.
      let preloaded = null;
      try {
        await bounded('préchargement des données de lecture', WAIT.playbackData,
          page.waitForFunction(() => {
            const seek = document.getElementById('transport-seek');
            const s = window.__musicaPlaybackState?.();
            return !!(seek && !seek.disabled && s && s.duration > 0);
          }, null, { timeout: WAIT.playbackData, polling: 50 }));
        preloaded = await page.evaluate(() => {
          const seek = document.getElementById('transport-seek');
          const text = document.getElementById('transport-time')?.textContent || '';
          const m = text.match(/^(\d+):(\d{2}) \/ (\d+):(\d{2})$/);
          return {
            state: window.__musicaPlaybackState(),
            disabled: seek?.disabled,
            text,
            total: m ? Number(m[3]) * 60 + Number(m[4]) : 0,
            transport: !document.getElementById('transport').classList.contains('hidden'),
          };
        });
      } catch {
        preloaded = null;
      }
      L.record(results, '6. Barre de position active dès l’ouverture, sans lecture', pageName,
        preloaded && preloaded.disabled === false && preloaded.total > 0 &&
          preloaded.state.state === 'stopped' && preloaded.state.duration > 0 &&
          preloaded.state.hasData === true && preloaded.transport ? 'OK' : 'ÉCHEC',
        preloaded
          ? `curseur actif ${preloaded.disabled === false}, libellé « ${preloaded.text} » ` +
            `(${preloaded.total} s), état ${preloaded.state.state}, durée ${preloaded.state.duration} ms, ` +
            `données ${preloaded.state.hasData}, transport visible ${preloaded.transport}`
          : 'aucun préchargement observé');

      // (b) Glissé du curseur à l'arrêt, suivi actif : la vue suit le geste et
      // ▶ part de la position choisie.
      const dragStart = await state(page);
      const dragPage = await displayedPageNumber(page);
      await page.$eval('#transport-seek', (el) => {
        el.value = '500';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      let dragMoved = false;
      try {
        await bounded('vue déplacée pendant le glissé', WAIT.seekToPage,
          page.waitForFunction((prev) => {
            const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
            return m && parseInt(m[1], 10) !== prev;
          }, dragPage, { timeout: WAIT.seekToPage, polling: 50 }));
        dragMoved = true;
      } catch {
        // laissé à false : la vue n'a pas suivi le geste
      }
      await page.$eval('#transport-seek', (el) =>
        el.dispatchEvent(new Event('change', { bubbles: true })));
      await page.waitForTimeout(300);
      const dragAfter = await state(page);
      const dragExpected = 0.5 * dragStart.duration;
      const dragLandedPage = await displayedPageNumber(page);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForTimeout(200);
      const dragPlaying = await state(page);
      const dragOk = dragStart.duration > 0 && dragMoved &&
        Math.abs(dragAfter.position - dragExpected) <= 400 &&
        dragPlaying.state === 'playing' &&
        Math.abs(dragPlaying.position - dragExpected) <= 800;
      L.record(results, '6. Glissé du curseur à l’arrêt : vue déplacée, ▶ part de la position choisie', pageName,
        dragOk ? 'OK' : 'ÉCHEC',
        `vue p.${dragPage} → p.${dragLandedPage} (déplacée ${dragMoved}), ` +
        `durée ${dragStart.duration} ms, relâchement ${dragAfter.position} ms ` +
        `(cible ${Math.round(dragExpected)}), lecture ${dragPlaying.position} ms, état ${dragPlaying.state}`);
      await stopPlayback(page);
      await waitState(page, 'stopped');

      // (c) Aller à une page puis ▶ : la lecture part du début de cette page.
      const total = (await L.pageInfo(page)).total;
      const targetPage = Math.min(2, total);
      await L.gotoPage(page, targetPage);
      await page.waitForTimeout(700);
      const expected = await page.evaluate(async (target) => {
        const result = getMovementForPage(target);
        if (!result) return null;
        const probe = await window.__musicaPlaybackProbe();
        const mark = (probe.marks || []).find((m) => Number(m.page) === result.localPage);
        return {
          page: target,
          movementId: result.movement.id,
          localPage: result.localPage,
          position: mark ? Number(mark.t) : 0,
        };
      }, targetPage);
      const pageBefore = await state(page);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForTimeout(200);
      const pagePlaying = await state(page);
      const pageOk = expected && pageBefore.state === 'stopped' &&
        Math.abs(pageBefore.position - expected.position) <= 400 &&
        pagePlaying.state === 'playing' && pagePlaying.movementId === expected.movementId &&
        Math.abs(pagePlaying.position - expected.position) <= 800;
      L.record(results, '6. Aller à une page puis ▶ : la lecture part de cette page', pageName,
        pageOk ? 'OK' : 'ÉCHEC',
        expected
          ? `page ${targetPage} (mouvement ${expected.movementId}, page locale ${expected.localPage}), ` +
            `cible ${expected.position} ms, arrêté ${pageBefore.position} ms, ` +
            `lecture ${pagePlaying.position} ms, état ${pagePlaying.state}`
          : 'page cible introuvable');
      await stopPlayback(page);
      await waitState(page, 'stopped');

      // (d) gabc en notation carrée : transport masqué et aucune donnée de
      // lecture demandée, même avec le préchargement.
      await page.evaluate(() => {
        const w = window.__musicaWorker;
        window.__pbAfterGabc = 0;
        const orig = w.postMessage.bind(w);
        w.postMessage = function (msg) {
          if (msg && msg.type === 'getPlaybackData') window.__pbAfterGabc += 1;
          return orig(msg);
        };
      });
      await L.importFile(page, KYRIE);
      await page.waitForSelector('#page-current .scroll-page svg .note[source-index]', { timeout: WAIT.firstSvg });
      await page.waitForTimeout(800);
      const gabc = await page.evaluate(() => ({
        hidden: document.getElementById('transport').classList.contains('hidden'),
        requests: window.__pbAfterGabc,
        state: window.__musicaPlaybackState(),
      }));
      L.record(results, '6. gabc carré : transport masqué, aucune donnée de lecture demandée', pageName,
        gabc.hidden && gabc.requests === 0 && gabc.state.state === 'stopped' &&
          gabc.state.hasData === false ? 'OK' : 'ÉCHEC',
        `transport masqué ${gabc.hidden}, demandes getPlaybackData ${gabc.requests}, ` +
        `état ${gabc.state.state}, données ${gabc.state.hasData}`);
    } catch (e) {
      L.record(results, '6. Barre de position avant lecture', pageName, 'ÉCHEC',
        'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (barre de position avant lecture)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctx.close();
  }

  // Téléphone 390×844 : la barre de position reste visible à l'arrêt avec le
  // suivi actif, et le glissé du curseur déplace la vue pendant le geste
  // (mise en page verticale ou horizontale selon la décision de « Auto »).
  {
    const PHONE = { width: 390, height: 844 };
    const shot = (suffix) => `/tmp/cantus-suivi/telephone-${pageName.replace('.html', '')}-${suffix}.png`;
    try { fs.mkdirSync('/tmp/cantus-suivi', { recursive: true }); } catch { /* capture facultative */ }
    const { page, ctx: ctxPhone, errors: errorsPhone } =
      await L.newPage(browser, url, { pageName, viewport: PHONE });
    try {
      await waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(800);
      const mode = await page.evaluate(() =>
        document.querySelector('#page-current .scroll-wrapper')?.classList.contains('vertical')
          ? 'vertical' : 'horizontal');
      const bar = await page.evaluate(() => {
        const rect = document.getElementById('command-bar').getBoundingClientRect();
        return {
          follow: JSON.parse(localStorage.getItem('musica-settings') || '{}').followPlayback !== false,
          bar: !document.getElementById('command-bar').classList.contains('hidden'),
          transport: !document.getElementById('transport').classList.contains('hidden'),
          fits: rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5 &&
            rect.bottom >= window.innerHeight - 1,
        };
      });
      // Touche au centre de l'écran téléphone : la barre reste visible.
      await page.mouse.click(PHONE.width / 2, PHONE.height / 2);
      await page.waitForTimeout(250);
      const barAfterTap = await page.evaluate(
        () => !document.getElementById('command-bar').classList.contains('hidden'));

      // Les marqueurs de suivi n'arrivent qu'avec les données de lecture.
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await stopPlayback(page);
      await waitState(page, 'stopped');
      await L.gotoPage(page, 1);
      await page.waitForTimeout(500);
      try { await page.screenshot({ path: shot('arret') }); } catch { /* capture facultative */ }
      const readView = () => page.evaluate(() => {
        const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
        return {
          page: m ? parseInt(m[1], 10) : null,
          top: document.getElementById('page-current')?.scrollTop ?? 0,
          state: window.__musicaPlaybackState(),
        };
      });
      const before = await readView();
      await page.$eval('#transport-seek', (el) => {
        el.value = '600';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      let dragMoved = false;
      try {
        await bounded('défilement téléphone pendant le glissé du curseur', WAIT.seekToPage,
          page.waitForFunction((prev) => {
            const slot = document.getElementById('page-current');
            const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
            const page = m ? parseInt(m[1], 10) : null;
            return (slot && slot.scrollTop > prev.top + 10) || (page != null && page !== prev.page);
          }, before, { timeout: WAIT.seekToPage, polling: 50 }));
        dragMoved = true;
      } catch {
        // laissé à false : la vue n'a pas suivi le geste
      }
      const during = await readView();
      try { await page.screenshot({ path: shot('glisse') }); } catch { /* capture facultative */ }
      await page.$eval('#transport-seek', (el) =>
        el.dispatchEvent(new Event('change', { bubbles: true })));
      await page.waitForTimeout(300);
      const after = await state(page);
      const expected = 0.6 * before.state.duration;
      const previewOk = dragMoved && during.state.position === before.state.position;
      const releaseOk = before.state.duration > 0 && Math.abs(after.position - expected) <= 400;
      L.record(results, `6. Téléphone 390×844 (${mode}) : barre persistante, glissé qui déplace la vue`, pageName,
        bar.follow && bar.bar && bar.transport && bar.fits && barAfterTap && previewOk && releaseOk
          ? 'OK' : 'ÉCHEC',
        `suivi ${bar.follow}, barre ${bar.bar} → ${barAfterTap} (dans l’écran ${bar.fits}), ` +
        `transport ${bar.transport}, vue ${before.page}@${before.top} → ${during.page}@${during.top} ` +
        `(déplacée ${dragMoved}), position pendant ${during.state.position} ms ` +
        `(départ ${before.state.position} ms), relâchement ${after.position} ms ` +
        `(cible ${Math.round(expected)} ms)`);
      await stopPlayback(page);
    } catch (e) {
      L.record(results, '6. Téléphone 390×844', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errorsPhone);
    L.record(results, '6. Erreurs JS (téléphone 390×844)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctxPhone.close();
  }

}

// Durées observées le 18/11/2026 (index.html + spa.html) : 53 à 71 s selon
// la charge ; le préchargement de la barre de position ajoute un contexte par
// page. Budget ~2,5× le maximum.
C.main(runPage, { budgetMs: 300000, summary: 'S6B' });
