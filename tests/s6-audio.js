// Scénario 6 — aperçu audio : transport (lecture/pause/arrêt, progression,
// raccourcis p/s) et volume général conservé.
const path = require('path');
const L = require('./lib');

const PAGES = ['index.html', 'spa.html'];
const MOVEMENTS_FIXTURE = path.join(__dirname, 'fixtures', 'movements.xml');

// Bornes explicites des attentes de ce scénario, en millisecondes.
//
// Avant, chaque attente portait son délai en dur (5 à 240 s) : quand une
// étape ratait, ces délais s'additionnaient sans dire laquelle avait bloqué.
// Chaque borne vaut au moins 3 à 5 fois la durée observée maximale d'une
// campagne complète (index.html + spa.html, Chromium headless) ; les planchers
// (10 s pour un état, 20 s pour un chargement ou un rechargement) couvrent une
// machine plus lente et une campagne chargée. Durées observées le 18/11/2026 :
const WAIT = {
  // État du transport après un clic ou une touche : max 1,1 s (stopped).
  transportState: 10000,
  // Écran de chargement masqué, y compris après un rechargement : max 1,5 s.
  ready: 20000,
  // Bibliothèque proposée après un rechargement : max 13 ms.
  libraryReady: 20000,
  // Rechargement complet du document : max 0,6 s.
  reload: 20000,
  // Changement de page après un tap : max 11 ms.
  pageChange: 10000,
  // SVG de la page cible après un saut : max 7 ms.
  pageRendered: 10000,
  // Cale de la tête sur le premier marqueur de la page : max 0,3 s. Cette
  // attente est volontairement tolérante (elle contient la temporisation de
  // 700 ms du suivi) car un échec est ici un résultat testé, pas une panne.
  seekToPage: 5000,
  // Premier SVG après import d'une partition : max 3,4 s (Magnificat .mscz).
  // Le plancher de 20 s couvre une machine chargée pendant la campagne.
  firstSvg: 20000,
  // Fin du rendu de fond après import : l'indicateur est souvent déjà masqué
  // au premier SVG (max observé 0,3 s), donc cette borne n'est payée qu'en
  // cas de vrai blocage ; 60 s laisse le temps au rendu des gros fichiers.
  backgroundLoaded: 60000,
  // Arrêt de la lecture après changement de fichier ou redimensionnement :
  // max 0,3 s. Plancher de 20 s, le re-rendu complet peut être plus long.
  playbackStop: 20000,
  // Réponse playbackData d'un mouvement demandé directement au worker :
  // max 0,4 s pour un mouvement réel (sonde sur les quatre fichiers du
  // scénario). Un mouvement inexistant ne répond jamais : c'est cette borne
  // qui termine la collecte des reprises.
  playbackData: 10000,
};

// Exécute une attente bornée et, en cas de dépassement, nomme l'étape et sa
// borne : le message d'échec du scénario dit ainsi quelle attente a bloqué.
async function bounded(step, ms, promise) {
  try {
    return await promise;
  } catch (e) {
    if (e && e.name === 'TimeoutError') {
      throw new Error(`attente « ${step} » dépassée (borne ${ms} ms)`);
    }
    throw e;
  }
}

function waitReady(page) {
  return bounded('écran de chargement masqué', WAIT.ready, L.waitReady(page, WAIT.ready));
}

function waitFirstSvg(page) {
  return bounded('premier SVG de la partition', WAIT.firstSvg, L.waitFirstSvg(page, WAIT.firstSvg));
}

function waitBackgroundLoaded(page) {
  return bounded('fin du rendu de fond', WAIT.backgroundLoaded,
    L.waitBackgroundLoaded(page, WAIT.backgroundLoaded));
}

function reloadPage(page) {
  return bounded('rechargement de la page', WAIT.reload,
    page.reload({ waitUntil: 'domcontentloaded', timeout: WAIT.reload }));
}

async function state(page) {
  return page.evaluate(() => (window.__musicaPlaybackState ? window.__musicaPlaybackState() : null));
}

