// Scénario 14 — ouverture d'un fichier gabc en notation carrée (exsurge),
// sans scoretk ni Verovio : import direct, une ligne de chant par page,
// titre/initiale, source-index et paroles, zoom, disposition horizontale,
// réouverture depuis la bibliothèque, transport masqué, export refusé, gabc
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
const XML = path.join(__dirname, 'fixtures', 'enchainement.xml');

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

// Instrumente le worker et le cache SVG avant le premier import : le gabc ne
// doit envoyer ni loadMovement, ni registerSource, ni requête de lecture, et
// ne doit rien écrire dans svgStore.
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
    const forbidden = state.msgs.filter((type) =>
      ['loadMovement', 'registerSource', 'getPlaybackData'].includes(type));
    L.record(results, '14. Aucun chargement worker ni écriture svgStore pour le gabc', pageName,
      forbidden.length === 0 && state.sets === 0 ? 'OK' : 'ÉCHEC',
      `messages ${JSON.stringify(state.msgs)}, svgStore.set ${state.sets}`);
    L.record(results, '14. Transport masqué et exsurge chargé seulement au premier gabc', pageName,
      !exsurgeBefore && state.exsurge && state.transportHidden ? 'OK' : 'ÉCHEC',
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
      zoomed.transportHidden && zoomed.sourceIndex > 0 ? 'OK' : 'ÉCHEC',
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
    const playbackRequests = afterSettings.msgs.filter((type) =>
      ['loadMovement', 'registerSource', 'getPlaybackData'].includes(type));
    L.record(results, '14. Réglages ouverts sans requête de lecture pour le gabc', pageName,
      playbackRequests.length === 0 && afterSettings.transportHidden ? 'OK' : 'ÉCHEC',
      `messages ${JSON.stringify(afterSettings.msgs)}`);

    // E. Réouverture depuis la bibliothèque après rechargement.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page);
    await openLibraryForTest(page);
    await page.click('#library-list .library-item:nth-child(1) .library-item-info');
    await L.waitFirstSvg(page, 60000);
    await L.waitBackgroundLoaded(page, 60000);
    const reopened = await gabcState(page);
    L.record(results, '14. Réouverture depuis la bibliothèque en notation carrée', pageName,
      reopened.svgs >= 2 && reopened.sourceIndex > 0 && reopened.transportHidden &&
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
  // transport reste masqué sur la page grégorienne.
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
      L.record(results, '14. Dossier MusicXML puis gabc : le mode du MusicXML reste, transport masqué', pageName,
        state && !state.vertical && state.gabcStaff > 0 && state.transportHidden ? 'OK' : 'ÉCHEC',
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
      initial.chantLines >= 2 && initial.transportHidden ? 'OK' : 'ÉCHEC',
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
    L.record(results, '14. Bascule : Espace revient à la vue carrée, transport masqué', pageName,
      square.view === 'square' && square.pressed === 'true' && square.chantLines >= 2 &&
      square.transportHidden ? 'OK' : 'ÉCHEC',
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
    L.record(results, '14. Bascule vers classique : position conservée (dernière note ≤ repère)', pageName,
      classic.view === 'classic' && classic.staffs > 0 && target != null &&
      reference != null && target.pos <= reference &&
      classicVisible.some((note) => note.pos <= reference) &&
      classicVisible.some((note) => note.pos === target.pos) ? 'OK' : 'ÉCHEC',
      `repère ${reference}, cible ${JSON.stringify(target)}, visibles ${JSON.stringify(classicVisible.slice(0, 4))}, bascule ${switchMs} ms`);
    L.record(results, '14. Bascules : durée mesurée sur la longue fixture', pageName,
      switchMs > 0 && switchMs < 60000 ? 'OK' : 'ÉCHEC',
      `${switchMs} ms pour ${start.total} pages carrées`);

    const returnReference = classicVisible[0]?.pos;
    await clickToggle(page);
    await waitNotationReady(page);
    const back = await notationState(page);
    const backVisible = await visibleNotePositions(page, 'square', LONG_HEADER);
    const returnTarget = back.probe?.target;
    L.record(results, '14. Retour en carré : position conservée et source-index visible', pageName,
      back.view === 'square' && back.chantLines >= 1 && returnTarget != null &&
      returnReference != null && returnTarget.pos <= returnReference &&
      backVisible.some((note) => note.pos === returnTarget.pos) ? 'OK' : 'ÉCHEC',
      `repère ${returnReference}, cible ${JSON.stringify(returnTarget)}, visibles ${JSON.stringify(backVisible.slice(0, 4))}`);
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

async function runButtonAbsent(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  try {
    await L.waitReady(page);
    await L.importFile(page, XML);
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
      await runToggle(browser, url, pageName, results);
      await runLongPosition(browser, url, pageName, results);
      await runMixedChoice(browser, url, pageName, results);
      await runButtonAbsent(browser, url, pageName, results);
      await runScoretkFallback(browser, url, pageName, results);
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
