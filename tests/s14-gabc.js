// Scénario 14 — ouverture d'un fichier gabc en notation carrée (exsurge),
// sans Verovio : import direct, une ligne de chant par page,
// titre/initiale, source-index et paroles, zoom, disposition horizontale,
// réouverture depuis la bibliothèque, transport et lecture, export refusé, gabc
// invalide signalé, contenu malveillant neutralisé, hors ligne (PWA), puis
// retour à un MusicXML normal (worker et transport). Vérifie aussi la bascule
// « carré / classique » : choix par fichier, position conservée, course des
// bascules rapides, absence de scoretk et bouton propre aux sources gabc.
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const PAGES = ['index.html', 'spa.html'];
const GABC_DIR = path.join(__dirname, 'fixtures', 'gabc');
const KYRIE = path.join(GABC_DIR, 'kyrie.gabc');
const LONG = path.join(GABC_DIR, 'long.gabc');
const ACCORD = path.join(GABC_DIR, 'accord.gabc');
const INVALIDE = path.join(GABC_DIR, 'invalide.gabc');
const MALVEILLANT = path.join(GABC_DIR, 'malveillant.gabc');
const KYRIE_MEI = path.join(GABC_DIR, 'kyrie.mei');
const KYRIE_GABC_XML = path.join(GABC_DIR, 'kyrie-gabc.musicxml');
const SANS_ENTETE = path.join(GABC_DIR, 'sans-entete.gabc');
const XML = path.join(__dirname, 'fixtures', 'enchainement.xml');
const MOVEMENTS_XML = path.join(__dirname, 'fixtures', 'movements.xml');

// Longueur de l'en-tête en unités UTF-16, comme exsurge et scoretk : tout ce
// qui précède le corps, ligne %% et son saut de ligne compris. La fixture
// contient « 𝄞 » (paire de substitution) : une longueur en octets ou en points
// de code décalerait le repère.
const LONG_HEADER = (() => {
  const text = fs.readFileSync(LONG, 'utf8');
  const match = text.match(/^[ \t]*%%+[ \t\r]*\r?\n/m);
  return match ? match.index + match[0].length : 0;
})();

function filePayload(name, file) {
  return {
    name,
    mimeType: name.endsWith('.gabc') ? 'text/plain' : 'application/xml',
    buffer: fs.readFileSync(file),
  };
}

// Instrumente le worker et le cache SVG avant le premier import : le rendu
// carré du gabc ne doit envoyer ni loadMovement ni écrire dans svgStore. Ses
// données de lecture passent par registerSource puis getPlaybackData (sourceId),
// sans rendu Verovio.
async function instrument(page) {
  await page.evaluate(() => {
    window.__s14msgs = [];
    const worker = window.__musicaWorker;
    const post = worker.postMessage.bind(worker);
    worker.postMessage = function (msg, ...rest) {
      window.__s14msgs.push(msg && msg.type);
      return post(msg, ...rest);
    };
    window.__s14sets = 0;
    const store = window.__svgCache;
    const set = store.set.bind(store);
    store.set = function (...args) {
      window.__s14sets += 1;
      return set(...args);
    };
  });
}

async function openLibraryForTest(page) {
  await page.waitForTimeout(300);
  const visible = await page.evaluate(() =>
    !document.getElementById('library-overlay').classList.contains('hidden'));
  if (!visible) {
    await page.evaluate(() => document.getElementById('btn-library').click());
    await page.waitForFunction(() =>
      !document.getElementById('library-overlay').classList.contains('hidden'), null, { timeout: 10000 });
  }
  await page.waitForSelector('#library-list .library-item:nth-child(1)', { state: 'visible' });
}

async function gabcState(page) {
  return page.evaluate(() => {
    const slot = document.getElementById('page-current');
    const svgs = [...slot.querySelectorAll('.scroll-page svg')];
    const text = [...slot.querySelectorAll('svg text')].map((el) => el.textContent).join(' ');
    const total = document.getElementById('page-number')?.textContent || '';
    return {
      svgs: svgs.length,
      chantLines: slot.querySelectorAll('g.chantLine').length,
      sourceIndex: slot.querySelectorAll('svg [source-index]').length,
      text,
      title: text.includes('Kyrie'),
      lyrics: /lé|ison|ri-e/.test(text),
      total,
      hasVerticalWrapper: !!slot.querySelector('.scroll-wrapper.vertical'),
      transportHidden: document.getElementById('transport').classList.contains('hidden'),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      slotOverflow: slot.scrollWidth - slot.clientWidth,
      svgRights: svgs.map((svg) => Math.round(svg.getBoundingClientRect().right)),
      firstHeight: svgs[0] ? svgs[0].getBoundingClientRect().height : 0,
      exsurge: !!window.exsurge,
      pwned: window.__gabcPwned,
      scripts: slot.querySelectorAll('script').length,
      onAttributes: [...slot.querySelectorAll('*')]
        .filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length,
      msgs: window.__s14msgs || [],
      sets: window.__s14sets || 0,
      errorText: document.getElementById('protocol-error')?.textContent || '',
      errorVisible: document.getElementById('protocol-error')?.style.display === 'block',
      importHidden: document.getElementById('import-section').classList.contains('hidden'),
    };
  });
}