async function waitState(page, expected, timeout = WAIT.transportState) {
  await bounded(`état du transport « ${expected} »`, timeout, page.waitForFunction((name) => {
    const s = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
    return s && s.state === name;
  }, expected, { timeout, polling: 100 }));
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

// Position de défilement horizontale en demi-pages : page du premier
// .scroll-page et décalage de 50vw du wrapper (0 = début de page, 1 = milieu).
// Même convention que scrollPos dans src/app.coffee.
async function horizontalScrollPos(page) {
  return page.evaluate(() => {
    const first = document.querySelector('#page-current .scroll-page');
    const wrapper = document.querySelector('#page-current .scroll-wrapper');
    if (!first || !wrapper) return null;
    const pageNumber = parseInt(first.dataset.page, 10);
    if (!Number.isFinite(pageNumber)) return null;
    const m = /translateX\(-([\d.]+)vw\)/.exec(wrapper.style.transform || '');
    const half = m && parseFloat(m[1]) >= 25 ? 1 : 0;
    return (pageNumber - 1) * 2 + half;
  });
}

// La barre de progression a été supprimée : le déplacement se fait en
// cliquant sur le libellé de temps, proportionnellement à la position du clic
// (même geste que l'utilisateur, sans passer par un élément qui n'existe plus).
async function seekFraction(page, fraction) {
  const rect = await page.$eval('#transport-time', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!rect.width) throw new Error('libellé de temps invisible : seek impossible');
  await page.mouse.click(rect.x + fraction * rect.width, rect.y + rect.height / 2);
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
async function playbackSample(page, movementId = 1, linearRepeats = false) {
  return page.evaluate(({ id, linear, timeout }) => new Promise((resolve, reject) => {
    const w = window.__musicaWorker;
    const done = (fn, value) => {
      w.removeEventListener('message', onMessage);
      clearTimeout(timer);
      fn(value);
    };
    const onMessage = (e) => {
      const d = e.data || {};
      if (d.type === 'playbackData' && d.movementId === id) {
        done(resolve, {
          syncMarks: d.syncMarks || [],
          duration: Number(d.duration) || 0,
          segments: d.segments || [],
          linearRepeats: !!d.linearRepeats,
        });
      } else if (d.type === 'playbackError' && d.movementId === id) {
        done(reject, new Error(d.message || 'playbackError'));
      }
    };
    const timer = setTimeout(() => done(reject, new Error(
      `attente « données de lecture du mouvement ${id} » dépassée (borne ${timeout} ms)`)), timeout);
    w.addEventListener('message', onMessage);
    w.postMessage({ type: 'getPlaybackData', movementId: id, linearRepeats: linear });
  }), { id: movementId, linear: !!linearRepeats, timeout: WAIT.playbackData });
}

// Après un rechargement, le worker peut encore démarrer : attendre que la
// bibliothèque soit proposée avant de cliquer dessus.
async function displayedPageNumber(page) {
  return page.evaluate(() => {
    const txt = document.getElementById('page-number')?.textContent || '';
    const m = txt.match(/(\d+)\s*\//);
    return m ? parseInt(m[1], 10) : null;
  });
}

async function waitLibraryReady(page, timeout = WAIT.libraryReady) {
  await bounded('bibliothèque proposée', timeout, page.waitForFunction(() => {
    const overlay = document.getElementById('library-overlay');
    const button = document.getElementById('btn-library');
    return (overlay && !overlay.classList.contains('hidden')) ||
      (button && !button.classList.contains('hidden'));
  }, null, { timeout, polling: 100 }));
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

  // Non-régression de la boucle de lecture (version publiée 821b248) sur le
  // fichier réel du 1er mouvement du Magnificat de Bach : en lecture naturelle
  // avec suivi actif, la cale de page ne doit pas re-seeker en arrière et la
  // position doit rester monotone. Sur 821b248 les marqueurs du mouvement
  // commençaient à 90,25 s (durée 180 s) : le suivi restait bloqué page 1
  // pendant les 30 premières secondes. Les deux mesures ci-dessous échouent
  // donc sur l'ancien code et passent sur master. Sur le fichier actuel la
  // page 1 dure ~75 s : on démarre à une position d'où plusieurs pages
  // défilent en 30 s (calculée d'après les marqueurs, sans chemin en dur).
  if (L.FILES.magnificatBachMscz && require('fs').existsSync(L.FILES.magnificatBachMscz)) {
    const { page, ctx: ctxLoop, errors: errorsLoop } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      await L.importFile(page, L.FILES.magnificatBachMscz);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(800);

      // Marqueurs du mouvement affiché (mouvement 1) : le premier doit être au
      // début du mouvement, sinon le suivi et la cale sont désynchronisés.
      const sample = await playbackSample(page, 1);
      const firstMark = sample.syncMarks.length ? Number(sample.syncMarks[0].t) : null;
      L.record(results, '6. Magnificat : premier marqueur du mouvement 1 au début', pageName,
        firstMark != null && Number.isFinite(firstMark) && firstMark <= 500 ? 'OK' : 'ÉCHEC',
        `${sample.syncMarks.length} marqueurs, premier à ${firstMark} ms, durée ${sample.duration} ms`);

      // Position de départ : premier marqueur d'une fenêtre de 24 s qui
      // traverse au moins deux frontières de page (trois pages distinctes).
      // La marge de 6 s sur les 30 s de lecture absorbe l'imprécision du
      // déplacement (clic proportionnel sur le libellé de temps).
      const marks = sample.syncMarks
        .filter((m) => m.page != null && Number.isFinite(Number(m.t)))
        .map((m) => ({ t: Number(m.t), page: Number(m.page) }))
        .sort((a, b) => a.t - b.t);
      let startMs = null;
      for (let i = 0; i < marks.length && startMs == null; i += 1) {
        const seen = new Set();
        for (let j = i; j < marks.length && marks[j].t <= marks[i].t + 24000; j += 1) {
          seen.add(marks[j].page);
        }
        if (seen.size >= 3) startMs = marks[i].t;
      }
      if (startMs == null) startMs = 0;
      // La durée n'est connue du transport qu'une fois les données de lecture
      // chargées : un premier appui sur lecture puis pause permet de se
      // déplacer sur le libellé de temps, avant d'armer la sonde de seeks.
      if (startMs > 0 && sample.duration > 0) {
        await page.click('#transport-play');
        await waitState(page, 'playing');
        await page.click('#transport-play');
        await waitState(page, 'paused');
        await seekFraction(page, startMs / sample.duration);
        await page.waitForTimeout(600);
      }

      // Lecture naturelle de 30 s, suivi actif : compter les seeks moteur
      // (aucune action de test ne doit en déclencher) et échantillonner la
      // position et la page affichée.
      await page.evaluate(() => {
        window.__loopProbe = { seeks: [], samples: [] };
        const api = window.__musicaAudio;
        if (api && !api.__loopProbeWrapped) {
          api.__loopProbeWrapped = true;
          const orig = api.seek.bind(api);
          api.seek = (s) => {
            window.__loopProbe?.seeks.push(Math.round(s * 1000));
            return orig(s);
          };
        }
        window.__loopProbe.seeks = [];
        window.__loopProbe.samples = [];
        const slot = document.getElementById('page-current');
        window.__loopProbeTimer = setInterval(() => {
          const st = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
          const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
          window.__loopProbe.samples.push({
            pos: st ? st.position : null,
            page: m ? parseInt(m[1], 10) : null,
          });
        }, 100);
        void slot;
      });
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForTimeout(30000);
      const natural = await page.evaluate(() => {
        clearInterval(window.__loopProbeTimer);
        return window.__loopProbe;
      });
      const pages = [];
      for (const s of natural.samples) {
        if (s.page != null && pages[pages.length - 1] !== s.page) pages.push(s.page);
      }
      const pageChanges = Math.max(0, pages.length - 1);
      const backs = [];
      for (let i = 1; i < natural.samples.length; i += 1) {
        const a = natural.samples[i - 1].pos;
        const b = natural.samples[i].pos;
        if (a != null && b != null && b < a - 300) backs.push(`${a}->${b}@p${natural.samples[i].page}`);
      }
      L.record(results, '6. Magnificat : cale de page bornée en lecture avec suivi', pageName,
        natural.seeks.length <= pageChanges + 2 ? 'OK' : 'ÉCHEC',
        `${natural.seeks.length} seek(s) pour ${pageChanges} changement(s) de page ` +
        `[${natural.seeks.join(',')}], pages ${pages.join('>')}`);
      L.record(results, '6. Magnificat : position monotone en lecture avec suivi', pageName,
        backs.length === 0 ? 'OK' : 'ÉCHEC',
        `${backs.length} recul(s) de plus de 300 ms : ${backs.slice(0, 6).join(' ')}`);
      L.record(results, '6. Magnificat : le suivi fait avancer la page en 30 s', pageName,
        pageChanges >= 2 && pages[pages.length - 1] > pages[0] ? 'OK' : 'ÉCHEC',
        `pages ${pages.join('>')} (${pageChanges} changement(s))`);

      // Événement scroll périmé : le suivi vient de viser la page courante mais
      // un `scroll` différé mesure encore la page précédente (cas d'une liseuse
      // lente). Sans le garde-fou, la cale seek vers le début de cette page et
      // la lecture recule : c'est la boucle observée en production.
      const currentPage = pages[pages.length - 1];
      const staleBefore = await page.evaluate((prevPage) => {
        const slot = document.getElementById('page-current');
        const wrapper = slot.querySelector('.scroll-wrapper');
        if (!wrapper || !(prevPage >= 1)) return null;
        const fake = document.createElement('div');
        fake.className = 'scroll-page stale-probe';
        fake.dataset.page = String(prevPage);
        const slotTop = slot.getBoundingClientRect().top;
        fake.getBoundingClientRect = () => ({
          top: slotTop - 10, bottom: slotTop + 1, left: 0, right: 0, width: 100, height: 11,
        });
        wrapper.insertBefore(fake, wrapper.firstChild);
        slot.dispatchEvent(new Event('scroll'));
        return { pos: window.__musicaPlaybackState().position, seeks: window.__loopProbe.seeks.length };
      }, currentPage - 1);
      await page.waitForTimeout(700);
      const staleAfter = await page.evaluate(() => {
        const slot = document.getElementById('page-current');
        for (const el of slot.querySelectorAll('.scroll-page.stale-probe')) el.remove();
        // Le faux élément avait faussé l'indicateur de page : le rafraîchir.
        slot.dispatchEvent(new Event('scroll'));
        return { pos: window.__musicaPlaybackState().position, seeks: window.__loopProbe.seeks.length };
      });
      const staleOk = staleBefore && staleAfter.seeks === staleBefore.seeks &&
        staleAfter.pos >= staleBefore.pos - 300;
      L.record(results, '6. Magnificat : un scroll périmé du suivi ne fait pas reculer la tête', pageName,
        staleOk ? 'OK' : 'ÉCHEC',
        staleBefore ? `page ${currentPage}, ${staleBefore.seeks} → ${staleAfter.seeks} seek(s), ` +
          `position ${staleBefore.pos} → ${staleAfter.pos} ms` : 'injection impossible');

      // Pause : plus aucun seek, page et position stables.
      await page.click('#transport-play');
      await waitState(page, 'paused');
      await page.waitForTimeout(400);
      const pausedBefore = await page.evaluate(() => {
        const st = window.__musicaPlaybackState();
        const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
        return { pos: st.position, page: m ? parseInt(m[1], 10) : null, seeks: window.__loopProbe.seeks.length };
      });
      await page.waitForTimeout(1000);
      const pausedAfter = await page.evaluate(() => {
        const st = window.__musicaPlaybackState();
        const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
        return { pos: st.position, page: m ? parseInt(m[1], 10) : null, state: st.state, seeks: window.__loopProbe.seeks.length };
      });
      const pausedOk = pausedAfter.state === 'paused' &&
        Math.abs(pausedAfter.pos - pausedBefore.pos) <= 100 &&
        pausedAfter.page === pausedBefore.page && pausedAfter.seeks === pausedBefore.seeks;
      L.record(results, '6. Magnificat : en pause, page et position stables, aucun seek', pageName,
        pausedOk ? 'OK' : 'ÉCHEC',
        `p.${pausedBefore.page}/${pausedBefore.pos} ms → p.${pausedAfter.page}/${pausedAfter.pos} ms, ` +
        `seeks ${pausedBefore.seeks} → ${pausedAfter.seeks}, état ${pausedAfter.state}`);

      // Suivi désactivé : la lecture ne doit provoquer aucun seek ni changement
      // de page automatique.
      await page.click('#transport-stop');
      await waitState(page, 'stopped');
      await L.openSettings(page);
      await page.$eval('#follow-playback', (el) => {
        el.checked = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await L.closeSettings(page);
      const followOffStart = await page.evaluate(() => {
        window.__loopProbe.seeks = [];
        const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
        return { page: m ? parseInt(m[1], 10) : null, seeks: window.__loopProbe.seeks.length };
      });
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForTimeout(6000);
      const followOffEnd = await page.evaluate(() => {
        const st = window.__musicaPlaybackState();
        const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
        return { page: m ? parseInt(m[1], 10) : null, pos: st.position, seeks: window.__loopProbe.seeks.length };
      });
      L.record(results, '6. Magnificat, followPlayback=false : page stable, aucun seek', pageName,
        followOffEnd.page === followOffStart.page && followOffEnd.seeks === 0 && followOffEnd.pos > 1000 ? 'OK' : 'ÉCHEC',
        `page ${followOffStart.page} → ${followOffEnd.page}, position ${followOffEnd.pos} ms, ` +
        `${followOffEnd.seeks} seek(s)`);
      await page.click('#transport-stop');
      await waitState(page, 'stopped');
      await L.openSettings(page);
      await page.$eval('#follow-playback', (el) => {
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await L.closeSettings(page);
    } catch (e) {
      L.record(results, '6. Magnificat : boucle de lecture', pageName, 'ÉCHEC',
        'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errorsLoop);
    L.record(results, '6. Erreurs JS (Magnificat, boucle de lecture)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctxLoop.close();
  } else {
    L.record(results, '6. Magnificat : boucle de lecture', pageName, 'SAUTÉ',
      `fichier absent : ${L.FILES.magnificatBachMscz}`);
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
