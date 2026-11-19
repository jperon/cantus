// Scénario 3 — réglages : tailles de voix (Telemann, Bach), voix masquées,
// bouton « Toutes les voix à 100 % », régénération à la fermeture,
// défilement par page / par système avec recouvrement, recul vertical après un
// saut, zoom, dossier Magnificat.
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lib');

const PAGES = ['index.html', 'spa.html'];

async function waitNewSvg(page, timeout = 120000) {
  await page.waitForFunction(() => !document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'), null, { timeout, polling: 200 });
  await page.waitForSelector('#page-current .scroll-page svg', { timeout });
  await page.waitForTimeout(800);
}

async function importLoaded(page, file, timeout = 300000) {
  await L.waitReady(page);
  await L.importFile(page, file);
  await L.waitFirstSvg(page, timeout);
  await L.waitBackgroundLoaded(page, timeout);
  await page.waitForTimeout(800);
}

async function runTelemann(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  try {
    await importLoaded(page, L.FILES.telemannXml);
    const h0 = await L.staffHeights(page);
    const st0 = await L.staffCount(page);
    await L.openSettings(page);
    const rows0 = await L.partRows(page);
    const partsHidden = await page.evaluate(() => document.getElementById('parts-group').classList.contains('hidden'));
    await L.markSvg(page);
    await page.selectOption('#parts-list select >> nth=0', '120');
    await page.waitForTimeout(2000);
    const marker = await L.markerPresent(page);
    const hDuring = await L.staffHeights(page);
    const resetEnabled = await page.evaluate(() => !document.getElementById('parts-sizes-reset').disabled);
    const sameDuring = JSON.stringify(hDuring) === JSON.stringify(h0);
    L.record(results, '3. Taille de voix : aucune régénération avant la fermeture des réglages', pageName,
      marker && sameDuring && resetEnabled ? 'OK' : 'ÉCHEC',
      `SVG marqué toujours affiché : ${marker}, hauteurs inchangées : ${sameDuring}, bouton 100 % actif : ${resetEnabled}`);
    await L.closeSettings(page);
    await waitNewSvg(page);
    const h1 = await L.staffHeights(page);
    const ratio = h0 && h1 ? h1[0] / h0[0] : 0;
    L.record(results, '3. Taille de voix 120 % appliquée à la fermeture (hauteur de portée)', pageName,
      ratio > 1.15 && ratio < 1.25 ? 'OK' : 'ÉCHEC',
      `portée 1 : ${h0[0]} → ${h1[0]} px (×${ratio.toFixed(2)}), ${rows0.length} voix`);
    await L.openSettings(page);
    const rows120 = await L.partRows(page);
    await page.click('#parts-sizes-reset');
    await page.waitForTimeout(300);
    const rowsReset = await L.partRows(page);
    await L.closeSettings(page);
    await waitNewSvg(page);
    const h2 = await L.staffHeights(page);
    const restored = h2 && h0 && h2.length === h0.length && h2.every((v, i) => Math.abs(v - h0[i]) < 1);
    L.record(results, '3. Bouton « Toutes les voix à 100 % »', pageName,
      restored && rowsReset.every((r) => r.size === '100') ? 'OK' : 'ÉCHEC',
      `tailles affichées ${rows120.map((r) => r.size).join('/')} → ${rowsReset.map((r) => r.size).join('/')}, hauteur restaurée : ${restored}`);
    // Voix masquée (P1 des deux voix de Telemann)
    await L.openSettings(page);
    await page.click('#parts-list input >> nth=0');
    await page.waitForTimeout(300);
    const rowsHidden = await L.partRows(page);
    await L.closeSettings(page);
    await waitNewSvg(page);
    const h3 = await L.staffHeights(page);
    const st3 = await L.staffCount(page);
    const hiddenOk = h3 && h0 && Math.abs(h3[0] - h0[1]) < 1;
    L.record(results, '3. Voix masquée : la première voix disparaît du rendu', pageName,
      hiddenOk ? 'OK' : 'ÉCHEC',
      `cases ${rowsHidden.map((r) => (r.checked ? 'x' : '-') + (r.disabled ? '(D)' : '')).join(' ')}, ` +
      `1re portée ${h3[0]} (2e portée d'origine ${h0[1]}), staves ${st0} → ${st3}`);
    // persistance de la voix masquée après rechargement
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page, 60000);
    await page.waitForTimeout(400);
    await L.openLibraryEntry(page, 0);
    await L.waitFirstSvg(page, 180000);
    await L.waitBackgroundLoaded(page, 180000);
    await page.waitForTimeout(1000);
    await L.openSettings(page);
    const rowsPersist = await L.partRows(page);
    await L.closeSettings(page);
    await page.waitForTimeout(500);
    const st4 = await L.staffCount(page);
    L.record(results, '3. Voix masquée conservée après réouverture', pageName,
      rowsPersist[0] && !rowsPersist[0].checked && st4 === st3 ? 'OK' : 'ÉCHEC',
      `case 1 ${rowsPersist[0] ? (rowsPersist[0].checked ? 'cochée' : 'décochée') : 'absente'}, staves ${st4} (avant ${st3})`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (réglages Telemann)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Réglages Telemann', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

async function runZoomAndScroll(browser, url, pageName, results) {
  // Zoom
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await importLoaded(page, L.FILES.telemannXml);
      // Se placer au milieu du document pour vérifier que le zoom ne perd pas la position
      for (let i = 0; i < 3; i++) { await L.pressArrow(page, 'right'); await page.waitForTimeout(800); }
      const info0 = await L.pageInfo(page);
      const rect0 = await page.$eval('#page-current .scroll-page svg', (s) => { const r = s.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
      await L.markSvg(page);
      await L.openSettings(page);
      await page.$eval('#zoom-range', (el) => {
        el.value = '60';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(300);
      const label = await page.textContent('#zoom-value');
      await L.closeSettings(page);
      await waitNewSvg(page);
      await page.waitForTimeout(1200);
      const info1 = await L.pageInfo(page);
      const rect1 = await page.$eval('#page-current .scroll-page svg', (s) => { const r = s.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
      const saved = await page.evaluate(() => localStorage.getItem('musica-settings'));
      const zoomOk = label === '60' && JSON.parse(saved).zoom === 60 && (rect1.h !== rect0.h || info1.total !== info0.total);
      L.record(results, '3. Zoom 40 → 60 : libellé, rendu et réglage conservé', pageName, zoomOk ? 'OK' : 'ÉCHEC',
        `libellé ${label}, SVG ${rect0.w}×${rect0.h} → ${rect1.w}×${rect1.h}, pages ${info0.total} → ${info1.total}, réglage ${saved}`);
      const posOk = info0.page === 1 || info1.page !== 1;
      L.record(results, '3. Zoom : la page courante n’est pas perdue', pageName,
        posOk ? 'OK' : 'ÉCHEC',
        `avant le zoom p.${info0.page}/${info0.total}, après régénération p.${info1.page}/${info1.total}`);
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (zoom)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '3. Zoom', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }
  // Défilement (Telemann est rendu en mode vertical : plusieurs systèmes par page)
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await importLoaded(page, L.FILES.telemannXml);
      // par système
      await L.openSettings(page);
      await page.click('.scroll-unit-btn[data-unit=system]');
      await L.closeSettings(page);
      await L.resetScrollTop(page);
      const s0 = await L.scrollState(page);
      await L.pressArrow(page, 'right'); await page.waitForTimeout(900);
      const s1 = await L.scrollState(page);
      const sysAligned = s1.systems.some((t) => Math.abs(t - s1.top) < 2);
      L.record(results, '3. Défilement par système : chaque pas s’aligne sur un système', pageName,
        sysAligned && s1.top > s0.top && s1.top - s0.top < s1.clientHeight ? 'OK' : 'ÉCHEC',
        `top ${s0.top} → ${s1.top} (systèmes ${s1.systems.slice(0, 5).join(',')}…, écran ${s1.clientHeight} px)`);
      await L.pressArrow(page, 'right'); await page.waitForTimeout(900);
      const s2 = await L.scrollState(page);
      const sysAligned2 = s2.systems.some((t) => Math.abs(t - s2.top) < 2);
      L.record(results, '3. Défilement par système : pas suivant', pageName,
        sysAligned2 && s2.top > s1.top ? 'OK' : 'ÉCHEC',
        `top ${s1.top} → ${s2.top}`);
      // par page, sans recouvrement
      await L.openSettings(page);
      await page.click('.scroll-unit-btn[data-unit=page]');
      await page.selectOption('#overlap-select', '0');
      await L.closeSettings(page);
      await L.resetScrollTop(page);
      const p0 = await L.scrollState(page);
      await L.pressArrow(page, 'right'); await page.waitForTimeout(900);
      const p1 = await L.scrollState(page);
      const targetPage = p1.pages.find((p) => p.top > 0 && Math.abs(p.top - p1.top) < 2);
      L.record(results, '3. Défilement par page (recouvrement 0) : saut à la page suivante', pageName,
        targetPage ? 'OK' : 'ÉCHEC',
        `top ${p0.top} → ${p1.top}, pages ${p0.pages.map((p) => p.page + '@' + p.top).join(' ')} → ${p1.pages.map((p) => p.page + '@' + p.top).join(' ')}`);
      // par page, recouvrement 30 %
      await L.openSettings(page);
      await page.selectOption('#overlap-select', '30');
      await L.closeSettings(page);
      await L.resetScrollTop(page);
      await L.pressArrow(page, 'right'); await page.waitForTimeout(900);
      const o1 = await L.scrollState(page);
      const overlapAligned = o1.systems.some((t) => Math.abs(t - o1.top) < 2);
      L.record(results, '3. Recouvrement 30 % : avance partielle alignée sur un système', pageName,
        o1.top > 0 && o1.top < o1.clientHeight && overlapAligned ? 'OK' : 'ÉCHEC',
        `top ${o1.top} (écran ${o1.clientHeight}), système aligné : ${overlapAligned}`);
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (défilement)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '3. Défilement', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }
}

// Page qui occupe le haut de la zone de défilement et sa position à l'écran.
async function visibleTopPage(page) {
  return page.evaluate(() => {
    const slot = document.getElementById('page-current');
    const base = slot.getBoundingClientRect().top;
    const at = [...slot.querySelectorAll('.scroll-page')]
      .find((d) => d.getBoundingClientRect().bottom > base + 1);
    return {
      page: at ? parseInt(at.dataset.page, 10) : null,
      top: at ? Math.round(at.getBoundingClientRect().top - base) : 0,
    };
  });
}

// Recul en mode vertical après un saut : la fenêtre rendue ne commence plus à
// la page 1. goPrev doit rendre les pages précédentes au fur et à mesure au
// lieu de s'arrêter au haut de la fenêtre, et un défilement manuel vers le
// haut doit insérer la page précédente sans déplacer le contenu visible.
async function runBackNavigation(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  try {
    await importLoaded(page, L.FILES.telemannXml);
    const start = await L.pageInfo(page);
    await page.click('.nav-btn[data-action="next-5"]');
    await page.waitForTimeout(1200);
    const jump = await L.pageInfo(page);
    const seen = [jump.page];
    for (let i = 0; i < 20 && (await L.pageInfo(page)).page > 1; i++) {
      await L.pressArrow(page, 'left');
      await page.waitForTimeout(700);
      seen.push((await L.pageInfo(page)).page);
    }
    const final = await L.pageInfo(page);
    const falling = seen.every((p, i) => i === 0 || p <= seen[i - 1]);
    const covers = Array.from({ length: jump.page - 1 }, (_, i) => jump.page - 1 - i)
      .every((p) => seen.includes(p));
    L.record(results, '3. Recul vertical après un saut : goPrev traverse les pages jusqu’à 1', pageName,
      start.page === 1 && jump.page === start.total && final.page === 1 && falling && covers ? 'OK' : 'ÉCHEC',
      `saut 1 → ${jump.page}/${start.total}, pages vues ${seen.join(' → ')}, décroissant : ${falling}, ` +
      `toutes les pages traversées : ${covers}`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (recul vertical)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Recul vertical', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Molette vers le haut juste après un saut : le haut de la fenêtre rendue est
// aussi le haut du défilement, donc aucun `scroll` ne peut signaler le geste.
// La page précédente doit être insérée sans déplacer la page affichée, et des
// gestes répétés doivent remonter jusqu'à la page 1.
async function runWheelBack(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  try {
    await importLoaded(page, L.FILES.bachXml, 300000);
    await page.click('.nav-btn[data-action="next-5"]');
    await page.waitForTimeout(1200);
    const jump = await L.pageInfo(page);
    const before = await visibleTopPage(page);
    await page.mouse.move(250, 450);
    await page.mouse.wheel(0, -100);
    await page.waitForFunction(() => {
      const first = document.querySelector('#page-current .scroll-page');
      return !!first && parseInt(first.dataset.page, 10) === 5 && !!first.querySelector('svg');
    }, null, { timeout: 30000, polling: 100 });
    await page.waitForTimeout(400);
    const after = await visibleTopPage(page);
    const still = before.page === 6 && before.top === 0 && after.page === 6 && Math.abs(after.top) < 2;
    L.record(results, '3. Molette à scrollTop 0 : page précédente rendue, page 6 immobile', pageName,
      jump.page === 6 && jump.scrollTop === 0 && still ? 'OK' : 'ÉCHEC',
      `saut 1 → ${jump.page}/${jump.total} (scrollTop ${jump.scrollTop}), haut ${before.page}@${before.top} → ` +
      `${after.page}@${after.top}, page 5 rendue`);

    // Gestes répétés : chaque approche du haut insère la page précédente.
    let wheels = 0;
    while (wheels < 80) {
      const top = await visibleTopPage(page);
      const info = await L.pageInfo(page);
      if (top.page === 1 && info.page === 1) break;
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(120);
      wheels++;
    }
    await page.waitForFunction(() => {
      const first = document.querySelector('#page-current .scroll-page');
      return !!first && parseInt(first.dataset.page, 10) === 1 && !!first.querySelector('svg');
    }, null, { timeout: 30000, polling: 100 });
    const reached = await L.pageInfo(page);
    L.record(results, '3. Molette répétée vers le haut : remontée jusqu’à la page 1', pageName,
      reached.page === 1 ? 'OK' : 'ÉCHEC',
      `${wheels} geste(s), page affichée ${reached.page}/${reached.total}, première page rendue 1`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (recul à la molette)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Recul à la molette', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

async function runBach(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  try {
    await importLoaded(page, L.FILES.bachXml, 300000);
    const h0 = await L.staffHeights(page);
    await L.markSvg(page);
    await L.openSettings(page);
    const rows = await L.partRows(page);
    await page.selectOption('#parts-list select >> nth=0', '120');
    await L.closeSettings(page);
    await waitNewSvg(page, 300000);
    await page.waitForTimeout(1500);
    const h1 = await L.staffHeights(page);
    const ratio = h0 && h1 ? h1[0] / h0[0] : 0;
    L.record(results, '3. Taille de voix sur Bach (5 voix) : hauteur de portée', pageName,
      rows.length === 5 && ratio > 1.15 && ratio < 1.25 ? 'OK' : 'ÉCHEC',
      `${rows.length} voix, portée 1 : ${h0[0]} → ${h1[0]} px (×${ratio.toFixed(2)})`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (réglages Bach)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Réglages Bach', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Signature stable d'une page affichée : nombre de portées, hauteur médiane et
// nombre de systèmes. Le SVG lui-même ne convient pas (Verovio tire des ids
// aléatoires à chaque rendu) mais cette géométrie est reproductible.
async function pageSignature(page) {
  return page.evaluate(() => [...document.querySelectorAll('#page-current .scroll-page')].map((d) => {
    const svg = d.querySelector('svg');
    const heights = svg
      ? [...svg.querySelectorAll('g.staff')].map((g) => Math.round(g.getBoundingClientRect().height * 10) / 10).sort((a, b) => a - b)
      : [];
    return {
      page: d.dataset.page,
      staves: heights.length,
      median: heights.length ? heights[Math.floor(heights.length / 2)] : 0,
      systems: svg ? svg.querySelectorAll('g.system').length : 0,
    };
  }));
}

const signatureKey = (list) => list.map((p) => `${p.page}:${p.staves}:${p.median}:${p.systems}`).join(',');

// Variantes de voix présentes dans le cache SVG persistant.
async function svgVariants(page) {
  return page.evaluate(async () => {
    const urls = await window.__svgCache.keys();
    return [...new Set(urls.map((u) => decodeURIComponent(u.split('/').slice(-1)[0])))];
  });
}

// Attend qu'une page de cette variante soit en cache : le rechargement est
// asynchrone et sa durée varie avec la charge de la machine.
async function waitVariantCached(page, variant, timeout = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ok = await page.evaluate(async (v) => {
      const urls = await window.__svgCache.keys();
      return urls.some((u) => decodeURIComponent(u.split('/').slice(-1)[0]) === v);
    }, variant);
    if (ok) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

// Ouvre une page dont le worker est ralenti : les SVG rendus avant un
// changement de tailles arrivent après, ce qui rend la course déterministe
// (elle se produit sur un appareil lent, pendant qu'on manipule les réglages).
async function newDelayedWorkerPage(browser, url, pageName) {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 900 } });
  await L.forceLanguage(ctx);
  await ctx.addInitScript(() => {
    const Native = window.Worker;
    window.__workerDelay = 0;
    window.Worker = class extends Native {
      constructor(...args) {
        super(...args);
        this.__handler = null;
        super.onmessage = (e) => {
          const data = e.data;
          setTimeout(() => this.__handler && this.__handler({ data }), window.__workerDelay || 0);
        };
      }
      set onmessage(fn) { this.__handler = fn; }
      get onmessage() { return this.__handler; }
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`${url}/${pageName}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { page, ctx, errors };
}

// Pages déjà rendues hors écran au moment d'un changement de taille : elles
// doivent être mises en cache sous la variante du XML qui les a produites, et
// jamais sous la nouvelle clé (sinon elles y restent périmées pour toujours).
async function runPartSizeCacheRace(browser, url, pageName, results) {
  const { page, ctx, errors } = await newDelayedWorkerPage(browser, url, pageName);
  try {
    await importLoaded(page, L.FILES.bachXml, 300000);
    // Les libellés de voix n'existent qu'une fois la liste des réglages remplie
    await L.openSettings(page);
    const labels = (await L.partRows(page)).map((r) => r.name);
    await L.closeSettings(page);
    const resized = labels.slice(0, 2).sort();
    const variant70 = '|' + resized.map((l) => `${l}=70`).join(',');
    const variant80 = '|' + [resized[0] + '=80', resized[1] + '=70'].join(',');
    // Le cache ne contient que la variante d'origine (aucune taille réglée)
    const variants0 = await svgVariants(page);
    L.record(results, '3. Cache SVG : une seule variante avant tout réglage', pageName,
      variants0.length === 1 && variants0[0] === '' ? 'OK' : 'ÉCHEC',
      `variantes ${JSON.stringify(variants0)}`);

    // Aller sur des pages non encore rendues, puis changer deux tailles avant
    // que leurs SVG n'arrivent (worker ralenti).
    await page.evaluate(() => { window.__workerDelay = 1500; });
    await page.click('.nav-btn[data-action="next-5"]');
    await page.waitForTimeout(200);
    await page.click('.nav-btn[data-action="next-5"]');
    await page.waitForTimeout(200);
    await L.openSettings(page);
    await page.selectOption('#parts-list select.part-size >> nth=0', '70');
    await page.selectOption('#parts-list select.part-size >> nth=1', '70');
    await page.waitForTimeout(3000); // les SVG en vol arrivent ici
    await page.evaluate(() => { window.__workerDelay = 0; });
    await L.closeSettings(page);
    await waitVariantCached(page, variant70);
    await page.waitForTimeout(3000);
    const info = await L.pageInfo(page);
    const distant = await pageSignature(page);
    const distantPage = info.page;
    const variants1 = await svgVariants(page);
    L.record(results, '3. Cache SVG : un rendu en vol n’entre pas sous la nouvelle variante', pageName,
      variants1.length === 1 && variants1[0] === variant70 ? 'OK' : 'ÉCHEC',
      `p.${distantPage}/${info.total}, variantes ${JSON.stringify(variants1)} (attendu ${JSON.stringify([variant70])}), ` +
      `${distant.length} pages rendues, signature p.${distant[0]?.page} ${JSON.stringify(distant[0])}`);

    // Quitter la partition et revenir : les pages lointaines doivent être
    // identiques à un rendu refait sans cache (sinon le cache sert une page
    // d'une autre variante).
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page, 60000);
    await page.waitForTimeout(500);
    await L.openLibraryEntry(page, 0);
    await L.waitFirstSvg(page, 300000);
    await L.waitBackgroundLoaded(page, 300000);
    await page.waitForTimeout(3000);
    const restored = await pageSignature(page);
    await page.evaluate(() => window.__svgCache.clearAll());
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page, 60000);
    await page.waitForTimeout(500);
    await L.openLibraryEntry(page, 0);
    await L.waitFirstSvg(page, 300000);
    await L.waitBackgroundLoaded(page, 300000);
    await page.waitForTimeout(3000);
    const fresh = await pageSignature(page);
    L.record(results, '3. Cache SVG : les pages lointaines servies sont un rendu valide', pageName,
      signatureKey(restored) === signatureKey(fresh) ? 'OK' : 'ÉCHEC',
      `cache ${JSON.stringify(restored.slice(0, 2))} ; rendu neuf ${JSON.stringify(fresh.slice(0, 2))} ; ` +
      `pages ${restored.length} ; ${signatureKey(restored) === signatureKey(fresh) ? 'identiques' : 'DIFFÉRENTES'}`);

    // Le rapport d'utilisateur : une seule voix repasse de 70 à 80 %.
    const sigBefore = await pageSignature(page);
    await L.openSettings(page);
    await page.selectOption('#parts-list select.part-size >> nth=0', '80');
    await L.closeSettings(page);
    await waitVariantCached(page, variant80);
    await page.waitForTimeout(3000);
    const info2 = await L.pageInfo(page);
    const sigAfter = await pageSignature(page);
    const variants2 = await svgVariants(page);
    L.record(results, '3. Taille d’une seule voix : nouveau rendu et cache purgé des anciennes variantes', pageName,
      variants2.length === 1 && variants2[0] === variant80 &&
        (info2.total !== info.total || signatureKey(sigAfter) !== signatureKey(sigBefore)) ? 'OK' : 'ÉCHEC',
      `pages ${info.total} → ${info2.total}, rendu ${signatureKey(sigBefore) === signatureKey(sigAfter) ? 'inchangé' : 'modifié'}, ` +
      `variantes ${JSON.stringify(variants2)} (attendu ${JSON.stringify([variant80])})`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (cache des tailles)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Cache SVG et tailles de voix', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Tempo de lecture : défaut tiré du fichier (Fauré : 72 noires/min dans la
// partition), réglage propre au fichier, retour au défaut sans re-rendu SVG.
async function runTempo(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  try {
    await importLoaded(page, L.FILES.faureMscz, 300000);
    await L.markSvg(page);
    await L.openSettings(page);
    // Le tempo du fichier demande les données de lecture (cache de lecture),
    // jamais un re-rendu de page.
    await page.waitForFunction(() => {
      const input = document.getElementById('tempo-input');
      return input && input.value === '72';
    }, null, { timeout: 120000, polling: 250 });
    const initial = await page.evaluate(() => ({
      value: document.getElementById('tempo-input')?.value,
      unit: document.getElementById('tempo-unit')?.textContent,
      unitTitle: document.getElementById('tempo-unit')?.title,
      hint: document.getElementById('tempo-hint')?.textContent || '',
      resetDisabled: document.getElementById('tempo-reset')?.disabled,
      stored: Object.keys(localStorage).filter((k) => k.startsWith('musica-tempo-')),
      marker: !!document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
    }));
    L.record(results, '3. Tempo : défaut du fichier affiché (Fauré = 72 à la noire)', pageName,
      initial.value === '72' && /72/.test(initial.hint) && initial.unit === '♩' &&
        initial.unitTitle === 'noire' && initial.resetDisabled === true &&
        initial.stored.length === 0 && initial.marker ? 'OK' : 'ÉCHEC',
      `champ ${initial.value}, unité « ${initial.unit} » (${initial.unitTitle}), ` +
      `indication « ${initial.hint.trim()} », bouton défaut désactivé ${initial.resetDisabled}, ` +
      `clés ${JSON.stringify(initial.stored)}, SVG marqué conservé ${initial.marker}`);

    await page.$eval('#tempo-input', (el) => {
      el.value = '144';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    const changed = await page.evaluate(() => ({
      value: document.getElementById('tempo-input')?.value,
      resetDisabled: document.getElementById('tempo-reset')?.disabled,
      stored: Object.keys(localStorage)
        .filter((k) => k.startsWith('musica-tempo-'))
        .map((k) => [k, localStorage.getItem(k)]),
      marker: !!document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
    }));
    L.record(results, '3. Tempo 144 propre au fichier, sans re-rendu SVG', pageName,
      changed.value === '144' && changed.resetDisabled === false &&
        changed.stored.length === 1 && changed.stored[0][1] === '144' && changed.marker ? 'OK' : 'ÉCHEC',
      `champ ${changed.value}, bouton défaut actif ${!changed.resetDisabled}, ` +
      `réglage ${JSON.stringify(changed.stored)}, SVG marqué conservé ${changed.marker}`);

    await L.closeSettings(page);
    await L.openSettings(page);
    const persisted = await page.evaluate(() => document.getElementById('tempo-input')?.value);
    await page.click('#tempo-reset');
    await page.waitForTimeout(300);
    const reset = await page.evaluate(() => ({
      value: document.getElementById('tempo-input')?.value,
      resetDisabled: document.getElementById('tempo-reset')?.disabled,
      stored: Object.keys(localStorage).filter((k) => k.startsWith('musica-tempo-')),
    }));
    L.record(results, '3. Tempo conservé puis « Tempo du fichier » restaure 72', pageName,
      persisted === '144' && reset.value === '72' && reset.resetDisabled === true && reset.stored.length === 0 ? 'OK' : 'ÉCHEC',
      `réouverture ${persisted}, après bouton ${reset.value}, réglages restants ${JSON.stringify(reset.stored)}`);
    await L.closeSettings(page);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (tempo)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Tempo', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Langue : anglais par défaut sans préférence (navigateur anglais), bascule
// vers le français par le réglage (textes statiques et dynamiques), préférence
// conservée au rechargement. Le contexte n'est pas forcé en français par le
// harnais : la détection par navigator.languages doit jouer.
async function runLanguage(browser, url, pageName, results) {
  const ctx = await browser.newContext({ viewport: { width: 500, height: 900 }, locale: 'en-US' });
  const { page, errors } = await L.newPage(browser, url, { pageName, context: ctx, language: null });
  try {
    await L.waitReady(page);
    const en = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.title,
      heading: document.querySelector('#import-section h1')?.textContent,
      subtitle: document.querySelector('#import-section p')?.textContent,
      settingsTitle: document.getElementById('btn-settings')?.title,
      description: document.querySelector('meta[name="description"]')?.content || '',
      navigatorLanguage: navigator.language,
      stored: localStorage.getItem('musica-language'),
    }));
    L.record(results, '3. Langue : anglais par défaut sans préférence (navigateur anglais)', pageName,
      en.lang === 'en' && en.title === 'MusicXML Reader' && en.heading === 'MusicXML Reader' &&
        en.subtitle === 'Open a MusicXML file to get started' && en.settingsTitle === 'Settings' &&
        en.stored === null && /offline MusicXML reader/.test(en.description) ? 'OK' : 'ÉCHEC',
      `navigator ${en.navigatorLanguage}, <html lang> « ${en.lang} », titre « ${en.title} », ` +
      `sous-titre « ${en.subtitle} », réglages « ${en.settingsTitle} », préférence ${en.stored}`);

    // Un fichier est nécessaire pour que le bouton Réglages soit visible.
    await L.importFile(page, L.FILES.telemannXml);
    await L.waitFirstSvg(page, 120000);
    await L.openSettings(page);
    const enSettings = await page.evaluate(() => ({
      title: document.querySelector('#settings-header h2')?.textContent,
      language: document.getElementById('language-select')?.value,
      options: Array.from(document.querySelectorAll('#language-select option')).map((o) => o.value),
      buildDate: document.getElementById('build-date')?.textContent || '',
      playAria: document.getElementById('transport-play')?.getAttribute('aria-label'),
    }));
    L.record(results, '3. Langue : réglages et textes dynamiques en anglais', pageName,
      enSettings.title === 'Settings' && enSettings.language === 'en' &&
        enSettings.options.includes('fr') && /^Version of /.test(enSettings.buildDate) &&
        enSettings.playAria === 'Play' ? 'OK' : 'ÉCHEC',
      `titre « ${enSettings.title} », langue « ${enSettings.language} » (${enSettings.options.join('/')}), ` +
      `date « ${enSettings.buildDate} », lecture « ${enSettings.playAria} »`);

    await page.selectOption('#language-select', 'fr');
    await page.waitForTimeout(200);
    const fr = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.title,
      heading: document.querySelector('#import-section h1')?.textContent,
      subtitle: document.querySelector('#import-section p')?.textContent,
      settingsTitle: document.querySelector('#settings-header h2')?.textContent,
      buildDate: document.getElementById('build-date')?.textContent || '',
      playAria: document.getElementById('transport-play')?.getAttribute('aria-label'),
      language: document.getElementById('language-select')?.value,
      stored: localStorage.getItem('musica-language'),
    }));
    L.record(results, '3. Langue : passage au français à chaud (statique, dynamique, <html lang>)', pageName,
      fr.lang === 'fr' && fr.title === 'Liseuse MusicXML' &&
        fr.heading === 'Liseuse MusicXML' && fr.subtitle === 'Ouvrir un fichier MusicXML pour commencer' &&
        fr.settingsTitle === 'Réglages' && /^Version du /.test(fr.buildDate) &&
        fr.playAria === 'Lecture' && fr.language === 'fr' && fr.stored === 'fr' ? 'OK' : 'ÉCHEC',
      `<html lang> « ${fr.lang} », titre « ${fr.title} », réglages « ${fr.settingsTitle} », ` +
      `date « ${fr.buildDate} », lecture « ${fr.playAria} », préférence « ${fr.stored} »`);

    await L.closeSettings(page);
    const tmp = path.join(os.tmpdir(), 'cantus-langue-invalide.txt');
    fs.writeFileSync(tmp, 'pas une partition');
    await page.setInputFiles('#file-input', tmp);
    fs.rmSync(tmp, { force: true });
    await page.waitForFunction(() => {
      const el = document.getElementById('protocol-error');
      return el && el.style.display === 'block' && el.textContent.includes('Aucun fichier compatible');
    }, null, { timeout: 10000, polling: 200 });
    const frError = await page.evaluate(() => ({
      message: document.getElementById('protocol-error')?.textContent,
      importTitle: document.querySelector('#import-section h1')?.textContent,
    }));
    L.record(results, '3. Langue : message d’erreur dynamique en français', pageName,
      /^Aucun fichier compatible/.test(frError.message) && frError.importTitle === 'Liseuse MusicXML' ? 'OK' : 'ÉCHEC',
      `message « ${frError.message} », titre d’import « ${frError.importTitle} »`);

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page, 60000);
    await page.waitForTimeout(300);
    const reloaded = await page.evaluate(() => ({
      lang: document.documentElement.lang,
      heading: document.querySelector('#import-section h1')?.textContent,
      stored: localStorage.getItem('musica-language'),
      language: document.getElementById('language-select')?.value,
    }));
    L.record(results, '3. Langue : préférence française conservée au rechargement', pageName,
      reloaded.lang === 'fr' && reloaded.heading === 'Liseuse MusicXML' &&
        reloaded.stored === 'fr' && reloaded.language === 'fr' ? 'OK' : 'ÉCHEC',
      `<html lang> « ${reloaded.lang} », titre « ${reloaded.heading} », ` +
      `préférence « ${reloaded.stored} », sélecteur « ${reloaded.language} »`);

    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (langue)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Langue', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

async function runFolderVoices(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  try {
    await L.waitReady(page);
    await page.setInputFiles('#folder-input', L.FILES.magnificatDir);
    await L.waitFirstSvg(page, 180000);
    await L.waitBackgroundLoaded(page, 300000);
    await page.waitForTimeout(1000);
    await L.resetScrollTop(page);
    const m1a = await L.staffCount(page);
    await page.click('.nav-btn[data-action="next-mov"]'); await page.waitForTimeout(2500);
    const m2a = await L.staffCount(page);
    const m2pos = await L.pageInfo(page);
    await page.click('.nav-btn[data-action="start"]'); await page.waitForTimeout(1500);
    await L.openSettings(page);
    const rows = await L.partRows(page);
    await page.click('#parts-list input >> nth=0');
    await page.waitForTimeout(300);
    const rowsAfter = await L.partRows(page);
    await L.closeSettings(page);
    await L.waitReady(page, 300000);
    await L.waitBackgroundLoaded(page, 300000);
    await page.waitForTimeout(1500);
    await L.resetScrollTop(page);
    const m1b = await L.staffCount(page);
    const mv = await page.click('.nav-btn[data-action="next-mov"]').then(() => page.waitForTimeout(3000)).then(() => L.pageInfo(page));
    const m2b = await L.staffCount(page);
    const semanticOk = m1b < m1a && m2b > 0;
    L.record(results, '3. Dossier Magnificat : voix masquée appliquée à tous les mouvements sans vider les autres', pageName,
      semanticOk ? 'OK' : 'ÉCHEC',
      `voix ${rows.map((r) => r.name + (r.checked ? '' : '(masquée)')).join(', ')} ; ` +
      `mouvement 1 : ${m1a} → ${m1b} staves, mouvement 2 (${m2pos.page}/${m2pos.total}) : ${m2a} → ${m2b} staves ` +
      `(après masquage, mouvement 2 à p.${mv.page}/${mv.total})`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (voix du dossier)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Voix masquée du dossier Magnificat', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

(async () => {
  const { server, url } = await L.startServer();
  const browser = await L.launch();
  const results = [];
  try {
    for (const pageName of PAGES) {
      await runTelemann(browser, url, pageName, results);
      await runZoomAndScroll(browser, url, pageName, results);
      await runBackNavigation(browser, url, pageName, results);
      await runWheelBack(browser, url, pageName, results);
      await runBach(browser, url, pageName, results);
      await runPartSizeCacheRace(browser, url, pageName, results);
      await runTempo(browser, url, pageName, results);
      await runLanguage(browser, url, pageName, results);
      await runFolderVoices(browser, url, pageName, results);
    }
  } catch (e) {
    console.log('ERREUR GÉNÉRALE', e.stack);
  }
  console.log('\n=== RÉSUMÉ S3 ===');
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  server.close();
})();