// Chaque élément dessiné est ramené dans le repère du viewBox de son SVG
// (getScreenCTM), puis comparé au viewBox : rien ne doit dépasser, y compris le
// titre au-dessus de la première ligne, la clef à gauche et le custos à droite.
async function viewBoxState(page) {
  return page.evaluate(() => {
    const svgs = [...document.querySelectorAll('#page-current .scroll-page svg')];
    const failures = [];
    let count = 0;
    for (const svg of svgs) {
      const vb = svg.viewBox.baseVal;
      const inverse = svg.getScreenCTM()?.inverse();
      if (!inverse) continue;
      for (const el of svg.querySelectorAll('g, path, line, text, use, rect, polygon, tspan')) {
        if (el.closest('defs')) continue;
        const ctm = el.getScreenCTM();
        if (!ctm) continue;
        let b;
        try { b = el.getBBox(); } catch (e) { continue; }
        if (!b) continue;
        const m = inverse.multiply(ctm);
        const points = [
          [b.x, b.y], [b.x + b.width, b.y],
          [b.x, b.y + b.height], [b.x + b.width, b.y + b.height],
        ].map(([x, y]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
        const xs = points.map(([x]) => x);
        const ys = points.map(([, y]) => y);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const tol = 0.6;
        count += 1;
        if (minX < vb.x - tol || minY < vb.y - tol ||
            maxX > vb.x + vb.width + tol || maxY > vb.y + vb.height + tol) {
          failures.push({
            tag: el.tagName,
            cls: el.getAttribute('class') || '',
            box: [minX, minY, maxX, maxY].map((v) => Math.round(v * 100) / 100),
            viewBox: [vb.x, vb.y, vb.width, vb.height].map((v) => Math.round(v * 100) / 100),
          });
        }
      }
    }
    return {
      ok: failures.length === 0,
      count,
      svgs: svgs.length,
      failures: failures.slice(0, 5),
      viewBox: svgs[0] ? [svgs[0].viewBox.baseVal.x, svgs[0].viewBox.baseVal.y,
        svgs[0].viewBox.baseVal.width, svgs[0].viewBox.baseVal.height]
        .map((v) => Math.round(v * 100) / 100) : null,
    };
  });
}

async function importGabc(page, file, timeout = 60000) {
  await page.setInputFiles('#file-input', file);
  const first = await L.waitFirstSvg(page, timeout);
  await L.waitBackgroundLoaded(page, timeout);
  await page.waitForTimeout(400);
  return first;
}

// Attend que le préchargement ait fourni les données de lecture du mouvement
// affiché, puis renvoie la sonde de lecture.
async function waitPlaybackData(page, timeout = 120000) {
  await L.waitUntil(page, async () => {
    const probe = await window.__musicaPlaybackProbe();
    return probe.hasData && probe.midiBytes > 0;
  }, { timeout, interval: 200, what: 'données de lecture du mouvement affiché' });
  return page.evaluate(() => window.__musicaPlaybackProbe());
}

async function setZoom(page, value) {
  await page.evaluate((v) => {
    const range = document.getElementById('zoom-range');
    range.value = String(v);
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function setLayout(page, layout) {
  await L.openSettings(page);
  await page.click(`.layout-btn[data-layout="${layout}"]`);
  await L.closeSettings(page);
}

// Réglage global « Taille du texte », même geste que le zoom (direct sur le
// curseur, sans ouvrir les réglages : les gestionnaires sont déjà branchés).
async function setTextSize(page, value) {
  await page.evaluate((v) => {
    const range = document.getElementById('text-size-range');
    range.value = String(v);
    range.dispatchEvent(new Event('input', { bubbles: true }));
    range.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

// Attend que la première syllabe de la vue courante atteigne la hauteur
// voulue : le rechargement (mise en page grégorienne ou Verovio) est
// asynchrone.
async function waitLyricHeight(page, selector, test, height, timeout = 120000) {
  await page.waitForFunction(({ selector, test, height }) => {
    const el = document.querySelector('#page-current .scroll-page svg')?.querySelector(selector);
    if (!el) return false;
    const h = el.getBoundingClientRect().height;
    if (!(h > 0)) return false;
    return test === 'grew' ? h >= height * 1.25 : Math.abs(h - height) <= Math.max(0.6, height * 0.06);
  }, { selector, test, height }, { timeout, polling: 200 });
}

// Mesures de la vue carrée : une syllabe (text.lyric) et l'écart entre les
// lignes de portée (g.staffLines), que la taille du texte ne doit pas changer.
async function squareTextMetrics(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('#page-current .scroll-page svg');
    if (!svg) return null;
    const lyric = [...svg.querySelectorAll('text.lyric')].find((el) => /\S/.test(el.textContent));
    const lines = [...svg.querySelectorAll('g.staffLines line')];
    const bounds = lines.map((line) => line.getBoundingClientRect());
    return {
      text: lyric?.textContent.trim() || '',
      lyricHeight: lyric ? Math.round(lyric.getBoundingClientRect().height * 100) / 100 : 0,
      lyricFont: lyric ? parseFloat(getComputedStyle(lyric).fontSize) || 0 : 0,
      staffHeight: bounds.length
        ? Math.round((Math.max(...bounds.map((r) => r.bottom)) -
          Math.min(...bounds.map((r) => r.top))) * 100) / 100 : 0,
      remade: !svg.hasAttribute('data-test-mark'),
    };
  });
}

// Même mesure dans la vue classique (MusicXML rendu par Verovio) : syllabe
// dans g.verse, hauteur de portée donnée par les cinq lignes (path) de g.staff.
async function classicTextMetrics(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('#page-current .scroll-page svg');
    if (!svg) return null;
    const lyric = [...svg.querySelectorAll('g.verse g.syl text, g.verse text')]
      .find((el) => /\S/.test(el.textContent));
    const staff = svg.querySelector('g.staff');
    const ys = [];
    if (staff) {
      for (const path of staff.children) {
        if (path.tagName.toLowerCase() !== 'path' || !path.getAttribute('stroke')) continue;
        const r = path.getBoundingClientRect();
        ys.push(r.top, r.bottom);
      }
    }
    return {
      text: lyric?.textContent.trim() || '',
      lyricHeight: lyric ? Math.round(lyric.getBoundingClientRect().height * 100) / 100 : 0,
      lyricFont: lyric ? parseFloat(getComputedStyle(lyric.querySelector('tspan[font-size]') || lyric).fontSize) || 0 : 0,
      staffHeight: ys.length >= 2
        ? Math.round((Math.max(...ys) - Math.min(...ys)) * 100) / 100 : 0,
    };
  });
}

async function runPage(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 360, height: 720 },
  });
  try {
    await L.waitReady(page);
    await instrument(page);
    const exsurgeBefore = await page.evaluate(() => !!window.exsurge);

    // A. Import et disposition automatique (verticale).
    const first = await importGabc(page, KYRIE);
    let state = await gabcState(page);
    L.record(results, '14. gabc importé et affiché en notation carrée', pageName,
      first.svgCount >= 2 && state.svgs >= 2 && state.chantLines >= 2 ? 'OK' : 'ÉCHEC',
      `1er SVG en ${first.ms} ms, ${state.svgs} SVG, ${state.chantLines} lignes, pages ${state.total}`);
    L.record(results, '14. Titre de l’en-tête, paroles et source-index dans le SVG', pageName,
      state.title && state.lyrics && state.sourceIndex > 0 ? 'OK' : 'ÉCHEC',
      `titre ${state.title}, paroles ${state.lyrics}, ${state.sourceIndex} éléments source-index`);
    L.record(results, '14. Au moins deux lignes à 360 px, sans débordement horizontal', pageName,
      state.svgs >= 2 && state.hasVerticalWrapper && state.overflow <= 0 &&
      state.slotOverflow <= 0 && state.svgRights.every((right) => right <= 361) ? 'OK' : 'ÉCHEC',
      `pages ${state.total}, débordement doc ${state.overflow} px, slot ${state.slotOverflow} px, bords ${JSON.stringify(state.svgRights)}`);
    const forbidden = state.msgs.filter((type) => type === 'loadMovement');
    L.record(results, '14. Aucun chargement Verovio ni écriture svgStore pour le gabc', pageName,
      forbidden.length === 0 && state.sets === 0 ? 'OK' : 'ÉCHEC',
      `messages ${JSON.stringify(state.msgs)}, svgStore.set ${state.sets}`);
    L.record(results, '14. Transport visible et exsurge chargé seulement au premier gabc', pageName,
      !exsurgeBefore && state.exsurge && !state.transportHidden ? 'OK' : 'ÉCHEC',
      `exsurge avant ${exsurgeBefore}, après ${state.exsurge}, transport masqué ${state.transportHidden}`);
    const bounds = await viewBoxState(page);
    L.record(results, '14. Le getBBox de tout élément dessiné tient dans le viewBox', pageName,
      bounds.ok && bounds.count > 20 ? 'OK' : 'ÉCHEC',
      `${bounds.count} éléments dans ${bounds.svgs} SVG, viewBox ${JSON.stringify(bounds.viewBox)}` +
      (bounds.failures.length ? `, hors cadre ${JSON.stringify(bounds.failures)}` : ''));

    // B. Export refusé sans dialogue ni erreur.
    await page.click('#btn-menu');
    await page.click('#menu-export');
    await page.waitForTimeout(300);
    const exportHidden = await page.evaluate(() =>
      document.getElementById('export-overlay').classList.contains('hidden'));
    L.record(results, '14. Export désactivé pour un mouvement grégorien', pageName,
      exportHidden ? 'OK' : 'ÉCHEC', `dialogue masqué : ${exportHidden}`);

    // C. Zoom : les neumes grandissent et les lignes sont refaites.
    const beforeZoom = state;
    await setZoom(page, 80);
    await page.waitForFunction((height) => {
      const svg = document.querySelector('#page-current .scroll-page svg');
      return svg && svg.getBoundingClientRect().height > height * 1.3;
    }, beforeZoom.firstHeight, { timeout: 60000, polling: 200 });
    await L.waitBackgroundLoaded(page, 60000);
    const zoomed = await gabcState(page);
    L.record(results, '14. Zoom : neumes agrandis et lignes remises en page', pageName,
      zoomed.firstHeight > beforeZoom.firstHeight * 1.3 && zoomed.overflow <= 0 &&
      !zoomed.transportHidden && zoomed.sourceIndex > 0 ? 'OK' : 'ÉCHEC',
      `hauteur ${Math.round(beforeZoom.firstHeight)} → ${Math.round(zoomed.firstHeight)} px, pages ${beforeZoom.total} → ${zoomed.total}, débordement ${zoomed.overflow} px`);

    // D. Disposition horizontale imposée par l'utilisateur.
    await setLayout(page, 'horizontal');
    await page.waitForFunction(() => {
      const wrapper = document.querySelector('#page-current .scroll-wrapper');
      return wrapper && !wrapper.classList.contains('vertical') &&
        wrapper.querySelectorAll('.scroll-page svg').length >= 2;
    }, null, { timeout: 60000, polling: 200 });
    const horizontal = await gabcState(page);
    L.record(results, '14. Disposition horizontale imposée : un système par page', pageName,
      !horizontal.hasVerticalWrapper && horizontal.svgs >= 2 && horizontal.overflow <= 0 ? 'OK' : 'ÉCHEC',
      `SVG affichés ${horizontal.svgs}, pages ${horizontal.total}, débordement ${horizontal.overflow} px`);
    // Retour à la disposition automatique et au zoom initial pour la réouverture.
    await setLayout(page, 'auto');
    await setZoom(page, 40);
    await page.waitForTimeout(1000);
    await L.waitBackgroundLoaded(page, 60000);
    const afterSettings = await gabcState(page);
    const preloaded = await waitPlaybackData(page);
    const playbackRequests = afterSettings.msgs.filter((type) =>
      ['registerSource', 'getPlaybackData'].includes(type));
    L.record(results, '14. Réglages ouverts : lecture et transport disponibles pour le gabc', pageName,
      playbackRequests.length > 0 && preloaded.hasData && preloaded.midiBytes > 0 &&
        !afterSettings.transportHidden ? 'OK' : 'ÉCHEC',
      `messages ${JSON.stringify(afterSettings.msgs)}, données ${preloaded.hasData}, ` +
      `${preloaded.midiBytes} octets MIDI, transport masqué ${afterSettings.transportHidden}`);

    // E. Réouverture depuis la bibliothèque après rechargement.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page);
    await openLibraryForTest(page);
    await page.click('#library-list .library-item:nth-child(1) .library-item-info');
    await L.waitFirstSvg(page, 60000);
    await L.waitBackgroundLoaded(page, 60000);
    await waitPlaybackData(page);
    const reopened = await gabcState(page);
    L.record(results, '14. Réouverture depuis la bibliothèque en notation carrée', pageName,
      reopened.svgs >= 2 && reopened.sourceIndex > 0 && !reopened.transportHidden &&
      reopened.hasVerticalWrapper ? 'OK' : 'ÉCHEC',
      `SVG ${reopened.svgs}, pages ${reopened.total}, transport masqué ${reopened.transportHidden}`);

    // F. Paroles et en-tête malveillants : rien ne s'exécute.
    await page.evaluate(() => { window.__gabcPwned = undefined; });
    await importGabc(page, MALVEILLANT);
    const evil = await gabcState(page);
    L.record(results, '14. Scripts imbriqués et onload neutralisés, paroles « on x=1 » intactes', pageName,
      evil.svgs >= 1 && evil.pwned === undefined && evil.scripts === 0 &&
      evil.onAttributes === 0 && evil.text.includes('on x=1') ? 'OK' : 'ÉCHEC',
      `pwned ${evil.pwned}, scripts ${evil.scripts}, attributs on* ${evil.onAttributes}, ` +
      `« on x=1 » conservé ${evil.text.includes('on x=1')}`);

    // G. gabc invalide : message, retour à l'accueil, aucun blocage.
    await page.setInputFiles('#file-input', INVALIDE);
    await page.waitForFunction(() => {
      const el = document.getElementById('protocol-error');
      return el && el.style.display === 'block' && /gabc|invalide/i.test(el.textContent);
    }, null, { timeout: 30000, polling: 100 });
    const invalid = await gabcState(page);
    L.record(results, '14. gabc invalide : message d’erreur sans blocage', pageName,
      invalid.errorVisible && /invalide/i.test(invalid.errorText) ? 'OK' : 'ÉCHEC',
      invalid.errorText);

    // H. Un MusicXML ouvert ensuite garde transport et rendu normaux.
    await L.importFile(page, XML);
    const xmlFirst = await L.waitFirstSvg(page, 120000);
    await L.waitBackgroundLoaded(page, 120000);
    const afterXml = await page.evaluate(() => ({
      transportHidden: document.getElementById('transport').classList.contains('hidden'),
      staffs: document.querySelectorAll('#page-current .scroll-page svg g.staff').length,
      pageNumber: document.getElementById('page-number').textContent,
    }));
    L.record(results, '14. MusicXML ouvert après un gabc : transport et rendu normaux', pageName,
      xmlFirst.svgCount > 0 && !afterXml.transportHidden && afterXml.staffs > 0 ? 'OK' : 'ÉCHEC',
      `${afterXml.staffs} portées, pages ${afterXml.pageNumber}, transport masqué ${afterXml.transportHidden}`);

    // Un transport masqué volontairement (données absentes ou erreur de
    // lecture) doit le rester au changement de page d'un même MusicXML.
    await L.gotoPage(page, 2);
    await page.waitForTimeout(300);
    await page.evaluate(() => window.hideTransport());
    await L.gotoPage(page, 3);
    await page.waitForTimeout(500);
    const transportAfterPage = await page.evaluate(() =>
      document.getElementById('transport').classList.contains('hidden'));
    L.record(results, '14. MusicXML : un transport masqué reste masqué au changement de page', pageName,
      transportAfterPage ? 'OK' : 'ÉCHEC', `transport masqué ${transportAfterPage}`);

    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (gabc)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. Notation carrée gabc', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Hors ligne (PWA seulement) : le script exsurge doit être précaché par le
// service worker, puis un rechargement sans réseau doit rendre le gabc.
async function runOffline(browser, url, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName: 'index.html', viewport: { width: 360, height: 720 },
  });
  try {
    await L.waitReady(page, 60000);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await L.waitUntil(page, async () => {
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        if (await cache.match('./exsurge.min.js')) return true;
      }
      return false;
    }, { timeout: 60000, what: "mise en cache d'exsurge" });
    await ctx.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page, 60000);
    await importGabc(page, KYRIE, 90000);
    const state = await gabcState(page);
    L.record(results, '14. Hors ligne : exsurge précaché et gabc rendu', 'index.html',
      state.svgs >= 2 && state.exsurge && state.sourceIndex > 0 ? 'OK' : 'ÉCHEC',
      `SVG ${state.svgs}, pages ${state.total}`);
  } catch (e) {
    L.record(results, '14. Hors ligne : exsurge précaché et gabc rendu', 'index.html', 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Grand écran : la fixture longue doit tenir sur plusieurs lignes et rester
// entièrement dans le viewBox, sans débordement horizontal.
async function runLarge(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 1200, height: 900 },
  });
  try {
    await L.waitReady(page);
    await importGabc(page, KYRIE);
    const state = await gabcState(page);
    const total = parseInt((state.total.split('/')[1] || '0'), 10);
    const bounds = await viewBoxState(page);
    L.record(results, '14. Fixture longue : au moins trois lignes à 1200 px', pageName,
      total >= 3 && state.overflow <= 0 && state.svgRights.every((right) => right <= 1201) ? 'OK' : 'ÉCHEC',
      `${total} ligne(s), débordement ${state.overflow} px, bords ${JSON.stringify(state.svgRights)}`);
    L.record(results, '14. viewBox à 1200 px : aucun élément rogné', pageName,
      bounds.ok && bounds.count > 20 ? 'OK' : 'ÉCHEC',
      `${bounds.count} éléments, viewBox ${JSON.stringify(bounds.viewBox)}` +
      (bounds.failures.length ? `, hors cadre ${JSON.stringify(bounds.failures)}` : ''));
  } catch (e) {
    L.record(results, '14. Grand écran 1200 px', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Course entre une mise en page grégorienne remplacée (zoom) et la nouvelle :
// la vieille mise en page ne doit jamais écraser gregorienSvgs du mouvement
// courant. On retarde la première mise en page, on zoome, puis on attend que
// l'ancienne se termine.
async function runRace(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 360, height: 720 },
  });
  try {
    await L.waitReady(page);
    await page.evaluate(() => {
      const original = window.miseEnPageGabc;
      let calls = 0;
      window.__s14LayoutCalls = () => calls;
      window.miseEnPageGabc = function (...args) {
        calls += 1;
        const layout = original.apply(this, args);
        if (calls === 1) {
          return new Promise((resolve, reject) => {
            setTimeout(() => layout.then(resolve, reject), 2500);
          });
        }
        return layout;
      };
    });
    await page.setInputFiles('#file-input', KYRIE);
    await page.waitForFunction(() => window.__s14LayoutCalls() >= 1, null, { timeout: 30000 });
    await page.waitForTimeout(200);
    // Rechargement (zoom 80) pendant que la première mise en page est en vol.
    // Le gabc n'est pas encore « chargé » : le réglage de zoom seul ne relance
    // pas, on force reloadScore comme le fait un vrai rechargement.
    await setZoom(page, 80);
    await page.evaluate(() => window.reloadScore(1));
    await page.waitForFunction(() => {
      const mv = window.movements && window.movements[0];
      if (!mv || !mv.gregorienSvgs || !mv.gregorienSvgs.length) return false;
      const match = mv.gregorienSvgs[0].match(/viewBox="[^"]*\s([\d.]+)"/);
      return match && Number(match[1]) > 300;
    }, null, { timeout: 30000, polling: 100 });
    const measure = () => page.evaluate(() => {
      const mv = window.movements && window.movements[0];
      const svgs = (mv && mv.gregorienSvgs) || [];
      return svgs.map((svg) => {
        const match = svg.match(/viewBox="[^"]*\s([\d.]+)"/);
        return match ? Number(match[1]) : 0;
      });
    });
    const beforeOld = await measure();
    await page.waitForTimeout(3200);
    const afterOld = await measure();
    const unchanged = beforeOld.length > 0 && afterOld.length === beforeOld.length &&
      afterOld.every((h, i) => Math.abs(h - beforeOld[i]) < 1);
    L.record(results, '14. Une mise en page grégorienne remplacée n’écrase pas le nouveau mouvement', pageName,
      unchanged && beforeOld[0] > 300 ? 'OK' : 'ÉCHEC',
      `${beforeOld.length} → ${afterOld.length} ligne(s), hauteurs avant ${JSON.stringify(beforeOld.slice(0, 4))}, ` +
      `après ${JSON.stringify(afterOld.slice(0, 4))}`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (course de chargement)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. Une mise en page grégorienne remplacée n’écrase pas le nouveau mouvement', pageName,
      'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

async function mixedState(page, start) {
  await L.gotoPage(page, start);
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const wrapper = document.querySelector('#page-current .scroll-wrapper');
    return {
      page: document.getElementById('page-number').textContent,
      vertical: !!wrapper && wrapper.classList.contains('vertical'),
      gabcStaff: document.querySelectorAll('#page-current .scroll-page svg line.staffLine').length,
      verovioStaff: document.querySelectorAll('#page-current .scroll-page svg g.staff').length,
      transportHidden: document.getElementById('transport').classList.contains('hidden'),
    };
  });
}

