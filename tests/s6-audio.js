// Scénario 6 — aperçu audio : transport (lecture/pause/arrêt, progression,
// raccourcis p/s) et volume général conservé.
const path = require('path');
const L = require('./lib');

const PAGES = ['index.html', 'spa.html'];
const MOVEMENTS_FIXTURE = path.join(__dirname, 'fixtures', 'movements.xml');

async function state(page) {
  return page.evaluate(() => (window.__musicaPlaybackState ? window.__musicaPlaybackState() : null));
}

async function waitState(page, expected, timeout = 30000) {
  await page.waitForFunction((name) => {
    const s = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
    return s && s.state === name;
  }, expected, { timeout, polling: 100 });
}

async function transportHidden(page) {
  return page.evaluate(() => document.getElementById('transport')?.classList.contains('hidden'));
}

async function positionGrowing(page, ms = 1000, minimum = 100) {
  const before = await state(page);
  await page.waitForTimeout(ms);
  const after = await state(page);
  return { before, after, grew: after.position > before.position + minimum };
}

async function seekFraction(page, fraction) {
  await page.$eval('#transport-seek', (el, f) => {
    el.value = String(Math.round(f * 1000));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, fraction);
}

function alignedOnSystem(snapshot) {
  return snapshot.systems.some((top) => Math.abs(top - snapshot.top) <= 10);
}

async function storedParts(page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('musica-hidden-parts-'));
    if (!key) return null;
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  });
}

async function partVolumeValues(page) {
  return page.$$eval('#parts-list select.part-volume', (sels) => sels.map((s) => s.value));
}

// Données de lecture complètes demandées directement au worker (le probe de
// l'application ne renvoie que les premiers marqueurs).
async function playbackSample(page, movementId = 1) {
  return page.evaluate((id) => new Promise((resolve, reject) => {
    const w = window.__musicaWorker;
    const done = (fn, value) => {
      w.removeEventListener('message', onMessage);
      clearTimeout(timer);
      fn(value);
    };
    const onMessage = (e) => {
      const d = e.data || {};
      if (d.type === 'playbackData' && d.movementId === id) {
        done(resolve, { syncMarks: d.syncMarks || [], duration: Number(d.duration) || 0 });
      } else if (d.type === 'playbackError' && d.movementId === id) {
        done(reject, new Error(d.message || 'playbackError'));
      }
    };
    const timer = setTimeout(() => done(reject, new Error('délai playbackData dépassé')), 120000);
    w.addEventListener('message', onMessage);
    w.postMessage({ type: 'getPlaybackData', movementId: id });
  }), movementId);
}

// Après un rechargement, le worker peut encore démarrer : attendre que la
// bibliothèque soit proposée avant de cliquer dessus.
async function waitLibraryReady(page, timeout = 60000) {
  await page.waitForFunction(() => {
    const overlay = document.getElementById('library-overlay');
    const button = document.getElementById('btn-library');
    return (overlay && !overlay.classList.contains('hidden')) ||
      (button && !button.classList.contains('hidden'));
  }, null, { timeout, polling: 100 });
}

