// Aides communes aux scénarios s6 — aperçu audio.
//
// Les scénarios s6a à s6e se partagent les mêmes bornes d'attente, les mêmes
// attentes nommées et les mêmes sondes (état du transport, cale de page,
// données de lecture du worker). Seul le corps de `runPage` diffère : chaque
// fichier garde ses propres assertions et son propre budget global.
const path = require('path');
const L = require('./lib');

const PAGES = ['index.html', 'spa.html'];
const MOVEMENTS_FIXTURE = path.join(__dirname, 'fixtures', 'movements.xml');
// Trois mouvements de deux mesures, tempo 120 explicite, hauteurs disjointes
// par mouvement (ut/ré, mi/fa, sol/la).
const ENCHAINEMENT_FIXTURE = path.join(__dirname, 'fixtures', 'enchainement.xml');

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
// Même convention que scrollPos dans src/app/affichage-navigation.coffee.
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

// Déplacement dans la lecture par la barre de position (curseur natif) :
// même geste qu'un glissement, sans dépendre des coordonnées du pouce.
async function seekFraction(page, fraction) {
  await page.$eval('#transport-seek', (el, ratio) => {
    el.value = String(Math.round(Math.max(0, Math.min(1, ratio)) * 1000));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, fraction);
  await page.waitForTimeout(150);
}

// Remise au début par le raccourci clavier « s » (le bouton ■ a disparu).
async function stopPlayback(page) {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('s');
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
          offsetMs: Number(d.offsetMs) || 0,
          sourceDurationMs: Number(d.sourceDurationMs) || 0,
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

// Budget global d'un scénario : au-delà de `ms`, le fichier échoue proprement
// en le nommant, au lieu de laisser la campagne attendre indéfiniment. Le exit
// handler de lib.js écrit le bilan des assertions déjà comptées, et le code 1
// fait échouer run.sh (« ERREUR GÉNÉRALE » ancré en début de ligne).
function startBudget(ms) {
  const script = path.basename(process.argv[1] || 'scénario');
  const timer = setTimeout(() => {
    console.error(`ERREUR GÉNÉRALE budget dépassé : ${script} n'a pas terminé en ${Math.round(ms / 1000)} s`);
    process.exit(1);
  }, ms);
  // Ne retient pas le processus une fois le scénario terminé.
  timer.unref?.();
  return timer;
}

// Déroule `runPage` sur les deux pages (index.html puis spa.html), puis écrit
// le résumé JSON. `budgetMs` borne la durée totale du fichier.
async function main(runPage, { budgetMs, summary = 'S6' } = {}) {
  const timer = budgetMs ? startBudget(budgetMs) : null;
  const { server, url } = await L.startServer();
  const browser = await L.launch();
  const results = [];
  try {
    for (const pageName of PAGES) await runPage(browser, url, pageName, results);
  } catch (e) {
    console.log('ERREUR GÉNÉRALE', e.stack);
  }
  if (timer) clearTimeout(timer);
  console.log(`\n=== RÉSUMÉ ${summary} ===`);
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  server.close();
}

module.exports = {
  L, PAGES, MOVEMENTS_FIXTURE, ENCHAINEMENT_FIXTURE,
  WAIT, bounded, waitReady, waitFirstSvg, waitBackgroundLoaded, reloadPage,
  state, waitState, transportHidden, positionGrowing, horizontalScrollPos,
  seekFraction, stopPlayback, alignedOnSystem, storedParts, partVolumeValues, playbackSample,
  displayedPageNumber, waitLibraryReady,
  startBudget, main,
};
