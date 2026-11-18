// Scénario 6d — reprises : marqueurs scoretk des deux passages, mode linéaire
// (« Dérouler les reprises » décoché) et bascule par l'interface. index.html et
// spa.html.
const C = require('./s6-common');
const L = C.L;
const {
  WAIT, bounded, waitReady, waitFirstSvg, waitBackgroundLoaded, reloadPage,
  state, waitState, transportHidden, positionGrowing, horizontalScrollPos,
  seekFraction, alignedOnSystem, storedParts, partVolumeValues, playbackSample,
  displayedPageNumber, waitLibraryReady,
} = C;

async function runPage(browser, url, pageName, results) {
  // Reprises : d'une part le suivi déroulé (copies « -rendN » résolues vers
  // l'id de base), d'autre part le mode linéaire demandé par le réglage
  // « Dérouler les reprises ». Les deux modes doivent rester distincts, avec
  // une durée linéaire nettement plus courte et un marqueur par mesure écrite.
  {
    const { page, ctx: ctxReprises, errors: errorsReprises } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      await L.importFile(page, L.FILES.laFouleMxl);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(600);

      // Le fichier est découpé en mouvements : collecter les marqueurs de
      // chacun jusqu'au premier mouvement non chargé.
      const collect = async (linear) => {
        const list = [];
        for (let id = 1; id <= 50; id += 1) {
          try {
            list.push(await playbackSample(page, id, linear));
          } catch {
            break;
          }
        }
        return list;
      };
      // Les réponses de ces demandes directes ne doivent pas entrer dans le
      // cache de l'application (son handler les prendrait pour le mode courant).
      await page.evaluate(() => {
        const w = window.__musicaWorker;
        w.__testOnMessage = w.onmessage;
        w.onmessage = null;
      });
      const expanded = await collect(false);
      const linear = await collect(true);
      await page.evaluate(() => {
        const w = window.__musicaWorker;
        w.onmessage = w.__testOnMessage;
        delete w.__testOnMessage;
      });
      const marksOf = (list) => list.flatMap((data) => data.syncMarks);
      const durationOf = (list) => list.reduce((sum, data) => sum + data.duration, 0);
      const maxGapOf = (list) => {
        let gap = 0;
        for (const data of list) {
          for (let i = 1; i < data.syncMarks.length; i += 1) {
            gap = Math.max(gap, data.syncMarks[i].t - data.syncMarks[i - 1].t);
          }
        }
        return gap;
      };
      const marksExpanded = marksOf(expanded);
      const marksLinear = marksOf(linear);
      const durationExpanded = durationOf(expanded);
      const durationLinear = durationOf(linear);
      // Un marqueur par mesure jouée (et non par note) : 98 occurrences pour
      // La_foule, réparties sur ses deux mouvements.
      L.record(results, '6. Reprises : les deux passages sont couverts par les marqueurs', pageName,
        marksExpanded.length >= 90 ? 'OK' : 'ÉCHEC',
        `${marksExpanded.length} marqueurs sur ${expanded.length} mouvement(s), durée ${Math.round(durationExpanded)} ms`);
      L.record(results, '6. Reprises : aucun trou de suivi au second passage', pageName,
        maxGapOf(expanded) <= 2000 ? 'OK' : 'ÉCHEC',
        `écart max entre marqueurs consécutifs ${maxGapOf(expanded)} ms`);

      // La_foule : 98 occurrences déroulées (scoretk, pas 104 : Verovio
      // rejouait les endings) -> 72 mesures écrites.
      const ratio = durationExpanded > 0 ? durationLinear / durationExpanded : 0;
      const shorter = durationLinear < durationExpanded && Math.abs(ratio - 72 / 98) <= 0.05;
      L.record(results, '6. Reprises décochées : durée écrite proche de 72/98 de la déroulée', pageName,
        shorter ? 'OK' : 'ÉCHEC',
        `déroulée ${Math.round(durationExpanded)} ms, écrite ${Math.round(durationLinear)} ms, rapport ${ratio.toFixed(3)}`);

      // Les marqueurs viennent de la timeline scoretk : aucun id de copie
      // Verovio « -rendN », tri croissant et pages locales >= 1.
      const allMarks = [...marksExpanded, ...marksLinear];
      const rendIds = allMarks.filter((m) => /-rend\d+$/.test(String(m.id || '')));
      const sortedPages = [...expanded, ...linear].every((data) => {
        const marks = data.syncMarks || [];
        for (let i = 1; i < marks.length; i += 1) if (marks[i].t < marks[i - 1].t) return false;
        return marks.every((m) => Number(m.page) >= 1);
      });
      L.record(results, '6. Marqueurs scoretk : aucun id « -rendN », triés, pages >= 1', pageName,
        rendIds.length === 0 && sortedPages && allMarks.length > 0 ? 'OK' : 'ÉCHEC',
        `${allMarks.length} marqueurs, ${rendIds.length} id « -rendN », tri et pages ${sortedPages}`);

      // Mode écrit : chaque mesure n'apparaît qu'une fois dans les segments,
      // et aucune occurrence déroulée ne subsiste.
      const linearMeasures = linear.flatMap((data) => data.segments.map((s) => s.measure));
      const uniqueLinear = new Set(linearMeasures).size === linearMeasures.length;
      const expandedMeasures = expanded.flatMap((data) => data.segments.map((s) => s.measure));
      const fewerOccurrences = linearMeasures.length < expandedMeasures.length;
      L.record(results, '6. Reprises décochées : chaque mesure écrite une seule fois', pageName,
        uniqueLinear && fewerOccurrences ? 'OK' : 'ÉCHEC',
        `${linearMeasures.length} segments écrits (${new Set(linearMeasures).size} mesures), ` +
        `${expandedMeasures.length} occurrences déroulées`);

      const allLinear = linear.every((data) => data.linearRepeats && data.segments.length > 0);
      L.record(results, '6. Reprises décochées : segments fournis pour chaque mouvement', pageName,
        allLinear && linear.length > 0 ? 'OK' : 'ÉCHEC',
        `${linear.length} mouvement(s), segments ${linear.map((d) => d.segments.length).join('/')}`);
      L.record(results, '6. Reprises décochées : un marqueur par mesure écrite, suivi sans trou', pageName,
        marksLinear.length >= 60 && maxGapOf(linear) <= 2000 ? 'OK' : 'ÉCHEC',
        `${marksLinear.length} marqueurs, écart max ${maxGapOf(linear)} ms`);

      // Bascule par l'UI : le réglage décoché est mémorisé, arrête la lecture
      // et fait recharger des données différentes pour le mouvement affiché.
      const probeBefore = await page.evaluate(() => window.__musicaPlaybackProbe());
      await L.openSettings(page);
      await page.$eval('#expand-repeats', (el) => {
        el.checked = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(300);
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('musica-settings') || '{}').expandRepeats);
      await L.closeSettings(page);
      const probeLinear = await page.evaluate(() => window.__musicaPlaybackProbe());
      const switched = saved === false && probeLinear.segmentsCount > 0 &&
        probeLinear.duration > 0 && probeLinear.duration < probeBefore.duration;
      L.record(results, '6. Réglage « Dérouler les reprises » décoché : données linéaires rechargées', pageName,
        switched ? 'OK' : 'ÉCHEC',
        `réglage ${saved}, durée affichée ${probeBefore.duration} → ${probeLinear.duration} ms, ` +
        `${probeLinear.syncMarksCount} marqueurs, ${probeLinear.segmentsCount} segments, ` +
        `linéaire ${probeLinear.linearRepeats}`);

      // Lecture complète du mouvement dans le mode écrit, fin propre.
      await page.click('#transport-play');
      await waitState(page, 'playing');
      const running = await state(page);
      const durationOk = Math.abs(running.duration - probeLinear.duration) <= 1000;
      await seekFraction(page, 0.995);
      await waitState(page, 'stopped');
      const finished = await state(page);
      L.record(results, '6. Reprises décochées : lecture jusqu’au bout sans erreur', pageName,
        durationOk && finished.state === 'stopped' ? 'OK' : 'ÉCHEC',
        `durée transport ${running.duration} ms (données ${probeLinear.duration} ms), ` +
        `état final ${finished.state}, position ${finished.position} ms`);

      // Changer le réglage en pleine lecture arrête la lecture.
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await L.openSettings(page);
      await page.$eval('#expand-repeats', (el) => {
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(300);
      const afterToggle = await state(page);
      await L.closeSettings(page);
      const probeExpanded = await page.evaluate(() => window.__musicaPlaybackProbe());
      const restored = afterToggle.state === 'stopped' &&
        probeExpanded.duration === probeBefore.duration && !probeExpanded.linearRepeats;
      L.record(results, '6. Réglage changé pendant la lecture : arrêt et retour au mode déroulé', pageName,
        restored ? 'OK' : 'ÉCHEC',
        `état ${afterToggle.state}, durée ${probeExpanded.duration} ms (avant ${probeBefore.duration} ms), ` +
        `linéaire ${probeExpanded.linearRepeats}`);
    } catch (e) {
      L.record(results, '6. Reprises : suivi et mode linéaire', pageName, 'ÉCHEC',
        'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errorsReprises);
    L.record(results, '6. Erreurs JS (reprises)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctxReprises.close();
  }

}

// Durées observées le 18/11/2026 (index.html + spa.html) : 59 à 80 s selon la
// charge ; budget ~2× le maximum.
C.main(runPage, { budgetMs: 180000, summary: 'S6D' });