async function runPage(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  try {
    await L.waitReady(page);
    const hiddenBefore = await transportHidden(page);
    L.record(results, '6. Transport masqué avant tout import', pageName,
      hiddenBefore ? 'OK' : 'ÉCHEC', `hidden = ${hiddenBefore}`);

    await L.importFile(page, L.FILES.telemannXml);
    await L.waitFirstSvg(page, 180000);
    await L.waitBackgroundLoaded(page, 180000);
    await page.waitForTimeout(800);
    const hiddenAfter = await transportHidden(page);
    L.record(results, '6. Transport visible une fois la partition affichée', pageName,
      !hiddenAfter ? 'OK' : 'ÉCHEC', `hidden = ${hiddenAfter}`);

    // Lecture
    await page.click('#transport-play');
    await waitState(page, 'playing');
    const growth = await positionGrowing(page, 1000);
    L.record(results, '6. Lecture : état playing et position qui progresse', pageName,
      growth.grew ? 'OK' : 'ÉCHEC',
      `position ${growth.before.position} → ${growth.after.position} ms, durée ${growth.after.duration} ms, moteur ${growth.after.engine}`);

    // Pause : position stable
    await page.click('#transport-play');
    await waitState(page, 'paused');
    await page.waitForTimeout(200);
    const pausedBefore = await state(page);
    await page.waitForTimeout(600);
    const pausedAfter = await state(page);
    const stable = Math.abs(pausedAfter.position - pausedBefore.position) <= 100;
    L.record(results, '6. Pause : position stable (±100 ms)', pageName,
      stable ? 'OK' : 'ÉCHEC',
      `position ${pausedBefore.position} → ${pausedAfter.position} ms`);

    // Reprise et arrêt par le bouton
    await page.click('#transport-play');
    await waitState(page, 'playing');
    await page.waitForTimeout(400);
    await page.click('#transport-stop');
    await waitState(page, 'stopped');
    const stopped = await state(page);
    L.record(results, '6. Arrêt : état stopped et position 0', pageName,
      stopped.state === 'stopped' && stopped.position === 0 ? 'OK' : 'ÉCHEC',
      `état ${stopped.state}, position ${stopped.position} ms`);

    // Raccourcis p (lecture/pause) et s (arrêt)
    await page.keyboard.press('p');
    await waitState(page, 'playing');
    const shortGrowth = await positionGrowing(page, 800, 50);
    await page.keyboard.press('p');
    await waitState(page, 'paused');
    await page.keyboard.press('s');
    await waitState(page, 'stopped');
    const afterKeys = await state(page);
    L.record(results, '6. Raccourcis p (lecture/pause) et s (arrêt)', pageName,
      shortGrowth.grew && afterKeys.position === 0 ? 'OK' : 'ÉCHEC',
      `position après reprise ${shortGrowth.after.position} ms, après s ${afterKeys.position} ms`);

    // Les raccourcis ne s'appliquent pas quand les réglages sont ouverts
    await L.openSettings(page);
    await page.keyboard.press('p');
    await page.waitForTimeout(500);
    const duringSettings = await state(page);
    await L.closeSettings(page);
    L.record(results, '6. Raccourci p ignoré quand les réglages sont ouverts', pageName,
      duringSettings.state === 'stopped' ? 'OK' : 'ÉCHEC',
      `état ${duringSettings.state}`);

    // --- Suivi du défilement, mode vertical par système ---
    await page.click('#transport-play');
    await waitState(page, 'playing');
    await L.openSettings(page);
    await page.click('.scroll-unit-btn[data-unit=system]');
    await L.closeSettings(page);
    await L.resetScrollTop(page);
    const systemTops = new Set();
    const systemChecks = [];
    for (const fraction of [0.15, 0.35, 0.55, 0.75]) {
      await seekFraction(page, fraction);
      await page.waitForTimeout(1000);
      const snapshot = await L.scrollState(page);
      const aligned = snapshot.top > 0 && alignedOnSystem(snapshot);
      if (aligned) systemTops.add(snapshot.top);
      systemChecks.push(`${Math.round(fraction * 100)} %:top=${snapshot.top}${aligned ? '' : ' NON ALIGNÉ'}(p.${snapshot.page})`);
    }
    L.record(results, '6. Suivi vertical par système : systèmes successifs alignés à ±10 px', pageName,
      systemTops.size >= 3 ? 'OK' : 'ÉCHEC', systemChecks.join(' '));

    // --- Suivi par page (le haut d'une page est amené en haut) ---
    await L.openSettings(page);
    await page.click('.scroll-unit-btn[data-unit=page]');
    await L.closeSettings(page);
    const pageChecks = [];
    let pagesOk = true;
    for (const fraction of [0.25, 0.5, 0.8]) {
      await seekFraction(page, fraction);
      await page.waitForTimeout(1000);
      const snapshot = await L.scrollState(page);
      const atPageTop = snapshot.pages.some((p) => p.hasSvg && Math.abs(p.top - snapshot.top) <= 2);
      pagesOk = pagesOk && atPageTop;
      pageChecks.push(`${Math.round(fraction * 100)} %:top=${snapshot.top}(p.${snapshot.page})`);
    }
    L.record(results, '6. Suivi vertical par page : une page est amenée en haut', pageName,
      pagesOk ? 'OK' : 'ÉCHEC', pageChecks.join(' '));

    // --- Suivi désactivé : le défilement ne bouge pas ---
    await L.openSettings(page);
    await page.$eval('#follow-playback', (el) => {
      el.checked = false;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await L.closeSettings(page);
    await page.evaluate(() => { document.getElementById('page-current').scrollTop = 0; });
    await page.waitForTimeout(300);
    await seekFraction(page, 0.8);
    await page.waitForTimeout(1200);
    const followOff = await page.evaluate(() => document.getElementById('page-current').scrollTop);
    const followSetting = await page.evaluate(() => JSON.parse(localStorage.getItem('musica-settings') || '{}').followPlayback);
    L.record(results, '6. followPlayback=false : aucun scrollTop modifié', pageName,
      followOff === 0 && followSetting === false ? 'OK' : 'ÉCHEC',
      `scrollTop ${followOff}, réglage ${followSetting}`);
    // Réactiver pour la suite du scénario
    await L.openSettings(page);
    await page.$eval('#follow-playback', (el) => {
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await L.closeSettings(page);
    await page.click('#transport-stop');
    await waitState(page, 'stopped');
  } catch (e) {
    L.record(results, '6. Transport audio', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  const relevant = L.summarize(errors);
  L.record(results, '6. Erreurs JS (transport)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  await ctx.close();

  // Volume général conservé après rechargement
  {
    const { page, ctx: ctx2, errors: errors2 } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await L.waitFirstSvg(page, 180000);
      await L.waitBackgroundLoaded(page, 180000);
      await page.waitForTimeout(600);
      await L.openSettings(page);
      await page.$eval('#master-volume-range', (el) => {
        el.value = '55';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(300);
      const labelSet = await page.textContent('#master-volume-value');
      const savedSet = await page.evaluate(() => JSON.parse(localStorage.getItem('musica-settings') || '{}').masterVolume);
      await L.closeSettings(page);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await L.waitReady(page, 60000);
      await page.waitForTimeout(500);
      const afterReload = await page.evaluate(() => ({
        slider: document.getElementById('master-volume-range')?.value,
        label: document.getElementById('master-volume-value')?.textContent,
        saved: JSON.parse(localStorage.getItem('musica-settings') || '{}').masterVolume,
        transportHidden: document.getElementById('transport')?.classList.contains('hidden'),
      }));
      const ok = labelSet === '55' && savedSet === 55 && afterReload.slider === '55' &&
        afterReload.label === '55' && afterReload.saved === 55 && afterReload.transportHidden;
      L.record(results, '6. Volume général 55 % conservé après rechargement', pageName,
        ok ? 'OK' : 'ÉCHEC',
        `libellé ${labelSet}, réglage ${savedSet}, après rechargement curseur ${afterReload.slider}/${afterReload.label}, ` +
        `réglage ${afterReload.saved}, transport masqué ${afterReload.transportHidden}`);
    } catch (e) {
      L.record(results, '6. Volume général', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errors2);
    L.record(results, '6. Erreurs JS (volume)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctx2.close();
  }

  // Suivi en mode horizontal (Fauré : une page = un système) : la page
  // affichée change et contient toujours un SVG, y compris en revenant en
  // arrière.
  {
    const { page, ctx: ctx3, errors: errors3 } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await L.importFile(page, L.FILES.faureMscz);
      await L.waitFirstSvg(page, 180000);
      await L.waitBackgroundLoaded(page, 180000);
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
        await page.waitForFunction(() => {
          const txt = document.getElementById('page-number')?.textContent || '';
          const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
          const top = m ? parseInt(m[1], 10) : null;
          const pages = [...document.querySelectorAll('#page-current .scroll-page')].map((d) => ({
            page: parseInt(d.dataset.page, 10),
            hasSvg: !!d.querySelector('svg'),
          }));
          const topPage = pages.find((p) => p.page === top);
          return !!(topPage && topPage.hasSvg && pages.some((p) => p.hasSvg));
        }, null, { timeout: 20000, polling: 100 });
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
      await page.click('#transport-stop');
    } catch (e) {
      L.record(results, '6. Suivi horizontal', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errors3);
    L.record(results, '6. Erreurs JS (suivi horizontal)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctx3.close();
  }

  // Volume par voix : gain immédiat, aucun re-rendu, persistance et
  // rétrocompatibilité d'un stockage sans champ `volumes`.
  {
    const { page, ctx: ctx4, errors: errors4 } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await L.waitFirstSvg(page, 180000);
      await L.waitBackgroundLoaded(page, 180000);
      await page.waitForTimeout(800);
      await L.markSvg(page);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        window.__svgAfterVolume = 0;
        window.__musicaWorker.addEventListener('message', (e) => {
          if (e.data.type === 'svg') window.__svgAfterVolume += 1;
        });
      });
      await L.openSettings(page);
      const rows = await L.partRows(page);
      const label = rows[0]?.name;
      const gainBefore = await page.evaluate((l) => window.__musicaAudio.getVoiceGain(l), label);
      await page.selectOption('#parts-list label:nth-child(1) select.part-volume', '10');
      await page.waitForTimeout(400);
      const after = await page.evaluate((l) => {
        const key = Object.keys(localStorage).find((k) => k.startsWith('musica-hidden-parts-'));
        const saved = key ? JSON.parse(localStorage.getItem(key)) : null;
        return {
          gain: window.__musicaAudio.getVoiceGain(l),
          expected: window.__musicaAudio.volumeToGain(10),
          saved,
          msgs: window.__svgAfterVolume,
          marker: !!document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
        };
      }, label);
      const gainOk = after.gain != null && Math.abs(after.gain - after.expected) <= 0.02;
      const savedOk = after.saved && after.saved.volumes && after.saved.volumes[label] === 10;
      L.record(results, '6. Volume par voix 10 % : GainNode au plancher, 0 re-rendu', pageName,
        gainOk && savedOk && after.msgs === 0 && after.marker ? 'OK' : 'ÉCHEC',
        `${label} : gain ${gainBefore} → ${after.gain} (attendu ${after.expected}), ` +
        `0 SVG reçu : ${after.msgs === 0}, marqueur conservé : ${after.marker}, volumes ${JSON.stringify(after.saved?.volumes)}`);
      // Voix mémorisée mais absente du MIDI du mouvement : le libellé doit être
      // toléré (aucune exception), simplement sans GainNode.
      await page.evaluate(() => {
        const key = Object.keys(localStorage).find((k) => k.startsWith('musica-hidden-parts-'));
        if (!key) return;
        const data = JSON.parse(localStorage.getItem(key));
        data.hidden = [...new Set([...(data.hidden || []), 'Voix absente du MIDI'])];
        data.volumes = { ...(data.volumes || {}), 'Voix absente du MIDI': 10 };
        localStorage.setItem(key, JSON.stringify(data));
      });
      await L.closeSettings(page);
      await page.waitForTimeout(500);
      const markerAfterClose = await L.markerPresent(page);
      L.record(results, '6. Changement de volume sans re-rendu à la fermeture des réglages', pageName,
        markerAfterClose ? 'OK' : 'ÉCHEC', `SVG marqué toujours affiché : ${markerAfterClose}`);

      // Persistance après rechargement et réouverture depuis la bibliothèque
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await L.waitReady(page, 60000);
      await waitLibraryReady(page);
      await L.openLibraryEntry(page, 0);
      await L.waitFirstSvg(page, 180000);
      await L.waitBackgroundLoaded(page, 180000);
      await page.waitForTimeout(800);
      await L.openSettings(page);
      const volumesReload = await partVolumeValues(page);
      const savedReload = await storedParts(page);
      L.record(results, '6. Volume par voix conservé après rechargement', pageName,
        volumesReload[0] === '10' && savedReload?.volumes?.[label] === 10 ? 'OK' : 'ÉCHEC',
        `sélecteurs ${volumesReload.join('/')}, volumes ${JSON.stringify(savedReload?.volumes)}`);
      await L.closeSettings(page);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForTimeout(400);
      const unknownVoice = await page.evaluate(() => ({
        gain: window.__musicaAudio.getVoiceGain('Voix absente du MIDI'),
        state: window.__musicaPlaybackState().state,
      }));
      L.record(results, '6. Voix absente du MIDI : libellé toléré, aucun GainNode', pageName,
        unknownVoice.gain === null && unknownVoice.state === 'playing' ? 'OK' : 'ÉCHEC',
        `gain ${unknownVoice.gain}, état ${unknownVoice.state}`);
      await page.click('#transport-stop');
      await waitState(page, 'stopped');

      // Ancien stockage : aucun champ `volumes` -> 100 % partout, sans erreur
      await page.evaluate(() => {
        const key = Object.keys(localStorage).find((k) => k.startsWith('musica-hidden-parts-'));
        if (!key) return;
        const data = JSON.parse(localStorage.getItem(key));
        delete data.volumes;
        localStorage.setItem(key, JSON.stringify(data));
      });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await L.waitReady(page, 60000);
      await waitLibraryReady(page);
      await L.openLibraryEntry(page, 0);
      await L.waitFirstSvg(page, 180000);
      await L.waitBackgroundLoaded(page, 180000);
      await page.waitForTimeout(800);
      await L.openSettings(page);
      const volumesLegacy = await partVolumeValues(page);
      L.record(results, '6. Stockage sans `volumes` : lecture rétrocompatible à 100 %', pageName,
        volumesLegacy.length > 0 && volumesLegacy.every((v) => v === '100') ? 'OK' : 'ÉCHEC',
        `sélecteurs ${volumesLegacy.join('/')}`);
      await L.closeSettings(page);
    } catch (e) {
      L.record(results, '6. Volume par voix', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errors4);
    L.record(results, '6. Erreurs JS (volume par voix)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctx4.close();
  }

  // Robustesse : changer de fichier ou redimensionner pendant la lecture,
  // puis les chemins d'erreur (MIDI vide, mouvement sans données).
  {
    const { page, ctx: ctx5, errors: errors5 } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await L.waitFirstSvg(page, 180000);
      await L.waitBackgroundLoaded(page, 180000);
      await page.waitForTimeout(800);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForTimeout(400);

      // Changement de fichier en pleine lecture : la lecture est arrêtée,
      // le nouveau document se charge, aucune exception JS.
      await L.importFile(page, MOVEMENTS_FIXTURE);
      await L.waitFirstSvg(page, 180000);
      await page.waitForFunction(() => {
        const s = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
        return s && s.state === 'stopped' && s.position === 0;
      }, null, { timeout: 60000, polling: 100 });
      const afterChange = await state(page);
      L.record(results, '6. Changement de fichier pendant la lecture : lecture arrêtée', pageName,
        afterChange.state === 'stopped' && afterChange.position === 0 ? 'OK' : 'ÉCHEC',
        `état ${afterChange.state}, position ${afterChange.position} ms, transport masqué ${await transportHidden(page)}`);

      // Rotation / redimensionnement pendant la lecture : le re-rendu repart
      // de zéro sans laisser le transport en lecture.
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.setViewportSize({ width: 900, height: 500 });
      await page.waitForFunction(() => {
        const s = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
        return s && s.state === 'stopped';
      }, null, { timeout: 90000, polling: 150 });
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

  // Reprises : le timemap contient des copies « -rendN » absentes des SVG.
  // Elles doivent être ramenées à l'id de base, sinon le suivi décroche au
  // second passage (environ 32 s sans marqueur sur La_foule avant correctif).
  {
    const { page, ctx: ctxReprises, errors: errorsReprises } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await L.importFile(page, L.FILES.laFouleMxl);
      await L.waitFirstSvg(page, 180000);
      await L.waitBackgroundLoaded(page, 180000);
      await page.waitForTimeout(600);
      // Le fichier est découpé en mouvements : collecter les marqueurs de
      // chacun jusqu'au premier mouvement non chargé.
      const playback = [];
      for (let id = 1; id <= 50; id += 1) {
        try {
          playback.push(await playbackSample(page, id));
        } catch {
          break;
        }
      }
      const marks = playback.flatMap((data) => data.syncMarks);
      let maxGap = 0;
      for (const data of playback) {
        const list = data.syncMarks;
        for (let i = 1; i < list.length; i += 1) {
          maxGap = Math.max(maxGap, list[i].t - list[i - 1].t);
        }
      }
      const duration = playback.reduce((sum, data) => sum + data.duration, 0);
      L.record(results, '6. Reprises : les deux passages sont couverts par les marqueurs', pageName,
        marks.length >= 400 ? 'OK' : 'ÉCHEC',
        `${marks.length} marqueurs sur ${playback.length} mouvement(s), durée ${Math.round(duration)} ms`);
      L.record(results, '6. Reprises : aucun trou de suivi au second passage', pageName,
        maxGap <= 2000 ? 'OK' : 'ÉCHEC',
        `écart max entre marqueurs consécutifs ${maxGap} ms`);
    } catch (e) {
      L.record(results, '6. Reprises : suivi du second passage', pageName, 'ÉCHEC',
        'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errorsReprises);
    L.record(results, '6. Erreurs JS (reprises)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctxReprises.close();
  }

  // Chemins d'erreur : message playbackError et données de lecture vides.
  // On intercepte getPlaybackData pour injecter la réponse sans dépendre du
  // worker réel ; l'application doit masquer le transport sans erreur JS.
  {
    const { page, ctx: ctx6, errors: errors6 } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await L.waitFirstSvg(page, 180000);
      await L.waitBackgroundLoaded(page, 180000);
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

(async () => {
  const { server, url } = await L.startServer();
  const browser = await L.launch();
  const results = [];
  try {
    for (const pageName of PAGES) await runPage(browser, url, pageName, results);
  } catch (e) {
    console.log('ERREUR GÉNÉRALE', e.stack);
  }
  console.log('\n=== RÉSUMÉ S6 ===');
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  server.close();
})();
