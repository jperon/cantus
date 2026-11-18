// Scénario 6a — transport audio : structure de la barre, lecture/pause/arrêt,
// raccourcis clavier, suivi vertical (système et page), volume général, volume
// par voix et voix masquée. index.html et spa.html.
const C = require('./s6-common');
const L = C.L;
const {
  WAIT, bounded, waitReady, waitFirstSvg, waitBackgroundLoaded, reloadPage,
  state, waitState, transportHidden, positionGrowing, horizontalScrollPos,
  seekFraction, alignedOnSystem, storedParts, partVolumeValues, playbackSample,
  displayedPageNumber, waitLibraryReady,
} = C;

async function runPage(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  try {
    await waitReady(page);
    const hiddenBefore = await transportHidden(page);
    L.record(results, '6. Transport masqué avant tout import', pageName,
      hiddenBefore ? 'OK' : 'ÉCHEC', `hidden = ${hiddenBefore}`);

    await L.importFile(page, L.FILES.telemannXml);
    await waitFirstSvg(page);
    await waitBackgroundLoaded(page);
    await page.waitForTimeout(800);
    const hiddenAfter = await transportHidden(page);
    L.record(results, '6. Transport visible une fois la partition affichée', pageName,
      !hiddenAfter ? 'OK' : 'ÉCHEC', `hidden = ${hiddenAfter}`);

    // Structure : une seule rangée en bas, trois zones, plus de barre de
    // progression. Le libellé de temps est le seul affichage de position.
    const layout = await page.evaluate(() => {
      const rect = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, centerY: r.top + r.height / 2 };
      };
      const left = rect('transport');
      const center = rect('nav-buttons');
      const right = rect('command-actions');
      const sameRow = [left, center, right].every((r) =>
        r && Math.abs(r.centerY - left.centerY) <= 3);
      const noOverlap = left && center && right &&
        left.right <= center.left + 1 && center.right <= right.left + 1;
      return {
        sameRow,
        noOverlap,
        seek: !!document.getElementById('transport-seek'),
        time: document.getElementById('transport-time')?.textContent || '',
        bar: !!document.getElementById('command-bar'),
      };
    });
    L.record(results, '6. Barre unique : MIDI à gauche, pages au centre, actions à droite', pageName,
      layout.bar && layout.sameRow && layout.noOverlap && !layout.seek ? 'OK' : 'ÉCHEC',
      `même ligne ${layout.sameRow}, sans chevauchement ${layout.noOverlap}, ` +
      `barre de progression ${layout.seek ? 'présente' : 'supprimée'}`);

    // Lecture
    const timeBefore = await page.textContent('#transport-time');
    await page.click('#transport-play');
    await waitState(page, 'playing');
    const growth = await positionGrowing(page, 1000);
    const timeAfter = await page.textContent('#transport-time');
    L.record(results, '6. Lecture : état playing et position qui progresse', pageName,
      growth.grew ? 'OK' : 'ÉCHEC',
      `position ${growth.before.position} → ${growth.after.position} ms, durée ${growth.after.duration} ms, moteur ${growth.after.engine}`);
    const timePattern = /^\d+:\d{2} \/ \d+:\d{2}$/;
    const timeOk = timePattern.test(timeBefore.trim()) && timePattern.test(timeAfter.trim()) &&
      timeAfter !== timeBefore && growth.after.duration > 0;
    L.record(results, '6. Libellé « temps courant / total » présent et progressif', pageName,
      timeOk ? 'OK' : 'ÉCHEC',
      `« ${timeBefore.trim()} » → « ${timeAfter.trim()} », durée ${growth.after.duration} ms`);

    // --- Tempo de lecture, pendant la lecture ---
    // Telemann : 80 noires/min dans le fichier. Le défaut affiché est 80 ;
    // passer à 160 double le facteur et divise la durée par deux, en reprenant
    // à la position courante. « Tempo du fichier » restaure 80.
    const baseTempoState = await state(page);
    await L.openSettings(page);
    const tempoDefault = await page.evaluate(() => ({
      value: document.getElementById('tempo-input')?.value,
      hint: document.getElementById('tempo-hint')?.textContent || '',
    }));
    await page.$eval('#tempo-input', (el) => {
      el.value = '160';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitState(page, 'playing');
    await page.waitForTimeout(600);
    const fast = await page.evaluate(() => ({
      ...window.__musicaPlaybackState(),
      stored: Object.keys(localStorage)
        .filter((k) => k.startsWith('musica-tempo-'))
        .map((k) => localStorage.getItem(k)),
    }));
    const ratioFast = baseTempoState.duration > 0 ? fast.duration / baseTempoState.duration : 0;
    L.record(results, '6. Tempo 80 → 160 : durée divisée par 2, reprise à la position courante', pageName,
      tempoDefault.value === '80' && /80/.test(tempoDefault.hint) &&
        fast.state === 'playing' && fast.tempo === 160 && fast.fileTempo === 80 &&
        Math.abs(fast.tempoFactor - 2) < 1e-9 &&
        Math.abs(ratioFast - 0.5) < 0.02 && fast.position > 0 &&
        fast.stored.length === 1 && fast.stored[0] === '160' ? 'OK' : 'ÉCHEC',
      `défaut affiché ${tempoDefault.value}, indication « ${tempoDefault.hint.trim()} » ; ` +
      `durée ${baseTempoState.duration} → ${fast.duration} ms (×${ratioFast.toFixed(3)}), ` +
      `position ${baseTempoState.position} → ${fast.position} ms, tempo ${fast.tempo}/${fast.fileTempo}, ` +
      `facteur ${fast.tempoFactor}, état ${fast.state}, réglage ${JSON.stringify(fast.stored)}`);

    await page.click('#tempo-reset');
    await page.waitForTimeout(600);
    const restored = await page.evaluate(() => window.__musicaPlaybackState());
    const ratioRestored = baseTempoState.duration > 0 ? restored.duration / baseTempoState.duration : 0;
    L.record(results, '6. « Tempo du fichier » : durée et lecture restaurées', pageName,
      restored.state === 'playing' && restored.tempo === 80 && Math.abs(restored.tempoFactor - 1) < 1e-9 &&
        Math.abs(ratioRestored - 1) < 0.02 ? 'OK' : 'ÉCHEC',
      `durée ${restored.duration} ms (×${ratioRestored.toFixed(3)}), position ${restored.position} ms, ` +
      `tempo ${restored.tempo}, facteur ${restored.tempoFactor}, état ${restored.state}`);
    await L.closeSettings(page);

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

    // Pendant une pause écrite, le suivi gèle : pauseAt est la fonction exacte
    // branchée dans followPlaybackFrame. (Aucun fichier de test avec pauses
    // n'est importable par l'UI ; la fixture unitaire pause_basic est un JSON
    // de timeline, pas une partition.)
    const pauseGate = await page.evaluate(() => {
      const api = window.__musicaTimeline;
      const pauses = [{ timeUs: 2000000, endTimeUs: 5000000 }];
      return {
        hasApi: !!api?.pauseAt,
        before: api?.pauseAt(pauses, 1999) === null,
        during: api?.pauseAt(pauses, 2000) === pauses[0] &&
          api?.pauseAt(pauses, 4999) === pauses[0],
        after: api?.pauseAt(pauses, 5000) === null,
      };
    });
    L.record(results, '6. Suivi gelé pendant une pause : pauseAt aux bornes exactes', pageName,
      pauseGate.hasApi && pauseGate.before && pauseGate.during && pauseGate.after ? 'OK' : 'ÉCHEC',
      `avant ${pauseGate.before}, pendant ${pauseGate.during}, après ${pauseGate.after}`);

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
      await waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
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
      await reloadPage(page);
      await waitReady(page);
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

  // Volume par voix : gain immédiat, aucun re-rendu, persistance et
  // rétrocompatibilité d'un stockage sans champ `volumes`.
  {
    const { page, ctx: ctx4, errors: errors4 } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
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
      await reloadPage(page);
      await waitReady(page);
      await waitLibraryReady(page);
      await L.openLibraryEntry(page, 0);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
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
      await reloadPage(page);
      await waitReady(page);
      await waitLibraryReady(page);
      await L.openLibraryEntry(page, 0);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
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

  // Voix masquée : le MIDI scoretk est global au fichier, donc sa piste
  // existe encore ; elle doit rester muette (gain 0) et non retomber sur le
  // master faute de correspondance dans trackMap.
  {
    const { page, ctx: ctxHidden, errors: errorsHidden } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(600);
      await L.openSettings(page);
      const rows = await L.partRows(page);
      const hiddenLabel = rows[1]?.name;
      if (!hiddenLabel) throw new Error('moins de deux voix : masquage impossible');
      await page.$eval('#parts-list label:nth-child(2) input', (el) => {
        el.checked = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await L.closeSettings(page);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(800);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForTimeout(500);
      const hidden = await page.evaluate(async (label) => {
        const probe = await window.__musicaPlaybackProbe();
        return {
          gain: window.__musicaAudio.getVoiceGain(label),
          tracks: probe.trackMap?.[label] || [],
          staffLabels: probe.staffLabels || [],
          midiBytes: probe.midiBytes,
          state: window.__musicaPlaybackState().state,
        };
      }, hiddenLabel);
      const trackExists = Array.isArray(hidden.tracks) && hidden.tracks.length > 0;
      const listed = hidden.staffLabels.includes(hiddenLabel);
      const silent = hidden.gain === 0;
      L.record(results, '6. Voix masquée : piste présente dans le MIDI global, gain 0', pageName,
        trackExists && listed && silent && hidden.state === 'playing' ? 'OK' : 'ÉCHEC',
        `${hiddenLabel} : pistes [${hidden.tracks.join(',')}], libellé listé ${listed}, ` +
        `gain ${hidden.gain}, MIDI ${hidden.midiBytes} o, état ${hidden.state}`);
      await page.click('#transport-stop');
      await waitState(page, 'stopped');
    } catch (e) {
      L.record(results, '6. Voix masquée', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errorsHidden);
    L.record(results, '6. Erreurs JS (voix masquée)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctxHidden.close();
  }

}

// Durées observées le 18/11/2026 (index.html + spa.html) : 83 à 113 s selon
// la charge ; budget ~2× le maximum.
C.main(runPage, { budgetMs: 240000, summary: 'S6A' });
