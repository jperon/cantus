// Scénario 3 — réglages : tailles de voix (Telemann, Bach), voix masquées,
// bouton « Toutes les voix à 100 % », régénération à la fermeture,
// défilement par page / par système avec recouvrement, zoom, dossier Magnificat.
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
      await runBach(browser, url, pageName, results);
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
