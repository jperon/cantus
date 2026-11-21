// Scénario 6a — transport audio : structure de la barre, lecture/pause/arrêt,
// raccourcis clavier, suivi vertical (système et page), volume général, volume
// par voix, et dissociation affichage / lecture des voix. index.html et
// spa.html.
const C = require('./s6-common');
const L = C.L;
const {
  WAIT, bounded, waitReady, waitFirstSvg, waitBackgroundLoaded, reloadPage,
  state, waitState, transportHidden, positionGrowing, horizontalScrollPos,
  seekFraction, alignedOnSystem, storedParts, partVolumeValues, playbackSample,
  displayedPageNumber, waitLibraryReady, ENCHAINEMENT_FIXTURE,
} = C;

// Attend que la page marquée par markSvg ait été remplacée par un nouveau
// rendu (fermeture des réglages après un changement d'affichage).
async function waitRerender(page, timeout = 120000) {
  await page.waitForFunction(() => {
    const slot = document.getElementById('page-current');
    return !!slot?.querySelector('.scroll-page svg') &&
      !slot.querySelector('.scroll-page svg[data-test-mark="1"]');
  }, null, { timeout, polling: 200 });
  await page.waitForTimeout(500);
}

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

    // --- SpessaSynth : un canal et un programme par piste, gigue bornée ---
    // La banque SF3 se charge au premier play() ; on laisse ensuite
    // l'ordonnanceur envoyer quelques notes avant de lire la gigue mesurée
    // (déclenchement réel - début musical, en secondes).
    await page.evaluate(() => window.__musicaAudio.startNoteLog());
    await page.waitForTimeout(1200);
    const synth = await page.evaluate(() => ({
      mode: window.__musicaAudio.getEngineMode(),
      timing: window.__musicaAudio.getTimingStats(),
      assignments: window.__musicaAudio.getChannelAssignments(),
      changes: window.__musicaAudio.getProgramChanges(),
    }));
    const melodic = (synth.assignments || []).filter((a) => !a.percussion);
    const channels = melodic.map((a) => a.channel);
    const drums = (synth.assignments || []).filter((a) => a.percussion);
    const uniqueChannels = new Set(channels).size === channels.length;
    const programsSent = new Set((synth.changes || []).map((c) => `${c.channel}:${c.program}`));
    const programsOk = melodic.every((a) => programsSent.has(`${a.channel}:${a.program}`));
    const drumsOk = drums.every((a) => a.channel === 9);
    const jitterOk = synth.mode === 'soundfont' && synth.timing &&
      synth.timing.count > 0 && synth.timing.max < 0.05;
    L.record(results, '6. SpessaSynth : canal et programme par piste, gigue < 50 ms', pageName,
      uniqueChannels && programsOk && drumsOk && jitterOk ? 'OK' : 'ÉCHEC',
      `moteur ${synth.mode}, ${melodic.length} piste(s) mélodique(s) sur ` +
      `${new Set(channels).size} canal/canaux${uniqueChannels ? '' : ' (collision)'}, ` +
      `${drums.length} piste(s) de batterie sur le 9 : ${drumsOk}, ` +
      `${(synth.changes || []).length} programChange ; ` +
      `${synth.timing ? synth.timing.count : 0} note(s) déclenchée(s), gigue max ` +
      `${synth.timing ? (synth.timing.max * 1000).toFixed(1) : '?'} ms, ` +
      `RMS ${synth.timing ? (synth.timing.rms * 1000).toFixed(1) : '?'} ms`);

    // --- Tempo de lecture, pendant la lecture ---
    // Telemann : 80 noires/min dans le fichier. Le défaut affiché est 80 ;
    // passer à 160 double le facteur et divise la durée par deux, en reprenant
    // à la position courante. « Tempo du fichier » restaure 80.
    const baseTempoState = await state(page);
    const baseNotes = await page.evaluate(() => window.__musicaAudio.getNotes());
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
    await page.evaluate(() => window.__musicaAudio.startNoteLog());
    await page.waitForTimeout(700);
    const fast = await page.evaluate(() => ({
      ...window.__musicaPlaybackState(),
      notes: window.__musicaAudio.getNotes(),
      scheduled: window.__musicaAudio.getScheduledNotes(),
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

    // Les notes que le moteur prépare et programme réellement suivent le
    // tempo : mêmes hauteurs, débuts et durées divisés par 2. Le journal
    // d'ordonnancement confirme que les instants de lecture sont ceux de ces
    // débuts, et pas seulement la durée annoncée par le transport.
    const notesHalved = baseNotes.length > 0 && fast.notes.length === baseNotes.length &&
      baseNotes.every((n, i) =>
        fast.notes[i].pitch === n.pitch &&
        Math.abs(fast.notes[i].start - n.start / 2) < 1e-9 &&
        Math.abs(fast.notes[i].dur - n.dur / 2) < 1e-9);
    const scheduleAligned = fast.scheduled.length > 0 && fast.scheduled.every((n) =>
      n.offset >= n.start - 0.001 && n.offset <= n.start + 0.15);
    L.record(results, '6. Tempo 160 : notes réellement programmées à débuts et durées /2', pageName,
      notesHalved && scheduleAligned ? 'OK' : 'ÉCHEC',
      `${baseNotes.length} → ${fast.notes.length} notes, débuts et durées ×0,5 : ${notesHalved}, ` +
      `${fast.scheduled.length} note(s) ordonnancée(s), instants alignés sur les débuts : ${scheduleAligned}`);

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
      await page.selectOption('#parts-list .part-row:nth-child(1) select.part-volume', '10');
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
        data.muted = [...new Set([...(data.muted || []), 'Voix absente du MIDI'])];
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

  // Affichage et lecture d'une voix sont deux états indépendants : masquer ne
  // coupe plus, couper ne masque plus. Les deux persistent séparément.
  {
    const { page, ctx: ctxVoices, errors: errorsVoices } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(600);
      const stavesBefore = await L.staffCount(page);
      const heightsBefore = await L.staffHeights(page);
      await L.openSettings(page);
      const rows = await L.partRows(page);
      const voiceLabel = rows[0]?.name;
      if (!voiceLabel || rows.length < 2) throw new Error('moins de deux voix : dissociation impossible');

      // 1) Masquée mais jouée : le rendu la retire, le moteur la garde.
      await L.markSvg(page);
      await page.click('#parts-list .part-display >> nth=0');
      await page.waitForTimeout(200);
      const rowsHidden = await L.partRows(page);
      await L.closeSettings(page);
      await waitRerender(page);
      const stavesHidden = await L.staffCount(page);
      const heightsHidden = await L.staffHeights(page);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.evaluate(() => window.__musicaAudio.startNoteLog());
      await page.waitForTimeout(1100);
      const hidden = await page.evaluate(async (label) => {
        const probe = await window.__musicaPlaybackProbe();
        const tracks = probe.trackMap?.[label] || [];
        const wanted = new Set(tracks.map(String));
        const log = window.__musicaAudio.getScheduledNotes();
        const notes = window.__musicaAudio.getNotes();
        return {
          gain: window.__musicaAudio.getVoiceGain(label),
          tracks,
          staffLabels: probe.staffLabels || [],
          midiBytes: probe.midiBytes,
          preparedVoice: notes.filter((n) => wanted.has(String(n.track))).length,
          preparedTotal: notes.length,
          scheduledTotal: log.length,
          state: window.__musicaPlaybackState().state,
        };
      }, voiceLabel);
      const renderedGone = heightsHidden && heightsBefore &&
        Math.abs(heightsHidden[0] - heightsBefore[1]) < 1;
      const hiddenUi = rowsHidden[0] && !rowsHidden[0].displayed && rowsHidden[0].played;
      const trackExists = Array.isArray(hidden.tracks) && hidden.tracks.length > 0;
      const audible = hidden.gain != null && hidden.gain > 0;
      L.record(results, '6. Voix masquée mais jouée : rendu sans la voix, audio avec', pageName,
        renderedGone && hiddenUi && trackExists && audible && hidden.preparedVoice > 0 &&
          hidden.scheduledTotal > 0 && hidden.state === 'playing' ? 'OK' : 'ÉCHEC',
        `${voiceLabel} : staves ${stavesBefore} → ${stavesHidden}, 1re portée ${heightsHidden?.[0]} ` +
        `(2e portée d'origine ${heightsBefore?.[1]}), affichage ${rowsHidden[0]?.displayed ? 'actif' : 'masqué'}, ` +
        `lecture ${rowsHidden[0]?.played ? 'active' : 'coupée'}, gain ${hidden.gain}, ` +
        `pistes [${hidden.tracks.join(',')}], notes préparées ${hidden.preparedVoice}/${hidden.preparedTotal}, ` +
        `notes ordonnancées ${hidden.scheduledTotal}, MIDI ${hidden.midiBytes} o, état ${hidden.state}`);
      await page.click('#transport-stop');
      await waitState(page, 'stopped');

      // 2) Affichée mais coupée : le rendu la garde, le moteur la tait.
      await L.openSettings(page);
      await L.markSvg(page);
      await page.click('#parts-list .part-display >> nth=0');
      await L.closeSettings(page);
      await waitRerender(page);
      const stavesRestored = await L.staffCount(page);
      await L.openSettings(page);
      await L.markSvg(page);
      await page.click('#parts-list .part-sound >> nth=0');
      await page.waitForTimeout(200);
      const rowsMuted = await L.partRows(page);
      await L.closeSettings(page);
      await page.waitForTimeout(500);
      const markerKept = await L.markerPresent(page);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.evaluate(() => window.__musicaAudio.startNoteLog());
      await page.waitForTimeout(1100);
      const muted = await page.evaluate(async (label) => {
        const probe = await window.__musicaPlaybackProbe();
        const tracks = probe.trackMap?.[label] || [];
        const wanted = new Set(tracks.map(String));
        const log = window.__musicaAudio.getScheduledNotes();
        const notes = window.__musicaAudio.getNotes();
        return {
          gain: window.__musicaAudio.getVoiceGain(label),
          tracks,
          preparedVoice: notes.filter((n) => wanted.has(String(n.track))).length,
          preparedTotal: notes.length,
          scheduledTotal: log.length,
          state: window.__musicaPlaybackState().state,
        };
      }, voiceLabel);
      const mutedUi = rowsMuted[0] && rowsMuted[0].displayed && !rowsMuted[0].played &&
        !rowsMuted[0].sizeDisabled && rowsMuted[0].volumeDisabled;
      L.record(results, '6. Voix affichée mais coupée : rendu intact, audio muet', pageName,
        stavesRestored === stavesBefore && mutedUi && markerKept &&
          muted.gain === 0 && muted.tracks.length > 0 && muted.preparedVoice > 0 &&
          muted.scheduledTotal > 0 && muted.state === 'playing' ? 'OK' : 'ÉCHEC',
        `${voiceLabel} : staves ${stavesBefore} → ${stavesRestored}, affichage ${rowsMuted[0]?.displayed ? 'actif' : 'masqué'}, ` +
        `lecture ${rowsMuted[0]?.played ? 'active' : 'coupée'}, gain ${muted.gain}, ` +
        `notes préparées ${muted.preparedVoice}/${muted.preparedTotal}, ordonnancées ${muted.scheduledTotal}, ` +
        `SVG marqué conservé ${markerKept}, état ${muted.state}`);
      await page.click('#transport-stop');
      await waitState(page, 'stopped');

      // 3) Persistance : la voix reste affichée et coupée après rechargement.
      await reloadPage(page);
      await waitReady(page);
      await waitLibraryReady(page);
      await L.openLibraryEntry(page, 0);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(800);
      await L.openSettings(page);
      const rowsReload = await L.partRows(page);
      const saved = await storedParts(page);
      const persisted = rowsReload[0] && rowsReload[0].displayed && !rowsReload[0].played &&
        saved && Array.isArray(saved.muted) && saved.muted.includes(voiceLabel) &&
        !(saved.hidden || []).includes(voiceLabel);
      L.record(results, '6. Voix coupée conservée après rechargement, affichage indépendant', pageName,
        persisted ? 'OK' : 'ÉCHEC',
        `affichage ${rowsReload[0]?.displayed ? 'actif' : 'masqué'}, lecture ${rowsReload[0]?.played ? 'active' : 'coupée'}, ` +
        `masquées ${JSON.stringify(saved?.hidden || [])}, coupées ${JSON.stringify(saved?.muted || [])}`);

      // 4) Au moins une voix affichée : la dernière ne peut plus être masquée.
      const rowsBefore = await L.partRows(page);
      await page.click('#parts-list .part-display >> nth=1');
      await page.waitForTimeout(200);
      const rowsOne = await L.partRows(page);
      await page.evaluate(() => document.querySelectorAll('#parts-list .part-display')[0].click());
      await page.waitForTimeout(100);
      const rowsAfterClick = await L.partRows(page);
      const guardOk = rowsOne[0] && rowsOne[0].displayed && rowsOne[1] && !rowsOne[1].displayed &&
        rowsOne[0].displayDisabled && !rowsOne[1].displayDisabled &&
        rowsAfterClick[0]?.displayed;
      L.record(results, '6. Au moins une voix affichée : dernier interrupteur désactivé', pageName,
        guardOk ? 'OK' : 'ÉCHEC',
        `avant ${rowsBefore.map((r) => (r.displayed ? 'x' : '-')).join(' ')}, ` +
        `après masquage ${rowsOne.map((r) => (r.displayed ? 'x' : '-') + (r.displayDisabled ? '(D)' : '')).join(' ')}, ` +
        `nouveau clic ignoré : ${rowsAfterClick[0]?.displayed}`);
    } catch (e) {
      L.record(results, '6. Dissociation affichage / lecture', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errorsVoices);
    L.record(results, '6. Erreurs JS (affichage et lecture des voix)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctxVoices.close();
  }

  // Transpositions : l'auditive décale les hauteurs réellement jouées sans
  // toucher aux données de lecture ni au rendu ; la visuelle transpose le
  // rendu à la fermeture des réglages sans changer le son.
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      await L.importFile(page, L.FILES.telemannXml);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(800);

      const noteheadY = () => page.evaluate(() => {
        const use = document.querySelector('#page-current .scroll-page svg g.notehead use');
        const match = use?.getAttribute('transform')?.match(/translate\(\s*[-0-9.]+[ ,]+([-0-9.]+)/);
        return match ? Number(match[1]) : null;
      });

      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.evaluate(() => window.__musicaAudio.startNoteLog());
      await page.waitForTimeout(1100);
      const base = await page.evaluate(() => ({
        notes: window.__musicaAudio.getNotes(),
        log: window.__musicaAudio.getScheduledNotes(),
      }));
      const baseOk = base.log.length > 0 && base.log.every((n) => n.pitch === n.sourcePitch);
      L.record(results, '6. Transposition auditive : référence à l’unisson', pageName,
        baseOk ? 'OK' : 'ÉCHEC',
        `${base.log.length} note(s) ordonnancée(s), hauteurs d’origine conservées : ${baseOk}`);

      // Auditive +2 pendant la lecture : les notes programmées suivantes sont
      // décalées, les données chargées et le SVG affiché restent intacts.
      await L.markSvg(page);
      await L.openSettings(page);
      await page.selectOption('#transpose-audio', '2');
      await page.waitForTimeout(300);
      const hot = await page.evaluate(() => ({
        engine: window.__musicaAudio.getTranspose(),
        marker: !!document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
      }));
      await page.evaluate(() => window.__musicaAudio.startNoteLog());
      await page.waitForTimeout(1100);
      const audible = await page.evaluate(() => ({
        log: window.__musicaAudio.getScheduledNotes(),
        notes: window.__musicaAudio.getNotes(),
      }));
      const shiftOk = audible.log.length > 0 && audible.log.every((n) =>
        n.pitch === Math.max(0, Math.min(127, n.sourcePitch + 2))) &&
        audible.log.some((n) => n.pitch !== n.sourcePitch);
      const notesIntact = JSON.stringify(audible.notes) === JSON.stringify(base.notes);
      L.record(results, '6. Transposition auditive +2 : hauteurs jouées décalées à chaud, rendu et données intacts', pageName,
        hot.engine === 2 && hot.marker && shiftOk && notesIntact ? 'OK' : 'ÉCHEC',
        `moteur ${hot.engine} demi-tons, SVG marqué conservé ${hot.marker}, ` +
        `${audible.log.length} note(s) décalée(s) de +2 : ${shiftOk}, notes chargées identiques : ${notesIntact}`);

      await page.selectOption('#transpose-audio', '0');
      await page.waitForTimeout(150);
      await page.evaluate(() => window.__musicaAudio.startNoteLog());
      await page.waitForTimeout(1100);
      const resetLog = await page.evaluate(() => window.__musicaAudio.getScheduledNotes());
      const resetOk = resetLog.length > 0 && resetLog.every((n) => n.pitch === n.sourcePitch);
      L.record(results, '6. Transposition auditive 0 : hauteurs d’origine rétablies à chaud', pageName,
        resetOk ? 'OK' : 'ÉCHEC', `${resetLog.length} note(s), hauteurs d’origine : ${resetOk}`);
      await L.closeSettings(page);
      await page.click('#transport-stop');
      await waitState(page, 'stopped');

      // Visuelle +2 : le rendu est transposé à la fermeture seulement, et les
      // données de lecture comme les hauteurs jouées restent inchangées.
      await page.evaluate(() => window.goToPage(1));
      await page.waitForTimeout(500);
      const yBefore = await noteheadY();
      await L.markSvg(page);
      await L.openSettings(page);
      await page.selectOption('#transpose-visual', '2');
      await page.waitForTimeout(300);
      const keptBeforeClose = await L.markerPresent(page);
      await L.closeSettings(page);
      await waitRerender(page);
      const yAfter = await noteheadY();
      // Une seconde majeure monte d'un degré : −90 unités Verovio à cette échelle.
      const renderOk = yBefore != null && yAfter != null && Math.abs(yAfter - (yBefore - 90)) <= 1;
      L.record(results, '6. Transposition visuelle +2 : rendu transposé à la fermeture', pageName,
        keptBeforeClose && renderOk ? 'OK' : 'ÉCHEC',
        `SVG conservé avant fermeture ${keptBeforeClose}, première tête de note y ${yBefore} → ${yAfter} ` +
        `(attendu ${yBefore != null ? yBefore - 90 : '?'})`);

      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.evaluate(() => window.__musicaAudio.startNoteLog());
      await page.waitForTimeout(1100);
      const visual = await page.evaluate(() => ({
        log: window.__musicaAudio.getScheduledNotes(),
        notes: window.__musicaAudio.getNotes(),
      }));
      const soundUnchanged = visual.log.length > 0 &&
        visual.log.every((n) => n.pitch === n.sourcePitch) &&
        JSON.stringify(visual.notes) === JSON.stringify(base.notes);
      L.record(results, '6. Transposition visuelle : son et données de lecture inchangés', pageName,
        soundUnchanged ? 'OK' : 'ÉCHEC',
        `${visual.log.length} note(s) à l’unisson, notes préparées identiques : ` +
        `${JSON.stringify(visual.notes) === JSON.stringify(base.notes)}`);
      await page.click('#transport-stop');
      await waitState(page, 'stopped');
    } catch (e) {
      L.record(results, '6. Transpositions', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (transpositions)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctx.close();
  }

  // Une partition = une lecture continue : à la fin d'un mouvement, la
  // lecture enchaîne sans pause sur le suivant (suivi compris), et un saut
  // vers une mesure d'un autre mouvement lit cette mesure-là. Fixture
  // synthétique à trois mouvements, hauteurs disjointes par mouvement
  // (ut/ré, mi/fa, sol/la) et tempo 120 explicite.
  {
    const { page, ctx: ctxChain, errors: errorsChain } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      await L.importFile(page, ENCHAINEMENT_FIXTURE);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(500);
      const layout = await page.evaluate(() => ({
        movements: movements.map((m) => ({ id: m.id, pages: m.pageCount, loaded: m.loaded })),
        pageCount,
      }));
      let start = 1;
      const starts = layout.movements.map((m) => {
        const first = start;
        start += m.pages || 0;
        return first;
      });
      const m1 = await playbackSample(page, 1);
      const m2 = await playbackSample(page, 2);
      L.record(results, '6. Mouvements : segments calés sur le temps absolu de la source', pageName,
        layout.movements.length === 3 && m2.segments.length > 0 &&
          m2.segments[0].fromMs > 0 && m2.offsetMs > 0 &&
          m2.sourceDurationMs > m2.offsetMs + m2.duration ? 'OK' : 'ÉCHEC',
        `${layout.movements.length} mouvement(s), pages ${starts.join('/')} ; ` +
        `mouvement 2 : premier segment à ${m2.segments[0]?.fromMs} ms, ` +
        `offset ${m2.offsetMs} ms, durée ${m2.duration} ms, source ${m2.sourceDurationMs} ms`);

      // (a) Enchaînement en fin de mouvement : la lecture reste active, la
      // position continue de croître et le suivi passe au mouvement 2.
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.evaluate((ms) => window.seekPlayback(ms), m1.duration - 400);
      let chained = null;
      try {
        await bounded('enchaînement vers le mouvement 2', 8000, page.waitForFunction(() => {
          const s = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
          return s && s.movementId === 2 && s.state === 'playing';
        }, null, { timeout: 8000, polling: 50 }));
        await page.waitForTimeout(600);
        chained = await page.evaluate(() => ({
          state: window.__musicaPlaybackState(),
          pitches: [...new Set(window.__musicaAudio.getNotes().map((n) => n.pitch))],
          page: displayedPage(),
        }));
      } catch (e) {
        chained = null;
      }
      const chainOk = chained && chained.state.state === 'playing' &&
        chained.pitches.length > 0 && chained.pitches.every((p) => p === 64 || p === 65) &&
        Math.abs(chained.state.offset - m1.duration) <= 20 &&
        Math.abs(chained.state.sourceDuration - 3 * m1.duration) <= 40 &&
        chained.state.displayPosition >= chained.state.offset &&
        chained.page >= starts[1] && chained.page < (starts[2] ?? (layout.pageCount + 1));
      L.record(results, '6. Enchaînement : la lecture continue sur le mouvement suivant', pageName,
        chainOk ? 'OK' : 'ÉCHEC',
        chained
          ? `état ${chained.state.state}, mouvement ${chained.state.movementId}, ` +
            `position affichée ${chained.state.displayPosition} ms / ${chained.state.sourceDuration} ms, ` +
            `offset ${chained.state.offset} ms, page ${chained.page} (mouvement 2 à ${starts[1]}), ` +
            `hauteurs jouées [${chained.pitches.join(',')}]`
          : 'le passage au mouvement 2 n’a pas eu lieu');

      // (b) Saut pendant la lecture vers le mouvement 2 : la lecture reprend
      // sur la mesure visée, avec les notes de ce mouvement (pas celles du
      // début du fichier).
      await page.click('#transport-stop');
      await waitState(page, 'stopped');
      await page.evaluate(() => window.goToPage(1));
      await page.waitForTimeout(400);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForTimeout(400);
      await page.evaluate((p) => window.goToPage(p), starts[1]);
      let jumped = null;
      try {
        await bounded('saut vers le mouvement 2 pendant la lecture', 8000, page.waitForFunction(() => {
          const s = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
          return s && s.movementId === 2 && s.state === 'playing';
        }, null, { timeout: 8000, polling: 50 }));
        await page.waitForTimeout(400);
        jumped = await page.evaluate(() => ({
          state: window.__musicaPlaybackState(),
          pitches: [...new Set(window.__musicaAudio.getNotes().map((n) => n.pitch))],
          page: displayedPage(),
        }));
      } catch (e) {
        jumped = null;
      }
      const jumpOk = jumped && jumped.state.state === 'playing' &&
        jumped.pitches.length > 0 && jumped.pitches.every((p) => p === 64 || p === 65) &&
        Math.abs(jumped.state.offset - m1.duration) <= 20 &&
        jumped.state.displayPosition >= jumped.state.offset &&
        jumped.page >= starts[1] && jumped.page < (starts[2] ?? (layout.pageCount + 1));
      L.record(results, '6. Saut pendant la lecture : le mouvement visé est joué', pageName,
        jumpOk ? 'OK' : 'ÉCHEC',
        jumped
          ? `état ${jumped.state.state}, mouvement ${jumped.state.movementId}, ` +
            `position affichée ${jumped.state.displayPosition} ms (offset ${jumped.state.offset}), ` +
            `page ${jumped.page}, hauteurs jouées [${jumped.pitches.join(',')}]`
          : 'la lecture n’a pas suivi le saut vers le mouvement 2');

      // (c) Saut à l'arrêt puis lecture : elle part de la page visée, pas du
      // début du mouvement.
      await page.click('#transport-stop');
      await waitState(page, 'stopped');
      await page.evaluate((p) => window.goToPage(p), starts[1]);
      await page.waitForTimeout(400);
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForFunction(() => {
        const s = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
        return s && s.movementId === 2;
      }, null, { timeout: 8000, polling: 50 });
      await page.waitForTimeout(400);
      const stoppedJump = await page.evaluate(() => ({
        state: window.__musicaPlaybackState(),
        pitches: [...new Set(window.__musicaAudio.getNotes().map((n) => n.pitch))],
      }));
      const stoppedJumpOk = stoppedJump.state.state === 'playing' &&
        stoppedJump.pitches.length > 0 &&
        stoppedJump.pitches.every((p) => p === 64 || p === 65) &&
        Math.abs(stoppedJump.state.offset - m1.duration) <= 20 &&
        stoppedJump.state.displayPosition >= stoppedJump.state.offset;
      L.record(results, '6. Saut à l’arrêt : la lecture part de la mesure visée', pageName,
        stoppedJumpOk ? 'OK' : 'ÉCHEC',
        `état ${stoppedJump.state.state}, mouvement ${stoppedJump.state.movementId}, ` +
        `position affichée ${stoppedJump.state.displayPosition} ms (offset ${stoppedJump.state.offset}), ` +
        `hauteurs jouées [${stoppedJump.pitches.join(',')}]`);
      await page.click('#transport-stop');
      await waitState(page, 'stopped');
    } catch (e) {
      L.record(results, '6. Enchaînement des mouvements', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    const relevantChain = L.summarize(errorsChain);
    L.record(results, '6. Erreurs JS (enchaînement des mouvements)', pageName,
      relevantChain.length ? 'ÉCHEC' : 'OK', relevantChain.join(' | '));
    await ctxChain.close();
  }

}

// Durées observées le 18/11/2026 (index.html + spa.html) : 83 à 113 s selon
// la charge ; budget ~2× le maximum, plus la fixture d'enchaînement.
C.main(runPage, { budgetMs: 300000, summary: 'S6A' });