async function movementStart(page, predicate) {
  return page.evaluate((source) => {
    const test = new Function('m', `return (${source})(m);`);
    let start = 1;
    for (const m of (window.movements || [])) {
      if (test(m)) return start;
      start += m.pageCount || 0;
    }
    return null;
  }, predicate.toString());
}

// Dossier mixte : le mode décidé pour un gabc ne doit pas s'appliquer au
// MusicXML suivant ; inversement, le mode d'un MusicXML déjà décidé reste.
async function runMixed(browser, url, pageName, results) {
  // A. gabc puis MusicXML : le MusicXML doit être détecté horizontal.
  {
    const { page, ctx, errors } = await L.newPage(browser, url, {
      pageName, viewport: { width: 500, height: 900 },
    });
    try {
      await L.waitReady(page);
      await page.setInputFiles('#file-input', [
        filePayload('a-kyrie.gabc', KYRIE),
        filePayload('z-enchainement.xml', XML),
      ]);
      await L.waitFirstSvg(page, 60000);
      await L.waitBackgroundLoaded(page, 120000);
      const start = await movementStart(page, (m) => !m.gregorien && m.loaded);
      const state = start ? await mixedState(page, start) : null;
      L.record(results, '14. Dossier gabc puis MusicXML : le gabc ne force pas le mode du MusicXML', pageName,
        state && !state.vertical && state.verovioStaff > 0 ? 'OK' : 'ÉCHEC',
        JSON.stringify({ start, state }));
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (dossier gabc puis MusicXML)', pageName,
        relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '14. Dossier gabc puis MusicXML', pageName, 'ÉCHEC',
        'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // B. MusicXML puis gabc : le mode horizontal du MusicXML est conservé, et le
  // transport reste disponible sur la page grégorienne.
  {
    const { page, ctx, errors } = await L.newPage(browser, url, {
      pageName, viewport: { width: 500, height: 900 },
    });
    try {
      await L.waitReady(page);
      await page.setInputFiles('#file-input', [
        filePayload('a-enchainement.xml', XML),
        filePayload('z-kyrie.gabc', KYRIE),
      ]);
      await L.waitFirstSvg(page, 60000);
      await L.waitBackgroundLoaded(page, 120000);
      const start = await movementStart(page, (m) => m.gregorien && m.loaded);
      const state = start ? await mixedState(page, start) : null;
      if (state) await waitPlaybackData(page);
      L.record(results, '14. Dossier MusicXML puis gabc : le mode du MusicXML reste, transport disponible', pageName,
        state && !state.vertical && state.gabcStaff > 0 && !state.transportHidden ? 'OK' : 'ÉCHEC',
        JSON.stringify({ start, state }));
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (dossier MusicXML puis gabc)', pageName,
        relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '14. Dossier MusicXML puis gabc', pageName, 'ÉCHEC',
        'exception du test : ' + e.message);
    }
    await ctx.close();
  }
}

// --- Bascule carré / classique ---------------------------------------------

async function notationState(page) {
  return page.evaluate(() => {
    const btn = document.getElementById('notation-toggle');
    const slot = document.getElementById('page-current');
    const rect = btn ? btn.getBoundingClientRect() : null;
    const ids = [...slot.querySelectorAll('.scroll-page svg [id]')]
      .map((el) => el.getAttribute('id') || '')
      .filter((id) => /-o\d+-e\d+$/.test(id));
    const number = document.getElementById('page-number')?.textContent || '';
    const match = number.match(/\d+\s*\/\s*(\d+)/);
    return {
      view: window.notationView,
      pressed: btn?.getAttribute('aria-pressed'),
      hidden: !btn || btn.classList.contains('hidden'),
      label: btn?.textContent?.trim() || '',
      buttonRect: rect ? {
        left: Math.round(rect.left), right: Math.round(rect.right),
        top: Math.round(rect.top), width: Math.round(rect.width),
        height: Math.round(rect.height),
      } : null,
      staffs: slot.querySelectorAll('.scroll-page svg g.staff').length,
      staffLines: (() => {
        const staff = slot.querySelector('.scroll-page svg g.staff');
        return staff ? [...staff.children].filter((el) => el.tagName === 'path').length : 0;
      })(),
      text: [...slot.querySelectorAll('.scroll-page svg text')].map((el) => el.textContent).join(' '),
      chantLines: slot.querySelectorAll('.scroll-page svg g.chantLine').length,
      squareNotes: slot.querySelectorAll('.scroll-page svg .note[source-index]').length,
      classicNotes: ids.length,
      total: match ? parseInt(match[1], 10) : 0,
      transportHidden: document.getElementById('transport').classList.contains('hidden'),
      exportHidden: document.getElementById('export-overlay').classList.contains('hidden'),
      errorText: document.getElementById('protocol-error')?.textContent || '',
      errorVisible: document.getElementById('protocol-error')?.style.display === 'block',
      importHidden: document.getElementById('import-section').classList.contains('hidden'),
      loadingHidden: document.getElementById('overlay-loading').classList.contains('hidden'),
      movements: (window.movements || []).length,
      restoring: !!window.positionBascule,
      headerLen: window.movements?.[0]?.enteteLongueur ?? null,
      probe: window.__musicaNotationProbe?.() ?? null,
    };
  });
}

// Attend la fin d'une bascule : plus aucune restauration en cours et un SVG du
// type attendu. Le prédicat reste synchrone ; L.waitUntil l'interroge à
// intervalles (aucun waitForFunction async).
async function waitNotationReady(page, timeout = 120000) {
  await L.waitUntil(page, () => {
    if (window.positionBascule) return false;
    const svg = document.querySelector('#page-current .scroll-page svg');
    if (!svg) return false;
    if (window.notationView === 'square') return !!svg.querySelector('.note[source-index]');
    return !!svg.querySelector('g.staff');
  }, { timeout, interval: 200, what: 'mise à jour de la vue de notation' });
}

async function clickToggle(page) {
  await page.evaluate(() => {
    document.getElementById('notation-toggle')?.scrollIntoView({ block: 'nearest' });
  });
  await page.click('#notation-toggle');
}

// Positions source des notes visibles, en unités UTF-16 depuis le début du
// fichier : source-index + en-tête en carré, -o du MusicXML en classique.
async function visibleNotePositions(page, view, headerLen) {
  return page.evaluate(({ view, headerLen }) => {
    const slot = document.getElementById('page-current');
    const slotRect = slot.getBoundingClientRect();
    const result = [];
    for (const el of slot.querySelectorAll('.scroll-page svg .note, .scroll-page svg [id]')) {
      let pos = null;
      if (view === 'square') {
        const index = el.getAttribute('source-index');
        if (index != null && el.classList.contains('note')) pos = headerLen + Number(index);
      } else {
        const match = (el.getAttribute('id') || '').match(/-o(\d+)-e\d+$/);
        if (match) pos = Number(match[1]);
      }
      if (pos == null || !isFinite(pos)) continue;
      const box = el.getBoundingClientRect();
      if (box.bottom > slotRect.top && box.top < slotRect.bottom &&
          box.right > slotRect.left && box.left < slotRect.right) {
        result.push({ pos, id: el.getAttribute('id') || '', cls: el.getAttribute('class') || '' });
      }
    }
    result.sort((a, b) => a.pos - b.pos);
    return result;
  }, { view, headerLen });
}

// État complet du transport et de la lecture, pour les vérifications de la
// lecture en notation carrée.
async function playbackSnapshot(page) {
  return page.evaluate(() => {
    const state = window.__musicaPlaybackState();
    const seek = document.getElementById('transport-seek');
    const number = document.getElementById('page-number')?.textContent || '';
    const match = number.match(/\d+\s*\/\s*(\d+)/);
    return {
      ...state,
      transportHidden: document.getElementById('transport').classList.contains('hidden'),
      seekDisabled: !!seek?.disabled,
      seekValue: seek ? Number(seek.value) : 0,
      page: window.displayedPage ? window.displayedPage() : null,
      total: match ? parseInt(match[1], 10) : 0,
    };
  });
}

// Vue carrée : transport visible, ▶, avancement, changement de page sans effet,
// reprise après la barre, et MIDI/durée identiques à la vue classique.
async function runGabcPlayback(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 360, height: 720 },
  });
  try {
    await L.waitReady(page);
    await importGabc(page, KYRIE);

    const preloaded = await waitPlaybackData(page);
    const ready = await playbackSnapshot(page);
    L.record(results, '14. Vue carrée : transport visible et barre de position active', pageName,
      !ready.transportHidden && !ready.seekDisabled && ready.duration > 0 &&
      preloaded.segmentsCount > 0 ? 'OK' : 'ÉCHEC',
      `transport masqué ${ready.transportHidden}, barre inactive ${ready.seekDisabled}, ` +
      `durée ${ready.duration} ms, ${preloaded.segmentsCount} segment(s)`);

    // ▶ : la lecture démarre et la position avance. Sous charge, le moteur peut
    // mettre plusieurs secondes à sortir du silence : attendre l'avancement
    // réel (position et curseur) plutôt qu'un délai fixe. Un délai expiré
    // n'interrompt pas le scénario : l'assertion s'enregistre en ÉCHEC.
    const beforePlay = await playbackSnapshot(page);
    await page.evaluate((start) => { window.__s14PlayStart = start; }, beforePlay.position);
    await page.click('#transport-play');
    let advanced = false;
    try {
      await L.waitUntil(page, () => {
        const state = window.__musicaPlaybackState();
        const seek = document.getElementById('transport-seek');
        return state.state === 'playing' && state.position > window.__s14PlayStart &&
          !!seek && Number(seek.value) > 0;
      }, { timeout: 30000, interval: 100, what: 'avancement de la lecture' });
      advanced = true;
    } catch (e) {
      advanced = false;
    }
    const playing = await playbackSnapshot(page);
    L.record(results, '14. Vue carrée : ▶ passe en lecture et la position avance', pageName,
      advanced && playing.state === 'playing' && playing.position > beforePlay.position &&
      playing.seekValue > 0 ? 'OK' : 'ÉCHEC',
      `${advanced ? '' : 'délai expiré, '}état ${playing.state}, ` +
      `position ${beforePlay.position} → ${playing.position} ms, curseur ${playing.seekValue}`);

    // Changement de page pendant la lecture : même mouvement, tête de lecture
    // inchangée (elle continue d'avancer, sans saut ni retour à zéro).
    const turnPage = playing.total >= 2 ? playing.total : 1;
    const beforeTurn = await playbackSnapshot(page);
    await L.gotoPage(page, turnPage);
    await page.waitForTimeout(700);
    const afterTurn = await playbackSnapshot(page);
    L.record(results, '14. Vue carrée : changer de page pendant la lecture ne déplace pas la tête', pageName,
      afterTurn.state === 'playing' && afterTurn.movementId === beforeTurn.movementId &&
      afterTurn.position >= beforeTurn.position - 100 && afterTurn.position > 0 &&
      afterTurn.page === turnPage ? 'OK' : 'ÉCHEC',
      `page ${beforeTurn.page} → ${afterTurn.page}, position ${beforeTurn.position} → ${afterTurn.position} ms`);

    // À l'arrêt : la barre choisit une position, un changement de page ne la
    // change pas, et ▶ repart de cette position.
    await page.evaluate(() => window.stopPlayback());
    await L.waitUntil(page, () => window.__musicaPlaybackState().state === 'stopped',
      { timeout: 30000, interval: 100, what: 'arrêt de la lecture' });
    await page.evaluate(() => {
      const seek = document.getElementById('transport-seek');
      seek.value = '400';
      seek.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const chosen = await playbackSnapshot(page);
    const restPage = chosen.page === 1 ? turnPage : 1;
    await L.gotoPage(page, restPage);
    await page.waitForTimeout(600);
    const afterRestTurn = await playbackSnapshot(page);
    L.record(results, '14. Vue carrée : changer de page à l’arrêt ne change pas la position choisie', pageName,
      afterRestTurn.state === 'stopped' && Math.abs(afterRestTurn.position - chosen.position) <= 1 &&
      afterRestTurn.page === restPage ? 'OK' : 'ÉCHEC',
      `page ${chosen.page} → ${afterRestTurn.page}, position ${chosen.position} → ${afterRestTurn.position} ms`);

    // Reprise après la barre : attendre la position choisie (pas un délai fixe
    // qui, sous charge, mesurerait encore l'arrêt ou un silence). Le délai
    // expiré est enregistré comme échec, sans interrompre le scénario.
    await page.evaluate((from) => { window.__s14ResumeFrom = from; }, chosen.position);
    await page.click('#transport-play');
    let resumedStarted = false;
    try {
      await L.waitUntil(page, () => {
        const state = window.__musicaPlaybackState();
        return state.state === 'playing' && state.position >= window.__s14ResumeFrom;
      }, { timeout: 30000, interval: 100, what: 'reprise à la position choisie' });
      resumedStarted = true;
    } catch (e) {
      resumedStarted = false;
    }
    const resumed = await playbackSnapshot(page);
    L.record(results, '14. Vue carrée : ▶ après la barre repart de la position choisie', pageName,
      resumedStarted && resumed.state === 'playing' && resumed.position >= chosen.position &&
      resumed.position < chosen.position + 5000 ? 'OK' : 'ÉCHEC',
      `${resumedStarted ? '' : 'délai expiré, '}choisi ${chosen.position} ms, ` +
      `reprise ${resumed.position} ms`);
    await page.evaluate(() => window.stopPlayback());

    // Mêmes données de lecture que la vue classique du même fichier.
    const squareProbe = await page.evaluate(() => window.__musicaPlaybackProbe());
    await clickToggle(page);
    await waitNotationReady(page);
    const classicProbe = await waitPlaybackData(page);
    L.record(results, '14. Vue carrée : MIDI et durée identiques à la vue classique', pageName,
      squareProbe.hasData && classicProbe.hasData && squareProbe.midiBytes > 0 &&
      squareProbe.midiBytes === classicProbe.midiBytes &&
      squareProbe.duration === classicProbe.duration ? 'OK' : 'ÉCHEC',
      `carré ${squareProbe.midiBytes} octets / ${squareProbe.duration} ms, ` +
      `classique ${classicProbe.midiBytes} octets / ${classicProbe.duration} ms`);

    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (lecture carrée)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. Lecture en notation carrée', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// scoretk absent : la notation carrée reste affichée, le transport est masqué
// (aucune lecture possible) et aucune erreur n'est montrée à l'écran.
async function runScoretkAbsent(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 360, height: 720 },
  });
  try {
    await L.waitReady(page);
    await page.evaluate(() => { window.__musicaScoretkAvailable = false; });
    await page.setInputFiles('#file-input', KYRIE);
    await L.waitFirstSvg(page, 60000);
    await L.waitUntil(page, () => document.getElementById('transport').classList.contains('hidden'),
      { timeout: 30000, interval: 200, what: 'transport masqué sans scoretk' });
    const state = await gabcState(page);
    const probe = await page.evaluate(() => window.__musicaPlaybackProbe());
    L.record(results, '14. scoretk absent : notation affichée, transport masqué, aucune erreur', pageName,
      state.svgs >= 2 && state.chantLines >= 2 && state.transportHidden &&
      !state.errorVisible && !probe.hasData ? 'OK' : 'ÉCHEC',
      `SVG ${state.svgs}, lignes ${state.chantLines}, transport masqué ${state.transportHidden}, ` +
      `erreur visible ${state.errorVisible}, données ${probe.hasData}`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (scoretk absent)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. scoretk absent sans lecture', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Réglage « Taille du texte » pour un gabc : paroles agrandies, portée
// inchangée, rien de rogné en vue carrée, puis même effet en vue classique.
async function runTextSizeGabc(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 360, height: 720 },
  });
  try {
    await L.waitReady(page);
    await importGabc(page, KYRIE);
    const s100 = await squareTextMetrics(page);
    if (!s100?.lyricHeight || !s100.staffHeight) {
      throw new Error('paroles ou lignes de portée introuvables dans la vue carrée');
    }
    await page.evaluate(() => {
      document.querySelector('#page-current .scroll-page svg')?.setAttribute('data-test-mark', '1');
    });

    await setTextSize(page, 150);
    await waitLyricHeight(page, 'text.lyric', 'grew', s100.lyricHeight);
    await L.waitBackgroundLoaded(page, 60000);
    await page.waitForTimeout(400);
    const s150 = await squareTextMetrics(page);
    const growth = s150.lyricHeight / s100.lyricHeight;
    const staffSame = Math.abs(s150.staffHeight - s100.staffHeight) <= 1.5;
    L.record(results, '14. Taille du texte 150 % (carré) : paroles agrandies, portée inchangée', pageName,
      growth >= 1.35 && growth <= 1.65 && staffSame && s150.remade ? 'OK' : 'ÉCHEC',
      `syllabe « ${s100.text} » ${s100.lyricHeight} → ${s150.lyricHeight} px (×${growth.toFixed(2)}), ` +
      `police ${s100.lyricFont} → ${s150.lyricFont} px, portée ${s100.staffHeight} → ${s150.staffHeight} px, ` +
      `SVG refait ${s150.remade}`);

    const bounds = await viewBoxState(page);
    L.record(results, '14. Taille du texte 150 % (carré) : paroles non rognées dans le viewBox', pageName,
      bounds.ok && bounds.count > 20 ? 'OK' : 'ÉCHEC',
      `${bounds.count} éléments dans ${bounds.svgs} SVG, viewBox ${JSON.stringify(bounds.viewBox)}` +
      (bounds.failures.length ? `, hors cadre ${JSON.stringify(bounds.failures)}` : ''));

    // Retour à 100 % : le rendu initial revient, aucune page de 150 % réutilisée.
    await setTextSize(page, 100);
    await waitLyricHeight(page, 'text.lyric', 'same', s100.lyricHeight);
    await L.waitBackgroundLoaded(page, 60000);
    await page.waitForTimeout(400);
    const sBack = await squareTextMetrics(page);
    L.record(results, '14. Taille du texte : retour à 100 % (carré), rendu initial', pageName,
      Math.abs(sBack.lyricHeight - s100.lyricHeight) <= 0.6 &&
      Math.abs(sBack.staffHeight - s100.staffHeight) <= 1.5 ? 'OK' : 'ÉCHEC',
      `syllabe ${sBack.lyricHeight} px (initial ${s100.lyricHeight}), ` +
      `portée ${sBack.staffHeight} px (initial ${s100.staffHeight})`);

    // Vue classique : le MusicXML converti reçoit la même taille de paroles.
    await page.click('#notation-toggle');
    await waitNotationReady(page);
    const c100 = await classicTextMetrics(page);
    if (!c100?.lyricHeight || !c100.staffHeight) {
      throw new Error('paroles ou portée introuvables dans la vue classique');
    }
    await setTextSize(page, 150);
    await waitLyricHeight(page, 'g.verse g.syl text', 'grew', c100.lyricHeight);
    await L.waitBackgroundLoaded(page, 60000);
    await page.waitForTimeout(400);
    const c150 = await classicTextMetrics(page);
    const classicGrowth = c150.lyricHeight / c100.lyricHeight;
    L.record(results, '14. Taille du texte 150 % (vue classique) : paroles agrandies, portée inchangée', pageName,
      classicGrowth >= 1.35 && classicGrowth <= 1.65 &&
      Math.abs(c150.staffHeight - c100.staffHeight) <= 2 ? 'OK' : 'ÉCHEC',
      `syllabe « ${c100.text} » ${c100.lyricHeight} → ${c150.lyricHeight} px (×${classicGrowth.toFixed(2)}), ` +
      `police ${c100.lyricFont} → ${c150.lyricFont} px, portée ${c100.staffHeight} → ${c150.staffHeight} px`);

    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (taille du texte gabc)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. Taille du texte gabc', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Bouton présent, accessible, utilisable à 360 px, aller-retour clavier,
// export et transport propres à chaque vue.
async function runToggle(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 360, height: 720 },
  });
  try {
    await L.waitReady(page);
    await importGabc(page, KYRIE);
    const initial = await notationState(page);
    L.record(results, '14. Bascule : vue carrée par défaut, bouton visible et pressé', pageName,
      initial.view === 'square' && !initial.hidden && initial.pressed === 'true' &&
      initial.chantLines >= 2 && !initial.transportHidden ? 'OK' : 'ÉCHEC',
      JSON.stringify(initial));
    L.record(results, '14. Bascule : bouton libellé « Grégorien »', pageName,
      initial.label === 'Grégorien' ? 'OK' : 'ÉCHEC', `libellé « ${initial.label} »`);
    L.record(results, '14. Bascule : bouton utilisable à 360 px, sans débordement', pageName,
      initial.buttonRect && initial.buttonRect.left >= 0 && initial.buttonRect.right <= 360 &&
      initial.buttonRect.width >= 44 && initial.buttonRect.height >= 44 &&
      (await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        ? 'OK' : 'ÉCHEC',
      JSON.stringify(initial.buttonRect));

    // Clavier : focus + Entrée, puis Espace pour revenir.
    await page.focus('#notation-toggle');
    await page.keyboard.press('Enter');
    await waitNotationReady(page);
    const classic = await notationState(page);
    L.record(results, '14. Bascule : Entrée ouvre la vue classique (Verovio, transport)', pageName,
      classic.view === 'classic' && classic.pressed === 'false' && classic.staffs > 0 &&
      !classic.transportHidden ? 'OK' : 'ÉCHEC',
      `vue ${classic.view}, ${classic.staffs} portées, transport masqué ${classic.transportHidden}`);

    // La vue classique suit le chemin MusicXML ordinaire : données de lecture.
    const playback = await page.evaluate(() => window.__musicaPlaybackProbe());
    L.record(results, '14. Bascule : lecture disponible dans la vue classique', pageName,
      playback.hasData && playback.syncMarksCount > 0 && playback.midiBytes > 0 ? 'OK' : 'ÉCHEC',
      `données ${playback.hasData}, ${playback.syncMarksCount} marqueurs, ${playback.midiBytes} octets MIDI${playback.error ? `, erreur ${playback.error}` : ''}`);

    // Export disponible en classique, refusé en carré.
    await page.click('#btn-menu');
    await page.click('#menu-export');
    await L.waitUntil(page, () => document.querySelectorAll('#export-format option').length > 0,
      { timeout: 30000, what: 'formats d’export scoretk' });
    const exported = await notationState(page);
    const exportFormats = await page.$$eval('#export-format option', (options) => options.length);
    L.record(results, '14. Bascule : export refusé en carré, proposé en classique', pageName,
      !exported.exportHidden && exportFormats > 0 ? 'OK' : 'ÉCHEC',
      `dialogue export masqué ${exported.exportHidden}, ${exportFormats} format(s)`);
    if (!exported.exportHidden) {
      await page.click('#export-cancel');
      await page.waitForTimeout(200);
    }

    await page.focus('#notation-toggle');
    await page.keyboard.press('Space');
    await waitNotationReady(page);
    const square = await notationState(page);
    L.record(results, '14. Bascule : Espace revient à la vue carrée, transport disponible', pageName,
      square.view === 'square' && square.pressed === 'true' && square.chantLines >= 2 &&
      !square.transportHidden ? 'OK' : 'ÉCHEC',
      `vue ${square.view}, ${square.chantLines} lignes, transport masqué ${square.transportHidden}`);

    await page.click('#btn-menu');
    await page.click('#menu-export');
    await page.waitForTimeout(300);
    const noExport = await notationState(page);
    L.record(results, '14. Bascule : export de nouveau refusé en carré', pageName,
      noExport.exportHidden ? 'OK' : 'ÉCHEC', `dialogue masqué ${noExport.exportHidden}`);
    if (!noExport.exportHidden) await page.click('#export-cancel');

    // Mémoire par fichier après rechargement de la page.
    await clickToggle(page);
    await waitNotationReady(page);
    const chosen = await notationState(page);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page);
    await openLibraryForTest(page);
    await page.click('#library-list .library-item:nth-child(1) .library-item-info');
    await L.waitFirstSvg(page, 120000);
    await waitNotationReady(page);
    const remembered = await notationState(page);
    L.record(results, '14. Bascule : choix classique mémorisé après rechargement', pageName,
      chosen.view === 'classic' && remembered.view === 'classic' &&
      remembered.pressed === 'false' && remembered.staffs > 0 ? 'OK' : 'ÉCHEC',
      `avant ${chosen.view}, après ${remembered.view}, ${remembered.staffs} portées`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (bascule)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. Bascule carré / classique', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Plus grande position de note ≤ repère dans une vue, calculée indépendamment
// de la restauration de l'application en parcourant toutes les pages de la
// source. Sert à vérifier que la cible n'est pas simplement « en arrière ».
async function expectedTarget(page, view, reference, sourceIndex) {
  return page.evaluate(async ({ view, reference, sourceIndex }) => {
    const movements = (window.movements || []).filter((m) =>
      m.sourceIndex === sourceIndex && m.loaded && (m.pageCount || 0) > 0);
    let best = null;
    let first = null;
    for (const movement of movements) {
      const header = movement.enteteLongueur || 0;
      for (let page = 1; page <= movement.pageCount; page += 1) {
        const svg = await window.requestPage(movement.id, page);
        if (!svg) continue;
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        const selector = view === 'square' ? '.note[source-index]' : '[id]';
        for (const el of doc.querySelectorAll(selector)) {
          let pos = null;
          if (view === 'square') {
            const index = el.getAttribute('source-index');
            const cls = ` ${el.getAttribute('class') || ''} `;
            if (index != null && cls.includes(' note ')) pos = header + Number(index);
          } else {
            const match = (el.getAttribute('id') || '').match(/-o(\d+)-e\d+$/);
            if (match) pos = Number(match[1]);
          }
          if (pos == null || !isFinite(pos)) continue;
          if (best == null || pos > best) {
            if (pos <= reference) best = pos;
          }
          if (first == null || pos < first) first = pos;
        }
      }
    }
    return best == null ? first : best;
  }, { view, reference, sourceIndex });
}

// Position non initiale conservée dans une longue fixture : repère UTF-16
// (en-tête avec caractères hors ASCII et 𝄞), page intermédiaire, aller-retour.
async function runLongPosition(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 360, height: 720 },
  });
  try {
    await L.waitReady(page);
    await importGabc(page, LONG, 120000);
    const start = await notationState(page);
    // Fin de la fixture : la vue classique se découpe en plusieurs mouvements,
    // la cible peut donc changer de mouvement.
    const targetPage = Math.max(2, start.total - 2);
    await L.gotoPage(page, targetPage);
    await L.waitUntil(page, () => {
      const pages = [...document.querySelectorAll('#page-current .scroll-page')];
      return pages.some((div) => div.querySelector('svg .note[source-index]'));
    }, { timeout: 60000, what: 'notes carrées rendues après saut' });

    const before = await notationState(page);
    const squareVisible = await visibleNotePositions(page, 'square', LONG_HEADER);
    const reference = squareVisible[0]?.pos;
    L.record(results, '14. Longue fixture : en-tête mesuré en UTF-16 (𝄞 compris)', pageName,
      before.headerLen === LONG_HEADER && reference != null && reference > LONG_HEADER + 50 ? 'OK' : 'ÉCHEC',
      `en-tête ${before.headerLen} (attendu ${LONG_HEADER}), repère ${reference}, page ${targetPage}/${start.total}`);

    const switchStart = Date.now();
    await clickToggle(page);
    await waitNotationReady(page);
    const switchMs = Date.now() - switchStart;
    const classic = await notationState(page);
    const classicVisible = await visibleNotePositions(page, 'classic', LONG_HEADER);
    const target = classic.probe?.target;
    const sourceIndex = await page.evaluate(() =>
      window.getMovementForPage(window.displayedPage())?.movement?.sourceIndex ?? 0);
    const expectedClassic = await expectedTarget(page, 'classic', reference, sourceIndex);
    L.record(results, '14. Bascule vers classique : position conservée (dernière note ≤ repère)', pageName,
      classic.view === 'classic' && classic.staffs > 0 && target != null &&
      reference != null && expectedClassic != null && target.pos === expectedClassic &&
      classicVisible.some((note) => note.pos === target.pos) ? 'OK' : 'ÉCHEC',
      `repère ${reference}, cible ${JSON.stringify(target)}, attendu ${expectedClassic}, ` +
      `visibles ${JSON.stringify(classicVisible.slice(0, 4))}, bascule ${switchMs} ms`);
    L.record(results, '14. Bascules : durée mesurée sur la longue fixture', pageName,
      switchMs > 0 && switchMs < 60000 ? 'OK' : 'ÉCHEC',
      `${switchMs} ms pour ${start.total} pages carrées`);

    const returnReference = classicVisible[0]?.pos;
    await clickToggle(page);
    await waitNotationReady(page);
    const back = await notationState(page);
    const backVisible = await visibleNotePositions(page, 'square', LONG_HEADER);
    const returnTarget = back.probe?.target;
    const expectedSquare = await expectedTarget(page, 'square', returnReference, sourceIndex);
    L.record(results, '14. Retour en carré : position conservée et source-index visible', pageName,
      back.view === 'square' && back.chantLines >= 1 && returnTarget != null &&
      returnReference != null && expectedSquare != null && returnTarget.pos === expectedSquare &&
      backVisible.some((note) => note.pos === returnTarget.pos) ? 'OK' : 'ÉCHEC',
      `repère ${returnReference}, cible ${JSON.stringify(returnTarget)}, attendu ${expectedSquare}, ` +
      `visibles ${JSON.stringify(backVisible.slice(0, 4))}`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (position de bascule)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. Position conservée à la bascule', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Le choix vaut pour toutes les sources gabc d'un dossier mixte ; un MusicXML
// n'affiche jamais le bouton et reste rendu par le worker.
async function runMixedChoice(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 500, height: 900 },
  });
  try {
    await L.waitReady(page);
    await page.setInputFiles('#file-input', [
      { name: 'a-long.gabc', mimeType: 'text/plain', buffer: fs.readFileSync(LONG) },
      { name: 'b-kyrie.gabc', mimeType: 'text/plain', buffer: fs.readFileSync(KYRIE) },
      filePayload('c-enchainement.xml', XML),
    ]);
    await L.waitFirstSvg(page, 120000);
    await L.waitBackgroundLoaded(page, 180000);
    await clickToggle(page);
    await waitNotationReady(page);
    const first = await notationState(page);
    const secondStart = await movementStart(page, (m) => m.gabc && m.sourceIndex === 1 && m.loaded);
    const xmlStart = await movementStart(page, (m) => !m.gabc && m.loaded);
    let second = null;
    let xml = null;
    if (secondStart) {
      await L.gotoPage(page, secondStart);
      await L.waitUntil(page, () => !!document.querySelector('#page-current .scroll-page svg g.staff'),
        { timeout: 60000, what: 'second gabc classique rendu' });
      second = await notationState(page);
    }
    if (xmlStart) {
      await L.gotoPage(page, xmlStart);
      await L.waitUntil(page, () => !!document.querySelector('#page-current .scroll-page svg g.staff'),
        { timeout: 60000, what: 'MusicXML rendu' });
      xml = await notationState(page);
    }
    L.record(results, '14. Dossier mixte : le choix vaut pour toutes les sources gabc', pageName,
      first.view === 'classic' && first.staffs > 0 && second != null &&
      second.view === 'classic' && second.staffs > 0 && second.pressed === 'false' ? 'OK' : 'ÉCHEC',
      `premier ${first.view}/${first.staffs}, second ${second?.view}/${second?.staffs}, début ${secondStart}`);
    L.record(results, '14. Dossier mixte : bouton absent pour un MusicXML', pageName,
      xml != null && xml.hidden ? 'OK' : 'ÉCHEC',
      `début XML ${xmlStart}, bouton masqué ${xml?.hidden}`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (dossier mixte bascule)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. Dossier mixte et bascule', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Chant grégorien encodé autrement que gabc : un MEI neumatique et un
// MusicXML issu de gabc s'ouvrent comme kyrie.gabc (notation carrée exsurge,
// même corps) et basculent vers la vue classique. Un MusicXML ordinaire reste
// en rendu Verovio, sans bouton (runButtonAbsent, movements.xml).
async function runGregorienAutre(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 360, height: 720 },
  });
  try {
    await L.waitReady(page);
    // Référence : le même chant en gabc, ouvrable directement.
    await importGabc(page, KYRIE);
    const base = await notationState(page);

    await importGabc(page, KYRIE_MEI);
    const mei = await notationState(page);
    L.record(results, '14. MEI neumatique : notation carrée, même nombre de notes que le gabc', pageName,
      mei.view === 'square' && mei.chantLines >= 2 && mei.squareNotes > 0 &&
      mei.squareNotes === base.squareNotes ? 'OK' : 'ÉCHEC',
      `MEI ${mei.squareNotes} note(s) contre ${base.squareNotes} pour le gabc, ` +
      `${mei.chantLines} ligne(s)`);

    await clickToggle(page);
    await waitNotationReady(page);
    const meiClassic = await notationState(page);
    L.record(results, '14. MEI neumatique : bascule vers la vue classique', pageName,
      meiClassic.view === 'classic' && meiClassic.staffs > 0 && meiClassic.squareNotes === 0
        ? 'OK' : 'ÉCHEC',
      `vue ${meiClassic.view}, ${meiClassic.staffs} portée(s), ` +
      `${meiClassic.squareNotes} note(s) carrée(s)`);

    await importGabc(page, KYRIE_GABC_XML);
    const xml = await notationState(page);
    L.record(results, '14. MusicXML issu de gabc : notation carrée, même nombre de notes que le gabc', pageName,
      xml.view === 'square' && xml.chantLines >= 2 && xml.squareNotes > 0 &&
      xml.squareNotes === base.squareNotes ? 'OK' : 'ÉCHEC',
      `MusicXML ${xml.squareNotes} note(s) contre ${base.squareNotes} pour le gabc, ` +
      `${xml.chantLines} ligne(s)`);

    await clickToggle(page);
    await waitNotationReady(page);
    const xmlClassic = await notationState(page);
    L.record(results, '14. MusicXML issu de gabc : bascule vers la vue classique', pageName,
      xmlClassic.view === 'classic' && xmlClassic.staffs > 0 && xmlClassic.squareNotes === 0
        ? 'OK' : 'ÉCHEC',
      `vue ${xmlClassic.view}, ${xmlClassic.staffs} portée(s), ` +
      `${xmlClassic.squareNotes} note(s) carrée(s)`);

    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (chant grégorien encodé autrement)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. Chant grégorien encodé autrement', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// gabc brut de GregoBase : corps seul, sans en-tête ni ligne %%. exsurge
// l'affiche tel quel ; scoretk ne le convertit qu'après le préfixe %% ajouté
// par Cantus avant l'envoi.
async function runSansEntete(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 360, height: 720 },
  });
  try {
    await L.waitReady(page);
    await importGabc(page, SANS_ENTETE);
    const square = await notationState(page);
    L.record(results, '14. gabc sans en-tête : notation carrée', pageName,
      square.view === 'square' && square.chantLines >= 1 && square.squareNotes >= 3
        ? 'OK' : 'ÉCHEC',
      `vue ${square.view}, ${square.chantLines} ligne(s), ${square.squareNotes} note(s)`);

    await clickToggle(page);
    await waitNotationReady(page);
    const classic = await notationState(page);
    L.record(results, '14. gabc sans en-tête : bascule classique sans erreur', pageName,
      classic.view === 'classic' && classic.staffs > 0 && !classic.errorVisible
        ? 'OK' : 'ÉCHEC',
      `vue ${classic.view}, ${classic.staffs} portée(s), erreur visible ${classic.errorVisible}`);

    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (gabc sans en-tête)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. gabc sans en-tête', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

async function runButtonAbsent(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  try {
    await L.waitReady(page);
    await L.importFile(page, MOVEMENTS_XML);
    await L.waitFirstSvg(page, 120000);
    await L.waitBackgroundLoaded(page, 120000);
    const state = await notationState(page);
    L.record(results, '14. Bouton de bascule absent pour un MusicXML', pageName,
      state.hidden && state.staffs > 0 ? 'OK' : 'ÉCHEC',
      `masqué ${state.hidden}, ${state.staffs} portées`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (bouton absent)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. Bouton absent pour MusicXML', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// scoretk absent ou conversion en échec : message et retour à la vue carrée,
// jamais d'écran vide.
async function runScoretkFallback(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 360, height: 720 },
  });
  try {
    await L.waitReady(page);
    await importGabc(page, KYRIE);
    await page.evaluate(() => { window.__musicaScoretkAvailable = false; });
    await clickToggle(page);
    await page.waitForTimeout(500);
    const absent = await notationState(page);
    L.record(results, '14. scoretk absent : message, vue carrée conservée', pageName,
      absent.view === 'square' && absent.pressed === 'true' && absent.chantLines >= 2 &&
      absent.errorVisible && /scoretk/i.test(absent.errorText) ? 'OK' : 'ÉCHEC',
      `vue ${absent.view}, bouton ${absent.pressed}, erreur « ${absent.errorText} »`);

    await page.evaluate(() => {
      window.__musicaScoretkAvailable = true;
      window.convertScoretkToXml = () => Promise.reject(new Error('échec simulé de conversion'));
      const el = document.getElementById('protocol-error');
      if (el) el.style.display = 'none';
    });
    await clickToggle(page);
    await L.waitUntil(page, () => {
      const el = document.getElementById('protocol-error');
      return el && el.style.display === 'block' && /échec simulé/.test(el.textContent || '');
    }, { timeout: 60000, what: 'message de repli de conversion gabc' });
    await waitNotationReady(page);
    const failed = await notationState(page);
    L.record(results, '14. Conversion classique en échec : retour en carré, pas d’écran vide', pageName,
      failed.view === 'square' && failed.pressed === 'true' && failed.chantLines >= 2 &&
      failed.importHidden && failed.loadingHidden && /échec simulé/.test(failed.errorText) ? 'OK' : 'ÉCHEC',
      `vue ${failed.view}, ${failed.chantLines} lignes, erreur « ${failed.errorText} »`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (repli scoretk)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. Repli sans scoretk', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Vue classique moderne : clef de sol sur cinq lignes et texte alternatif
// ([alt:...]) rendu par Verovio quand scoretk émet des <words>.
async function runModernClef(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 500, height: 900 },
  });
  try {
    await L.waitReady(page);
    await importGabc(page, ACCORD, 120000);
    await clickToggle(page);
    await waitNotationReady(page);
    const state = await notationState(page);
    L.record(results, '14. Vue classique : clef moderne sur cinq lignes', pageName,
      state.view === 'classic' && state.staffs > 0 && state.staffLines === 5 ? 'OK' : 'ÉCHEC',
      `${state.staffs} portée(s), ${state.staffLines} ligne(s) de portée`);
    L.record(results, '14. Vue classique : accord gabc [alt:Gm] rendu en <words>', pageName,
      /Gm/.test(state.text) ? 'OK' : 'ÉCHEC',
      `texte « ${state.text.trim().slice(0, 80)} »`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (clef moderne)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. Clef moderne et accord gabc', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Deux GABC dans le même dossier, le second inconvertible : le repli doit
// repartir en vue carrée pour tout le dossier, sans laisser le premier en
// classique alors que notationView vaut square.
async function runMixedFallback(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 500, height: 900 },
  });
  try {
    await L.waitReady(page);
    await page.setInputFiles('#file-input', [
      { name: 'a-kyrie.gabc', mimeType: 'text/plain', buffer: fs.readFileSync(KYRIE) },
      { name: 'b-long.gabc', mimeType: 'text/plain', buffer: fs.readFileSync(LONG) },
    ]);
    await L.waitFirstSvg(page, 120000);
    await L.waitBackgroundLoaded(page, 180000);
    await page.evaluate(() => {
      const original = window.convertScoretkToXml;
      window.convertScoretkToXml = (buffer, name, includes) =>
        /(^|\/)b-/.test(name || '')
          ? Promise.reject(new Error('second gabc inconvertible'))
          : original(buffer, name, includes);
    });
    await clickToggle(page);
    await L.waitUntil(page, () => /second gabc inconvertible/.test(
      document.getElementById('protocol-error')?.textContent || ''),
    { timeout: 120000, what: 'erreur du second gabc' });
    await waitNotationReady(page);
    const counts = await page.evaluate(() => ({
      view: window.notationView,
      classic: (window.movements || []).filter((m) => m.gabc && !m.gregorien).length,
    }));
    const firstStart = await movementStart(page,
      (m) => m.gabc && m.sourceIndex === 0 && m.gregorien && m.loaded);
    const secondStart = await movementStart(page,
      (m) => m.gabc && m.sourceIndex === 1 && m.gregorien && m.loaded);
    let first = null;
    let second = null;
    if (firstStart) {
      await L.gotoPage(page, firstStart);
      await L.waitUntil(page, () => !!document.querySelector('#page-current .scroll-page svg g.chantLine'),
        { timeout: 60000, what: 'premier gabc carré rendu' });
      first = await notationState(page);
    }
    if (secondStart) {
      await L.gotoPage(page, secondStart);
      await L.waitUntil(page, () => !!document.querySelector('#page-current .scroll-page svg g.chantLine'),
        { timeout: 60000, what: 'second gabc carré rendu' });
      second = await notationState(page);
    }
    L.record(results, '14. Repli multi-gabc : tout le dossier repart en carré', pageName,
      firstStart === 1 && secondStart != null && counts.view === 'square' &&
      counts.classic === 0 && first?.view === 'square' && first.chantLines > 0 &&
      first.staffs === 0 && second?.view === 'square' && second.chantLines > 0 &&
      second.staffs === 0 && /second gabc inconvertible/.test(second.errorText) ? 'OK' : 'ÉCHEC',
      JSON.stringify({ firstStart, secondStart, counts, first: first && {
        view: first.view, chant: first.chantLines, staffs: first.staffs },
      second: second && { view: second.view, chant: second.chantLines, staffs: second.staffs } }));
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (repli multi-gabc)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. Repli multi-gabc', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Bascules rapides : seule la dernière doit rester, sans état intermédiaire ni
// écran vide.
async function runRapid(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 360, height: 720 },
  });
  try {
    await L.waitReady(page);
    await importGabc(page, KYRIE);
    // 7 bascules depuis la vue carrée : la dernière laisse la vue classique.
    await page.evaluate(() => {
      const button = document.getElementById('notation-toggle');
      for (let i = 0; i < 7; i += 1) button.click();
    });
    await waitNotationReady(page);
    const classic = await notationState(page);
    L.record(results, '14. Bascules rapides : seule la dernière vue reste (classique)', pageName,
      classic.view === 'classic' && classic.pressed === 'false' && classic.staffs > 0 &&
      !classic.restoring ? 'OK' : 'ÉCHEC',
      `vue ${classic.view}, ${classic.staffs} portées, restauration ${classic.restoring}`);
    await clickToggle(page);
    await waitNotationReady(page);
    const square = await notationState(page);
    L.record(results, '14. Bascules rapides : retour final en carré propre', pageName,
      square.view === 'square' && square.pressed === 'true' && square.chantLines >= 2 &&
      square.movements === 1 && square.loadingHidden ? 'OK' : 'ÉCHEC',
      `vue ${square.view}, ${square.chantLines} lignes, ${square.movements} mouvement(s)`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (bascules rapides)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '14. Bascules rapides', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

(async () => {
  const { server, url } = await L.startServer();
  const browser = await L.launch();
  const results = [];
  try {
    for (const pageName of PAGES) {
      await runPage(browser, url, pageName, results);
      await runLarge(browser, url, pageName, results);
      await runRace(browser, url, pageName, results);
      await runMixed(browser, url, pageName, results);
      await runTextSizeGabc(browser, url, pageName, results);
      await runToggle(browser, url, pageName, results);
      await runGabcPlayback(browser, url, pageName, results);
      await runLongPosition(browser, url, pageName, results);
      await runMixedChoice(browser, url, pageName, results);
      await runGregorienAutre(browser, url, pageName, results);
      await runSansEntete(browser, url, pageName, results);
      await runButtonAbsent(browser, url, pageName, results);
      await runScoretkFallback(browser, url, pageName, results);
      await runScoretkAbsent(browser, url, pageName, results);
      await runModernClef(browser, url, pageName, results);
      await runMixedFallback(browser, url, pageName, results);
      await runRapid(browser, url, pageName, results);
    }
    await runOffline(browser, url, results);
  } catch (e) {
    console.log('ERREUR GÉNÉRALE', e.stack);
  }
  console.log('\n=== RÉSUMÉ S14 ===');
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  server.close();
})();
