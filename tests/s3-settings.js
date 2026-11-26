// Scénario 3 — réglages : tailles de voix (Telemann, Bach), voix masquées,
// bouton « Toutes les voix à 100 % », régénération à la fermeture,
// défilement par page / par système avec recouvrement, recul vertical après un
// saut, zoom, dossier Magnificat.
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./lib');

const PAGES = ['index.html', 'spa.html'];
try { fs.mkdirSync('/tmp/cantus-voix', { recursive: true }); } catch { /* captures facultatives */ }

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

// Déplie les réglages fins (taille, instrument) d'une voix.
async function expandPart(page, index = 0) {
  await page.click(`#parts-list .part-expand >> nth=${index}`);
  await page.waitForTimeout(100);
}

// Ouvre les réglages sur un écran étroit par le menu ⋯ de la barre du bas
// (le bouton ⚙ n'existe plus).
async function openSettingsNarrow(page) {
  await page.click('#btn-menu');
  await page.waitForSelector('#command-menu:not(.hidden)', { timeout: 10000 });
  await page.click('#menu-settings');
  await page.waitForFunction(
    () => !document.getElementById('settings-overlay').classList.contains('hidden'),
    null, { timeout: 10000 }
  );
}

// Déplace le curseur « Taille du texte » comme un glissement utilisateur
// (libellé en direct, puis enregistrement et rechargement).
async function setTextSize(page, value) {
  await page.$eval('#text-size-range', (el, v) => {
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

// Mesures du premier SVG MusicXML affiché : taille d'une syllabe chantée et
// hauteur de portée (écart entre la première et la dernière ligne de portée,
// sans les paroles).
async function musicXmlTextMetrics(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('#page-current .scroll-page svg');
    if (!svg) return null;
    const lyric = [...svg.querySelectorAll('g.verse g.syl text, g.verse text')]
      .find((el) => /\S/.test(el.textContent));
    const sized = lyric?.querySelector('tspan[font-size]') || lyric;
    const staff = svg.querySelector('g.staff');
    const lineTops = [];
    if (staff) {
      for (const path of staff.children) {
        if (path.tagName.toLowerCase() !== 'path' || !path.getAttribute('stroke')) continue;
        const r = path.getBoundingClientRect();
        lineTops.push(r.top, r.bottom);
      }
    }
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 };
    };
    return {
      text: lyric?.textContent.trim() || '',
      lyric: lyric ? rect(lyric) : null,
      sizedFont: sized ? parseFloat(getComputedStyle(sized).fontSize) || 0 : 0,
      staffHeight: lineTops.length >= 2
        ? Math.round((Math.max(...lineTops) - Math.min(...lineTops)) * 100) / 100 : 0,
      page: svg.closest('.scroll-page')?.dataset.page || null,
    };
  });
}

// Position des deux réglages courts (Zoom et Taille du texte) : côte à côte
// ou empilés selon la largeur.
async function settingsPairLayout(page) {
  return page.evaluate(() => {
    const zoom = document.getElementById('zoom-range').closest('.settings-group');
    const text = document.getElementById('text-size-range').closest('.settings-group');
    const overlay = document.getElementById('settings-overlay');
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top),
        bottom: Math.round(r.bottom), width: Math.round(r.width) };
    };
    return {
      zoom: box(zoom),
      text: box(text),
      viewport: window.innerWidth,
      overlayOverflow: overlay.scrollWidth - overlay.clientWidth,
      contentOverflow: Math.max(zoom.scrollWidth - zoom.clientWidth, text.scrollWidth - text.clientWidth),
    };
  });
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
    const bulkDefaults = await page.evaluate(() => {
      const sizes = document.getElementById('parts-sizes-reset');
      const volumes = document.getElementById('parts-volumes-reset');
      return {
        sizes: sizes?.value,
        volumes: volumes?.value,
        sizesLabel: sizes?.closest('label')?.textContent || '',
        volumesLabel: volumes?.closest('label')?.textContent || '',
        sizesAria: sizes?.getAttribute('aria-label') || '',
        volumesAria: volumes?.getAttribute('aria-label') || '',
      };
    });
    const defaultsOk = !partsHidden && bulkDefaults.sizes === '100' && bulkDefaults.volumes === '70' &&
      rows0.length >= 2 && rows0.every((r) => r.size === '100' && r.volume === '70') &&
      /Tailles à/.test(bulkDefaults.sizesLabel) && /Volumes à/.test(bulkDefaults.volumesLabel) &&
      /taille/i.test(bulkDefaults.sizesAria) && /volume/i.test(bulkDefaults.volumesAria);
    L.record(results, '3. Voix : menus « Tailles à » et « Volumes à » à la valeur commune par défaut', pageName,
      defaultsOk ? 'OK' : 'ÉCHEC',
      `${rows0.length} voix (tailles ${[...new Set(rows0.map((r) => r.size))].join('/')}, ` +
      `volumes ${[...new Set(rows0.map((r) => r.volume))].join('/')}), menus ${bulkDefaults.sizes || '—'}/${bulkDefaults.volumes || '—'}, ` +
      `libellés « ${bulkDefaults.sizesLabel.trim()} » / « ${bulkDefaults.volumesLabel.trim()} », ` +
      `aria « ${bulkDefaults.sizesAria} » / « ${bulkDefaults.volumesAria} »`);

    // Volume de toutes les voix : appliqué immédiatement au moteur, sans
    // re-rendu, et les curseurs des lignes suivent.
    await L.markSvg(page);
    await page.selectOption('#parts-volumes-reset', '80');
    await page.waitForTimeout(400);
    const rowsVolume80 = await L.partRows(page);
    const volumeAfter = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith('musica-hidden-parts-'));
      return {
        marker: !!document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
        volume: document.getElementById('parts-volumes-reset')?.value,
        saved: key ? JSON.parse(localStorage.getItem(key))?.volumes : null,
      };
    });
    const volume80Ok = rowsVolume80.every((r) => r.volume === '80') && volumeAfter.volume === '80' &&
      volumeAfter.marker && Object.keys(volumeAfter.saved || {}).length === rowsVolume80.length &&
      Object.values(volumeAfter.saved || {}).every((v) => v === 80);
    L.record(results, '3. Menu « Volumes à » : 80 % appliqué à toutes les voix, sans re-rendu', pageName,
      volume80Ok ? 'OK' : 'ÉCHEC',
      `curseurs ${rowsVolume80.map((r) => r.volume).join('/')}, menu ${volumeAfter.volume}, ` +
      `SVG marqué conservé : ${volumeAfter.marker}, volumes ${JSON.stringify(volumeAfter.saved)}`);
    await page.selectOption('#parts-volumes-reset', '70');
    await page.waitForTimeout(400);
    const rowsVolume70 = await L.partRows(page);
    const volumeReset = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => k.startsWith('musica-hidden-parts-'));
      return {
        marker: !!document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
        volume: document.getElementById('parts-volumes-reset')?.value,
        saved: key ? JSON.parse(localStorage.getItem(key))?.volumes : null,
      };
    });
    L.record(results, '3. Menu « Volumes à » : retour à 70 %, sans re-rendu', pageName,
      rowsVolume70.every((r) => r.volume === '70') && volumeReset.volume === '70' &&
        volumeReset.marker && Object.keys(volumeReset.saved || {}).length === 0 ? 'OK' : 'ÉCHEC',
      `curseurs ${rowsVolume70.map((r) => r.volume).join('/')}, menu ${volumeReset.volume}, ` +
      `SVG marqué conservé : ${volumeReset.marker}, volumes ${JSON.stringify(volumeReset.saved)}`);

    // Taille d'une seule voix : le menu « Tailles à » passe à « — » (valeurs
    // divergentes), aucune régénération avant la fermeture.
    await expandPart(page, 0);
    await page.selectOption('#parts-list select.part-size >> nth=0', '120');
    await page.waitForTimeout(2000);
    const marker = await L.markerPresent(page);
    const hDuring = await L.staffHeights(page);
    const mixedSizes = await page.evaluate(() => document.getElementById('parts-sizes-reset').value);
    const sameDuring = JSON.stringify(hDuring) === JSON.stringify(h0);
    L.record(results, '3. Taille de voix : aucune régénération avant la fermeture, menu « — »', pageName,
      marker && sameDuring && mixedSizes === '' ? 'OK' : 'ÉCHEC',
      `SVG marqué toujours affiché : ${marker}, hauteurs inchangées : ${sameDuring}, menu tailles « ${mixedSizes} »`);
    await L.closeSettings(page);
    await waitNewSvg(page);
    const h1 = await L.staffHeights(page);
    const ratio = h0 && h1 ? h1[0] / h0[0] : 0;
    L.record(results, '3. Taille de voix 120 % appliquée à la fermeture (hauteur de portée)', pageName,
      ratio > 1.15 && ratio < 1.25 ? 'OK' : 'ÉCHEC',
      `portée 1 : ${h0[0]} → ${h1[0]} px (×${ratio.toFixed(2)}), ${rows0.length} voix`);
    await L.openSettings(page);
    const rows120 = await L.partRows(page);
    // Menu « Tailles à » : 80 % s'applique à toutes les voix.
    await page.selectOption('#parts-sizes-reset', '80');
    await page.waitForTimeout(300);
    const rows80 = await L.partRows(page);
    const bulkSize80 = await page.evaluate(() => document.getElementById('parts-sizes-reset').value);
    await L.closeSettings(page);
    await waitNewSvg(page);
    const h80 = await L.staffHeights(page);
    const ratio80 = h0 && h80 ? h80[0] / h0[0] : 0;
    L.record(results, '3. Menu « Tailles à » : 80 % appliqué à toutes les voix', pageName,
      rows80.length === rows0.length && rows80.every((r) => r.size === '80') && bulkSize80 === '80' &&
        ratio80 > 0.75 && ratio80 < 0.85 ? 'OK' : 'ÉCHEC',
      `tailles ${rows120.map((r) => r.size).join('/')} → ${rows80.map((r) => r.size).join('/')}, menu « ${bulkSize80} », ` +
      `portée 1 : ${h0[0]} → ${h80[0]} px (×${ratio80.toFixed(2)})`);
    // Menu « Tailles à » : retour à 100 % pour toutes les voix.
    await L.openSettings(page);
    await page.selectOption('#parts-sizes-reset', '100');
    await page.waitForTimeout(300);
    const rowsReset = await L.partRows(page);
    await L.closeSettings(page);
    await waitNewSvg(page);
    const h2 = await L.staffHeights(page);
    const restored = h2 && h0 && h2.length === h0.length && h2.every((v, i) => Math.abs(v - h0[i]) < 1);
    L.record(results, '3. Menu « Tailles à » : 100 % restaure toutes les voix', pageName,
      restored && rowsReset.every((r) => r.size === '100') ? 'OK' : 'ÉCHEC',
      `tailles affichées ${rows80.map((r) => r.size).join('/')} → ${rowsReset.map((r) => r.size).join('/')}, hauteur restaurée : ${restored}`);
    // Voix masquée (P1 des deux voix de Telemann)
    await L.openSettings(page);
    await page.click('#parts-list .part-display >> nth=0');
    await page.waitForTimeout(300);
    const rowsHidden = await L.partRows(page);
    await L.closeSettings(page);
    await waitNewSvg(page);
    const h3 = await L.staffHeights(page);
    const st3 = await L.staffCount(page);
    const hiddenOk = h3 && h0 && Math.abs(h3[0] - h0[1]) < 1;
    L.record(results, '3. Voix masquée : la première voix disparaît du rendu', pageName,
      hiddenOk ? 'OK' : 'ÉCHEC',
      `affichage ${rowsHidden.map((r) => (r.displayed ? 'x' : '-') + (r.displayDisabled ? '(D)' : '')).join(' ')}, ` +
      `lecture ${rowsHidden.map((r) => (r.played ? 'x' : '-')).join(' ')}, ` +
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
      rowsPersist[0] && !rowsPersist[0].displayed && st4 === st3 ? 'OK' : 'ÉCHEC',
      `affichage voix 1 ${rowsPersist[0] ? (rowsPersist[0].displayed ? 'actif' : 'masqué') : 'absent'}, staves ${st4} (avant ${st3})`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (réglages Telemann)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Réglages Telemann', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Réglage global « Taille du texte » : défaut et persistance, rendu MusicXML
// (paroles agrandies, portée inchangée, cache), puis disposition à deux
// colonnes avec le Zoom.
async function runTextSize(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  try {
    await importLoaded(page, L.FILES.telemannXml, 60000);
    await L.openSettings(page);
    const initial = await page.evaluate(() => {
      const range = document.getElementById('text-size-range');
      const group = range?.closest('.settings-group');
      const saved = JSON.parse(localStorage.getItem('musica-settings') || '{}');
      return {
        label: group?.querySelector('.settings-label')?.textContent?.trim() || '',
        value: document.getElementById('text-size-value')?.textContent?.trim() || '',
        range: range?.value,
        min: range?.min,
        max: range?.max,
        step: range?.step,
        aria: range?.getAttribute('aria-label') || '',
        stored: saved.textSize,
        previousLabel: group?.previousElementSibling?.querySelector('.settings-label')?.textContent?.trim() || '',
      };
    });
    const defaultsOk = initial.label === 'Taille du texte' && initial.value === '100 %' &&
      initial.range === '100' && initial.min === '50' && initial.max === '175' &&
      initial.step === '5' && /texte chanté/i.test(initial.aria) &&
      initial.stored === undefined && initial.previousLabel === 'Zoom';
    L.record(results, '3. Taille du texte : défaut 100 %, libellé et bornes du curseur', pageName,
      defaultsOk ? 'OK' : 'ÉCHEC',
      `libellé « ${initial.label} », valeur « ${initial.value} », curseur ${initial.range} ` +
      `[${initial.min}–${initial.max}, pas ${initial.step}], aria « ${initial.aria} », ` +
      `enregistré ${initial.stored}, groupe précédent « ${initial.previousLabel} »`);

    await setTextSize(page, 150);
    await page.waitForTimeout(300);
    const changed = await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('musica-settings') || '{}');
      return {
        range: document.getElementById('text-size-range')?.value,
        value: document.getElementById('text-size-value')?.textContent?.trim(),
        stored: saved.textSize,
      };
    });
    L.record(results, '3. Taille du texte : 150 % appliqué et enregistré', pageName,
      changed.range === '150' && changed.value === '150 %' && changed.stored === 150 ? 'OK' : 'ÉCHEC',
      `curseur ${changed.range}, libellé « ${changed.value} », réglage ${changed.stored}`);

    // Rechargement complet : la valeur revient de localStorage avant tout
    // rendu. Un fichier est rouvert pour que le bouton Réglages soit visible.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page, 60000);
    await page.waitForTimeout(500);
    await L.openLibraryEntry(page, 0);
    await L.waitFirstSvg(page, 60000);
    await L.waitBackgroundLoaded(page, 60000);
    await L.openSettings(page);
    const restored = await page.evaluate(() => ({
      range: document.getElementById('text-size-range')?.value,
      value: document.getElementById('text-size-value')?.textContent?.trim(),
    }));
    L.record(results, '3. Taille du texte : valeur restaurée après rechargement de la page', pageName,
      restored.range === '150' && restored.value === '150 %' ? 'OK' : 'ÉCHEC',
      `curseur ${restored.range}, libellé « ${restored.value} » (attendu 150 / « 150 % »)`);

    await setTextSize(page, 100);
    await page.waitForTimeout(300);
    await L.closeSettings(page);

    // MusicXML avec paroles : agrandir le texte ne touche pas la portée.
    await importLoaded(page, L.FILES.parolesXml, 60000);
    const m100 = await musicXmlTextMetrics(page);
    if (!m100?.lyric || !m100.staffHeight) {
      throw new Error('paroles ou lignes de portée introuvables dans le SVG MusicXML');
    }

    await L.markSvg(page);
    await setTextSize(page, 150);
    await waitNewSvg(page, 60000);
    await L.waitBackgroundLoaded(page, 60000);
    await page.waitForTimeout(800);
    const m150 = await musicXmlTextMetrics(page);
    if (!m150?.lyric) throw new Error('paroles introuvables après passage à 150 %');
    const growth = m150.lyric.h / m100.lyric.h;
    const staffSame = Math.abs(m150.staffHeight - m100.staffHeight) <= 2;
    const grewOk = growth >= 1.35 && growth <= 1.65 && staffSame;
    L.record(results, '3. Taille du texte 150 % : paroles agrandies, hauteur de portée inchangée', pageName,
      grewOk ? 'OK' : 'ÉCHEC',
      `syllabe « ${m100.text} » ${m100.lyric.h} → ${m150.lyric.h} px (×${growth.toFixed(2)}), ` +
      `police ${m100.sizedFont} → ${m150.sizedFont} px, portée ${m100.staffHeight} → ${m150.staffHeight} px`);

    // Retour à 100 % : le cache doit servir le rendu de 100 %, pas celui de
    // 150 % resté sous la même clé.
    await L.markSvg(page);
    await setTextSize(page, 100);
    await waitNewSvg(page, 60000);
    await L.waitBackgroundLoaded(page, 60000);
    await page.waitForTimeout(800);
    const back = await musicXmlTextMetrics(page);
    const backOk = !!back?.lyric &&
      Math.abs(back.lyric.h - m100.lyric.h) <= 0.6 &&
      Math.abs(back.staffHeight - m100.staffHeight) <= 2;
    L.record(results, '3. Taille du texte : retour à 100 %, rendu initial servi par le cache', pageName,
      backOk ? 'OK' : 'ÉCHEC',
      `syllabe ${back?.lyric?.h} px (initial ${m100.lyric.h}), portée ${back?.staffHeight} px ` +
      `(initial ${m100.staffHeight}), police ${back?.sizedFont} (initial ${m100.sizedFont})`);

    // Zoom : la taille du texte suit la portée, leur rapport reste constant.
    await setTextSize(page, 150);
    await waitNewSvg(page, 60000);
    await L.waitBackgroundLoaded(page, 60000);
    const m150b = await musicXmlTextMetrics(page);
    await L.openSettings(page);
    await page.$eval('#zoom-range', (el) => {
      el.value = '60';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await L.closeSettings(page);
    await waitNewSvg(page, 60000);
    await L.waitBackgroundLoaded(page, 60000);
    await page.waitForTimeout(800);
    const m150z = await musicXmlTextMetrics(page);
    const ratioBefore = m150b.lyric.h / m150b.staffHeight;
    const ratioAfter = m150z.lyric.h / m150z.staffHeight;
    const ratioOk = Math.abs(ratioAfter / ratioBefore - 1) <= 0.12;
    const zoomMoved = Math.abs(m150z.staffHeight - m150b.staffHeight) > 1;
    L.record(results, '3. Taille du texte et zoom : rapport paroles / portée constant', pageName,
      ratioOk && zoomMoved ? 'OK' : 'ÉCHEC',
      `portée ${m150b.staffHeight} → ${m150z.staffHeight} px, syllabe ${m150b.lyric.h} → ${m150z.lyric.h} px, ` +
      `rapport ${ratioBefore.toFixed(3)} → ${ratioAfter.toFixed(3)}`);

    // Disposition : côte à côte sur un écran large, empilés sinon.
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForTimeout(600);
    await L.openSettings(page);
    const wide = await settingsPairLayout(page);
    const wideOk = Math.abs(wide.zoom.top - wide.text.top) <= 2 &&
      Math.abs(wide.zoom.width - wide.text.width) <= 2 &&
      (wide.zoom.right <= wide.text.left + 1 || wide.text.right <= wide.zoom.left + 1);
    L.record(results, '3. Taille du texte à 1200 px : à côté du Zoom, deux colonnes égales', pageName,
      wideOk ? 'OK' : 'ÉCHEC',
      `zoom ${JSON.stringify(wide.zoom)}, texte ${JSON.stringify(wide.text)}`);

    await page.setViewportSize({ width: 360, height: 720 });
    await page.waitForTimeout(600);
    const narrow = await settingsPairLayout(page);
    const narrowOk = narrow.text.top >= narrow.zoom.bottom - 1 &&
      narrow.zoom.left >= 0 && narrow.zoom.right <= 361 &&
      narrow.text.left >= 0 && narrow.text.right <= 361 &&
      narrow.overlayOverflow <= 0 && narrow.contentOverflow <= 0;
    L.record(results, '3. Taille du texte à 360 px : sous le Zoom, sans débordement', pageName,
      narrowOk ? 'OK' : 'ÉCHEC',
      `zoom ${JSON.stringify(narrow.zoom)}, texte ${JSON.stringify(narrow.text)}, ` +
      `débordement recouvrement ${narrow.overlayOverflow} px / contenu ${narrow.contentOverflow} px`);
    await L.closeSettings(page);

    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (taille du texte)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Taille du texte', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
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
      for (let i = 0; i < 3; i++) { await L.pageStep(page, 'right'); await page.waitForTimeout(800); }
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
      const zoomOk = label === '60 %' && JSON.parse(saved).zoom === 60 && (rect1.h !== rect0.h || info1.total !== info0.total);
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
      await L.pageStep(page, 'right'); await page.waitForTimeout(900);
      const s1 = await L.scrollState(page);
      const sysAligned = s1.systems.some((t) => Math.abs(t - s1.top) < 2);
      L.record(results, '3. Défilement par système : chaque pas s’aligne sur un système', pageName,
        sysAligned && s1.top > s0.top && s1.top - s0.top < s1.clientHeight ? 'OK' : 'ÉCHEC',
        `top ${s0.top} → ${s1.top} (systèmes ${s1.systems.slice(0, 5).join(',')}…, écran ${s1.clientHeight} px)`);
      await L.pageStep(page, 'right'); await page.waitForTimeout(900);
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
      await L.pageStep(page, 'right'); await page.waitForTimeout(900);
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
      await L.pageStep(page, 'right'); await page.waitForTimeout(900);
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
    await L.gotoPage(page, start.total);
    await page.waitForTimeout(1200);
    const jump = await L.pageInfo(page);
    const seen = [jump.page];
    for (let i = 0; i < 20 && (await L.pageInfo(page)).page > 1; i++) {
      await L.pageStep(page, 'left');
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
    await L.gotoPage(page, 6);
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
    await expandPart(page, 0);
    await page.selectOption('#parts-list select.part-size >> nth=0', '120');
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
    await L.gotoPage(page, 6);
    await page.waitForTimeout(200);
    await L.gotoPage(page, 11);
    await page.waitForTimeout(200);
    await L.openSettings(page);
    await expandPart(page, 0);
    await expandPart(page, 1);
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
    await expandPart(page, 0);
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

// Instruments : choix par voix (programme GM, mémorisé par fichier) et option
// globale « Piano seulement » (réglage `musica-settings`). Le programme
// effectif est lu sur le canal de la voix par le diagnostic du moteur.
async function runInstruments(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  const readVoice = (label) => page.evaluate((name) => {
    const sel = document.querySelector('#parts-list select.part-program');
    const row = sel?.closest('.part-row');
    const voice = name || row?.querySelector('.part-name')?.textContent?.trim();
    const entry = window.__musicaAudio.getChannelAssignments()
      .find((a) => a.label === voice) || null;
    return {
      label: voice,
      value: sel?.value,
      firstOption: sel?.options?.[0]?.textContent || '',
      optgroups: sel ? sel.querySelectorAll('optgroup').length : 0,
      disabled: !!(sel && sel.disabled),
      program: entry ? entry.program : null,
      channel: entry ? entry.channel : null,
    };
  }, label);
  const startAndPause = async () => {
    await page.click('#transport-play');
    await page.waitForFunction(() => {
      const state = window.__musicaPlaybackState?.();
      return state?.state === 'playing' && window.__musicaAudio.getChannelAssignments().length > 0;
    }, null, { timeout: 180000, polling: 100 });
    await page.click('#transport-play');
    await page.waitForFunction(() => window.__musicaPlaybackState?.().state === 'paused',
      null, { timeout: 10000, polling: 100 });
  };
  try {
    await importLoaded(page, L.FILES.telemannXml);
    await startAndPause();
    await L.openSettings(page);
    await expandPart(page, 0);
    const before = await readVoice();
    await page.selectOption('#parts-list select.part-program >> nth=0', '52');
    await page.waitForTimeout(300);
    const chosen = await readVoice(before.label);
    const uiOk = before.optgroups === 16 && /^Partition \(/.test(before.firstOption);
    L.record(results, '3. Instrument d’une voix : « Choir Aahs » (programme 52) appliqué au moteur', pageName,
      uiOk && chosen.value === '52' && chosen.program === 52 ? 'OK' : 'ÉCHEC',
      `voix « ${before.label} », ${before.optgroups} familles, première option « ${before.firstOption} » ; ` +
      `choix ${chosen.value}, programme effectif ${chosen.program} (canal ${chosen.channel})`);

    await page.check('#piano-only');
    await page.waitForTimeout(300);
    const piano = await readVoice(before.label);
    L.record(results, '3. Piano seulement : programme 0 sans effacer le choix par voix', pageName,
      piano.program === 0 && piano.value === '52' && piano.disabled ? 'OK' : 'ÉCHEC',
      `programme effectif ${piano.program}, choix conservé ${piano.value}, sélecteur désactivé ${piano.disabled}`);

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page, 60000);
    await page.waitForTimeout(400);
    await L.openLibraryEntry(page, 0);
    await L.waitFirstSvg(page, 180000);
    await L.waitBackgroundLoaded(page, 180000);
    await page.waitForTimeout(1000);
    await startAndPause();
    await L.openSettings(page);
    const persisted = await readVoice(before.label);
    const checked = await page.isChecked('#piano-only');
    L.record(results, '3. Instrument et piano seulement conservés après rechargement', pageName,
      checked && persisted.value === '52' && persisted.program === 0 && persisted.disabled ? 'OK' : 'ÉCHEC',
      `piano seulement coché ${checked}, choix ${persisted.value}, programme effectif ${persisted.program}, ` +
      `sélecteur désactivé ${persisted.disabled}`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (instruments)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Instruments par voix', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Transpositions visuelle et auditive : deux réglages propres au fichier,
// persistants, sélectionnables au doigt. La visuelle transpose le rendu et sa
// variante de cache ; l'auditive reste purement audio (aucun re-rendu).
// Ordonnée Verovio de la première tête de note affichée : Verovio place
// chaque tête par des attributs x/y sur <use>.
function firstNoteheadY(page) {
  return page.evaluate(() => {
    const use = document.querySelector('#page-current .scroll-page svg g.notehead use');
    if (!use) return null;
    const y = use.getAttribute('y');
    return y == null || y === '' ? null : Number(y);
  });
}

async function runTransposition(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 390, height: 844 },
  });
  try {
    await importLoaded(page, L.FILES.telemannXml);
    const noteYBefore = await firstNoteheadY(page);
    await L.markSvg(page);
    await openSettingsNarrow(page);
    const initial = await page.evaluate(() => {
      const visual = document.getElementById('transpose-visual');
      const audio = document.getElementById('transpose-audio');
      const vr = visual?.getBoundingClientRect();
      const ar = audio?.getBoundingClientRect();
      const label = (value) => [...(visual?.options || [])].find((o) => o.value === value)?.textContent;
      const sectionOf = (el) => el?.closest('section')?.querySelector('.settings-section-title')?.textContent.trim();
      const groupLabel = (el) => el?.closest('.settings-group')?.querySelector('.settings-label')?.textContent.trim();
      return {
        exists: !!visual && !!audio,
        values: [visual?.value, audio?.value],
        optionCount: visual?.options.length || 0,
        labels: [label('-3'), label('0'), label('2')],
        heights: [Math.round(vr?.height || 0), Math.round(ar?.height || 0)],
        aria: [visual?.getAttribute('aria-label'), audio?.getAttribute('aria-label')],
        sections: [sectionOf(visual), sectionOf(audio)],
        groups: [groupLabel(visual), groupLabel(audio)],
        marker: !!document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
      };
    });
    L.record(results, '3. Transposition : partition et son dans leurs sections, à 0, cibles ≥ 44 px', pageName,
      initial.exists && initial.values.join('/') === '0/0' && initial.optionCount === 25 &&
        initial.labels.join(' ') === '−3 0 +2' && initial.heights.every((h) => h >= 44) &&
        initial.sections.join('|') === 'Affichage|Lecture' &&
        initial.groups.join('|') === 'Transposition de la partition|Transposition du son' &&
        initial.aria[0] === 'Transposition de la partition en demi-tons' &&
        initial.aria[1] === 'Transposition du son en demi-tons' && initial.marker ? 'OK' : 'ÉCHEC',
      `valeurs ${initial.values.join('/')}, ${initial.optionCount} options (${initial.labels.join(' ')}), ` +
      `sections ${initial.sections.join('/')}, libellés de groupe « ${initial.groups.join(' » / « ')} », ` +
      `hauteurs ${initial.heights.join('/')} px, aria « ${initial.aria.join(' » / « ')} »`);

    // Changement sans re-rendu avant la fermeture : la visuelle attend la
    // fermeture, l'auditive ne provoque jamais de rendu.
    await page.selectOption('#transpose-visual', '2');
    await page.selectOption('#transpose-audio', '-3');
    await page.waitForTimeout(400);
    const chosen = await page.evaluate(() => ({
      marker: !!document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
      stored: Object.keys(localStorage)
        .filter((k) => k.startsWith('musica-transpose-'))
        .reduce((all, k) => {
          all[k.includes('-visual-') ? 'visual' : 'audio'] = localStorage.getItem(k);
          return all;
        }, {}),
      engine: window.__musicaAudio.getTranspose(),
    }));
    L.record(results, '3. Transpositions choisies : aucun re-rendu avant la fermeture', pageName,
      chosen.marker && chosen.engine === -3 && chosen.stored.visual === '2' &&
        chosen.stored.audio === '-3' ? 'OK' : 'ÉCHEC',
      `SVG marqué conservé ${chosen.marker}, moteur ${chosen.engine} demi-tons, réglages ${JSON.stringify(chosen.stored)}`);

    await L.closeSettings(page);
    await waitNewSvg(page);
    const noteYAfter = await firstNoteheadY(page);
    // +2 demi-tons = une seconde majeure : la première note monte d'un degré,
    // soit −90 unités Verovio (un demi-interligne à cette échelle).
    const shifted = noteYBefore != null && noteYAfter != null &&
      Math.abs(noteYAfter - (noteYBefore - 90)) <= 1;
    L.record(results, '3. Transposition visuelle +2 : rendu transposé à la fermeture', pageName,
      shifted ? 'OK' : 'ÉCHEC',
      `première tête de note y ${noteYBefore} → ${noteYAfter} (attendu ${noteYBefore != null ? noteYBefore - 90 : '?'})`);

    const cached = await waitVariantCached(page, '|t2');
    await page.waitForTimeout(3000);
    const variants = await svgVariants(page);
    L.record(results, '3. Cache SVG : la transposition visuelle entre dans la variante', pageName,
      cached && variants.length === 1 && variants[0] === '|t2' ? 'OK' : 'ÉCHEC',
      `variantes ${JSON.stringify(variants)} (attendu ${JSON.stringify(['|t2'])})`);

    await L.openSettings(page);
    const reopened = await page.evaluate(() => ({
      values: [document.getElementById('transpose-visual')?.value, document.getElementById('transpose-audio')?.value],
    }));
    await L.closeSettings(page);
    L.record(results, '3. Transpositions conservées à la réouverture des réglages', pageName,
      reopened.values.join('/') === '2/-3' ? 'OK' : 'ÉCHEC', `valeurs ${reopened.values.join('/')}`);

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page);
    await page.waitForTimeout(400);
    await L.openLibraryEntry(page, 0);
    await L.waitFirstSvg(page);
    await L.waitBackgroundLoaded(page);
    await page.waitForTimeout(600);
    await L.openSettings(page);
    const reloaded = await page.evaluate(() => ({
      values: [document.getElementById('transpose-visual')?.value, document.getElementById('transpose-audio')?.value],
      stored: Object.keys(localStorage)
        .filter((k) => k.startsWith('musica-transpose-'))
        .reduce((all, k) => {
          all[k.includes('-visual-') ? 'visual' : 'audio'] = localStorage.getItem(k);
          return all;
        }, {}),
      engine: window.__musicaAudio.getTranspose(),
    }));
    L.record(results, '3. Transpositions conservées après rechargement', pageName,
      reloaded.values.join('/') === '2/-3' && reloaded.stored.visual === '2' &&
        reloaded.stored.audio === '-3' ? 'OK' : 'ÉCHEC',
      `sélecteurs ${reloaded.values.join('/')}, réglages ${JSON.stringify(reloaded.stored)}, ` +
      `moteur ${reloaded.engine} demi-tons`);

    // Retour aux deux valeurs neutres : les clés disparaissent.
    await page.selectOption('#transpose-visual', '0');
    await page.selectOption('#transpose-audio', '0');
    await page.waitForTimeout(200);
    const neutral = await page.evaluate(() => ({
      stored: Object.keys(localStorage).filter((k) => k.startsWith('musica-transpose-')),
      engine: window.__musicaAudio.getTranspose(),
    }));
    L.record(results, '3. Transposition 0 : neutre, aucune clé conservée', pageName,
      neutral.stored.length === 0 && neutral.engine === 0 ? 'OK' : 'ÉCHEC',
      `clés ${JSON.stringify(neutral.stored)}, moteur ${neutral.engine} demi-tons`);
    await L.closeSettings(page);
    await waitNewSvg(page);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (transpositions)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Transpositions', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
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
      tagline: document.querySelector('#import-tagline')?.textContent,
      menuSettings: document.getElementById('menu-settings')?.textContent?.trim(),
      description: document.querySelector('meta[name="description"]')?.content || '',
      navigatorLanguage: navigator.language,
      stored: localStorage.getItem('musica-language'),
    }));
    L.record(results, '3. Langue : anglais par défaut sans préférence (navigateur anglais)', pageName,
      en.lang === 'en' && en.title === 'MusicXML Reader' && en.heading === 'Cantus' &&
        en.tagline === 'Open scores in MusicXML, MEI, MuseScore, LilyPond, ABC, MIDI, and GABC.' &&
        en.menuSettings === 'Settings' &&
        en.stored === null && /offline MusicXML reader/.test(en.description) ? 'OK' : 'ÉCHEC',
      `navigator ${en.navigatorLanguage}, <html lang> « ${en.lang} », titre « ${en.title} », ` +
      `accroche « ${en.tagline} », réglages « ${en.menuSettings} », préférence ${en.stored}`);

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
      tagline: document.querySelector('#import-tagline')?.textContent,
      settingsTitle: document.querySelector('#settings-header h2')?.textContent,
      buildDate: document.getElementById('build-date')?.textContent || '',
      playAria: document.getElementById('transport-play')?.getAttribute('aria-label'),
      language: document.getElementById('language-select')?.value,
      stored: localStorage.getItem('musica-language'),
    }));
    L.record(results, '3. Langue : passage au français à chaud (statique, dynamique, <html lang>)', pageName,
      fr.lang === 'fr' && fr.title === 'Liseuse MusicXML' &&
        fr.heading === 'Cantus' && fr.tagline === 'Ouvrez des partitions MusicXML, MEI, MuseScore, LilyPond, ABC, MIDI et GABC.' &&
        fr.settingsTitle === 'Réglages' && /^Version du /.test(fr.buildDate) &&
        fr.playAria === 'Lecture' && fr.language === 'fr' && fr.stored === 'fr' ? 'OK' : 'ÉCHEC',
      `<html lang> « ${fr.lang} », titre « ${fr.title} », accroche « ${fr.tagline} », réglages « ${fr.settingsTitle} », ` +
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
      /^Aucun fichier compatible/.test(frError.message) && frError.importTitle === 'Cantus' ? 'OK' : 'ÉCHEC',
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
      reloaded.lang === 'fr' && reloaded.heading === 'Cantus' &&
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
    await L.gotoPage(page, 1); await page.waitForTimeout(1500);
    await L.openSettings(page);
    const rows = await L.partRows(page);
    await page.click('#parts-list .part-display >> nth=0');
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

// Structure du panneau : quatre sections titrées dans l'ordre demandé,
// contrôles de même hauteur et même style, valeurs de curseurs avec unité,
// bouton « Tempo du fichier » franchement actif quand il l'est.
async function runSettingsSections(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 390, height: 844 },
  });
  try {
    await importLoaded(page, L.FILES.telemannXml);
    await L.openSettings(page);
    const info = await page.evaluate(() => {
      const visible = (el) => el && el.offsetParent !== null;
      const fonts = (el) => getComputedStyle(el);
      const sectionOf = (id) => document.getElementById(id)
        ?.closest('section')?.querySelector('.settings-section-title')?.textContent.trim() || null;
      const selects = [...document.querySelectorAll('#settings-overlay select')].filter(visible);
      return {
        titles: [...document.querySelectorAll('.settings-section-title')].map((el) => el.textContent.trim()),
        zoom: document.getElementById('zoom-value')?.textContent.trim(),
        master: document.getElementById('master-volume-value')?.textContent.trim(),
        language: {
          height: Math.round(document.getElementById('language-select')?.getBoundingClientRect().height || 0),
          fontSize: parseFloat(fonts(document.getElementById('language-select')).fontSize),
        },
        selectStyles: selects.map((sel) => {
          const style = fonts(sel);
          return {
            id: sel.id || sel.className,
            height: Math.round(sel.getBoundingClientRect().height),
            fontSize: style.fontSize,
            radius: style.borderRadius,
            background: style.backgroundColor,
          };
        }),
        placed: {
          zoom: sectionOf('zoom-range'),
          hideEmptyStaves: sectionOf('hide-empty-staves'),
          transposeVisual: sectionOf('transpose-visual'),
          master: sectionOf('master-volume-range'),
          tempo: sectionOf('tempo-input'),
          transposeAudio: sectionOf('transpose-audio'),
          piano: sectionOf('piano-only'),
          follow: sectionOf('follow-playback'),
          highlight: sectionOf('highlight-measure'),
          repeats: sectionOf('expand-repeats'),
          language: sectionOf('language-select'),
          storage: sectionOf('btn-storage'),
          parts: sectionOf('parts-list'),
        },
        options: ['hide-empty-staves', 'highlight-measure'].map((id) => {
          const el = document.getElementById(id);
          return {
            id,
            checked: el?.checked,
            label: el?.closest('label')?.textContent.trim() || '',
            section: sectionOf(id),
          };
        }),
        hints: [...document.querySelectorAll('#settings-overlay .settings-hint')].map((el) => el.textContent.trim()),
        choices: [...document.querySelectorAll('#settings-overlay .settings-choice')].map((choice) => {
          const check = choice.querySelector('input[type="checkbox"]');
          const hint = choice.querySelector('.settings-hint');
          const checkRect = check?.getBoundingClientRect();
          const hintRect = hint?.getBoundingClientRect();
          return {
            label: choice.querySelector('.settings-check')?.textContent.trim() || '',
            hasHint: !!hint,
            sameChoice: !hint || hint.closest('.settings-choice') === choice,
            below: !hint || (!!checkRect && !!hintRect && hintRect.top >= checkRect.bottom - 1),
          };
        }),
        voiceCompact: (() => {
          const row = document.querySelector('#parts-list .part-row');
          const expand = row?.querySelector('.part-expand');
          return {
            row: !!row,
            expand: Math.round(expand?.getBoundingClientRect().height || 0),
            detailsHidden: row?.querySelector('.part-details')?.classList.contains('hidden') === true,
          };
        })(),
      };
    });
    const titlesOk = info.titles.join('|') === 'Affichage|Lecture|Voix|Application';
    L.record(results, '3. Réglages : sections Affichage, Lecture, Voix, Application', pageName,
      titlesOk ? 'OK' : 'ÉCHEC', `titres « ${info.titles.join(' » / « ')} »`);

    const placed = info.placed;
    const placedOk = placed.zoom === 'Affichage' && placed.hideEmptyStaves === 'Affichage' &&
      placed.transposeVisual === 'Affichage' &&
      placed.master === 'Lecture' && placed.tempo === 'Lecture' && placed.transposeAudio === 'Lecture' &&
      placed.piano === 'Lecture' && placed.follow === 'Lecture' && placed.highlight === 'Lecture' &&
      placed.repeats === 'Lecture' &&
      placed.language === 'Application' && placed.storage === 'Application' && placed.parts === 'Voix';
    L.record(results, '3. Réglages : chaque contrôle est dans sa section', pageName,
      placedOk ? 'OK' : 'ÉCHEC',
      `affichage ${placed.zoom}/${placed.hideEmptyStaves}/${placed.transposeVisual}, ` +
      `lecture ${[placed.master, placed.tempo, placed.transposeAudio, placed.piano, placed.follow, placed.highlight, placed.repeats].join('/')}, ` +
      `voix ${placed.parts}, application ${placed.language}/${placed.storage}`);

    // Les deux nouvelles options sont décochées par défaut et enregistrées avec
    // les autres réglages, sans re-rendu de la partition à la bascule.
    const optionById = Object.fromEntries(info.options.map((o) => [o.id, o]));
    const defaultsOk = optionById['hide-empty-staves']?.checked === false &&
      optionById['highlight-measure']?.checked === false;
    L.record(results, '3. Réglages : portées vides et surlignage de mesure décochés par défaut', pageName,
      defaultsOk &&
        /portées vides/i.test(optionById['hide-empty-staves']?.label || '') &&
        /mesure en cours/i.test(optionById['highlight-measure']?.label || '') &&
        info.hints.some((h) => /système sauf le premier/i.test(h)) &&
        info.hints.some((h) => /mesure jouée/i.test(h)) ? 'OK' : 'ÉCHEC',
      `libellés « ${optionById['hide-empty-staves']?.label} » / « ${optionById['highlight-measure']?.label} », ` +
      `cochés ${optionById['hide-empty-staves']?.checked}/${optionById['highlight-measure']?.checked}, ` +
      `aides ${info.hints.filter((h) => /système sauf|mesure jouée/i.test(h)).length}`);

    // Chaque aide est groupée avec sa propre case (même bloc, sous la case),
    // y compris quand les quatre cases sont sur une ligne.
    const choiceLabels = info.choices.map((c) => c.label);
    const withHint = info.choices.filter((c) => c.hasHint);
    const hintsGrouped = info.choices.length === 4 &&
      withHint.length === 2 &&
      withHint.every((c) => c.sameChoice && c.below) &&
      withHint.some((c) => /surligner/i.test(c.label)) &&
      withHint.some((c) => /dérouler/i.test(c.label));
    L.record(results, '3. Réglages : chaque texte d’aide reste groupé sous sa case', pageName,
      hintsGrouped ? 'OK' : 'ÉCHEC',
      `${info.choices.length} case(s) [${choiceLabels.join(' / ')}], ` +
      `${withHint.length} avec aide, même bloc et sous la case : ` +
      `${withHint.map((c) => `${c.label}:${c.sameChoice && c.below}`).join(', ')}`);

    await page.evaluate(() => {
      const overlay = document.getElementById('settings-overlay');
      const group = document.getElementById('highlight-measure').closest('.settings-checks');
      overlay.scrollTop += group.getBoundingClientRect().top - overlay.getBoundingClientRect().top - 80;
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: '/tmp/cantus-voix/reglages-lecture-telephone.png' });

    await L.markSvg(page);
    await page.check('#hide-empty-staves');
    await page.check('#highlight-measure');
    const savedOptions = await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('musica-settings') || '{}');
      return {
        hideEmptyStaves: saved.hideEmptyStaves,
        highlightMeasure: saved.highlightMeasure,
        marker: !!document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
      };
    });
    await page.uncheck('#hide-empty-staves');
    await page.uncheck('#highlight-measure');
    L.record(results, '3. Réglages : les deux options sont enregistrées sans re-rendu', pageName,
      savedOptions.hideEmptyStaves === true && savedOptions.highlightMeasure === true &&
        savedOptions.marker ? 'OK' : 'ÉCHEC',
      `enregistré portées vides ${savedOptions.hideEmptyStaves}, surlignage ${savedOptions.highlightMeasure}, ` +
      `SVG marqué conservé : ${savedOptions.marker}`);

    const sameStyle = (key) => new Set(info.selectStyles.map((s) => s[key])).size === 1;
    const selectsOk = info.selectStyles.length >= 5 && info.selectStyles.every((s) => s.height >= 44) &&
      sameStyle('fontSize') && sameStyle('radius') && sameStyle('background');
    L.record(results, '3. Réglages : listes déroulantes de même hauteur et de même style', pageName,
      selectsOk ? 'OK' : 'ÉCHEC',
      `${info.selectStyles.length} listes : ${info.selectStyles.map((s) => `${s.id || s.className} ${s.height}px`).join(', ')} ; ` +
      `style commun ${sameStyle('fontSize') && sameStyle('radius') && sameStyle('background')}`);

    const valuesOk = /^\d+ %$/.test(info.zoom || '') && /^\d+ %$/.test(info.master || '') &&
      info.language.height >= 44 && info.language.fontSize >= 14;
    L.record(results, '3. Réglages : zoom et volume avec unité, langue lisible', pageName,
      valuesOk && info.voiceCompact.row && info.voiceCompact.expand >= 44 && info.voiceCompact.detailsHidden ? 'OK' : 'ÉCHEC',
      `zoom « ${info.zoom} », volume « ${info.master} », langue ${info.language.height} px / ${info.language.fontSize} px ; ` +
      `voix compacte ${info.voiceCompact.row}, chevron ${info.voiceCompact.expand} px, réglages fins repliés ${info.voiceCompact.detailsHidden}`);

    // Le bouton « Tempo du fichier » actif garde un contour et un fond francs ;
    // désactivé, il est visiblement estompé.
    await page.$eval('#tempo-input', (el) => {
      el.value = '100';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(300);
    const active = await page.evaluate(() => {
      const btn = document.getElementById('tempo-reset');
      const style = getComputedStyle(btn);
      return { disabled: btn.disabled, opacity: style.opacity, background: style.backgroundColor, border: style.borderTopColor };
    });
    await page.click('#tempo-reset');
    await page.waitForTimeout(300);
    const inactive = await page.evaluate(() => {
      const btn = document.getElementById('tempo-reset');
      const style = getComputedStyle(btn);
      return { disabled: btn.disabled, opacity: style.opacity, background: style.backgroundColor };
    });
    const activeOk = active.disabled === false && active.opacity === '1' &&
      active.background === 'rgb(255, 255, 255)' && active.border === 'rgb(34, 34, 34)';
    const inactiveOk = inactive.disabled === true && parseFloat(inactive.opacity) < 0.6;
    L.record(results, '3. Réglages : « Tempo du fichier » actif ne semble pas désactivé', pageName,
      activeOk && inactiveOk ? 'OK' : 'ÉCHEC',
      `actif : désactivé ${active.disabled}, opacité ${active.opacity}, fond ${active.background}, bord ${active.border} ; ` +
      `désactivé : opacité ${inactive.opacity}`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (structure des réglages)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Structure des réglages', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Ergonomie tactile : à 390 px de large, chaque voix tient sur une ligne
// compacte (nom + 👁 + 🔊 + volume), les cibles font au moins 44 px et les
// réglages fins (taille, instrument) restent repliés jusqu'à un appui.
async function runVoiceTouchTargets(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 390, height: 844 },
  });
  try {
    await importLoaded(page, L.FILES.telemannXml);
    await openSettingsNarrow(page);
    const metrics = await page.evaluate(() => [...document.querySelectorAll('#parts-list .part-row')].map((row) => {
      const expand = row.querySelector('.part-expand');
      const toggles = [...row.querySelectorAll('.part-toggle')].map((b) => {
        const r = b.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), pressed: b.getAttribute('aria-pressed') };
      });
      const controls = row.querySelector('.part-controls').getBoundingClientRect();
      const volume = row.querySelector('select.part-volume').getBoundingClientRect();
      const expandRect = expand.getBoundingClientRect();
      return {
        name: row.querySelector('.part-name')?.textContent?.trim(),
        toggles,
        expand: { h: Math.round(expandRect.height), top: Math.round(expandRect.top), right: Math.round(expandRect.right) },
        controls: { top: Math.round(controls.top), left: Math.round(controls.left), right: Math.round(controls.right) },
        volume: { h: Math.round(volume.height) },
        detailsHidden: row.querySelector('.part-details')?.classList.contains('hidden'),
        expanded: expand.getAttribute('aria-expanded') === 'true',
      };
    }));
    const targetsOk = metrics.length >= 2 && metrics.every((m) => m.toggles.length === 2 &&
      m.toggles.every((t) => t.w >= 44 && t.h >= 44 && t.pressed !== null) &&
      m.expand.h >= 44 && m.volume.h >= 44);
    const oneLine = metrics.length >= 2 && metrics.every((m) =>
      Math.abs(m.expand.top - m.controls.top) < 12 && m.expand.right <= m.controls.left + 2);
    await page.evaluate(() => document.getElementById('parts-group').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(200);
    await page.screenshot({ path: '/tmp/cantus-voix/reglages-voix-telephone.png' });
    L.record(results, '3. Voix : une ligne compacte par voix, cibles ≥ 44 px à 390 px', pageName,
      targetsOk && oneLine && metrics.every((m) => m.detailsHidden && !m.expanded) ? 'OK' : 'ÉCHEC',
      `${metrics.length} voix : ${metrics.map((m) => `${m.name} ${m.toggles.map((t) => `${t.w}×${t.h}`).join(' ')} ` +
        `volume ${m.volume.h} px, chevron ${m.expand.h} px`).join(' | ')} ; ` +
      `ligne unique : ${oneLine}, réglages fins repliés : ${metrics.every((m) => m.detailsHidden)}`);

    // Un appui sur le chevron déplie la taille et l'instrument, puis les replie.
    await expandPart(page, 0);
    const opened = await page.evaluate(() => {
      const row = document.querySelector('#parts-list .part-row');
      const details = row.querySelector('.part-details');
      const size = row.querySelector('select.part-size').getBoundingClientRect();
      const program = row.querySelector('select.part-program')?.getBoundingClientRect();
      return {
        expanded: row.querySelector('.part-expand').getAttribute('aria-expanded') === 'true',
        hidden: details.classList.contains('hidden'),
        sizeHeight: Math.round(size.height),
        programHeight: program ? Math.round(program.height) : null,
        sizeLabel: details.querySelector('.part-detail-label')?.textContent,
      };
    });
    await expandPart(page, 0);
    const closed = await page.evaluate(() => {
      const row = document.querySelector('#parts-list .part-row');
      return {
        expanded: row.querySelector('.part-expand').getAttribute('aria-expanded') === 'true',
        hidden: row.querySelector('.part-details').classList.contains('hidden'),
      };
    });
    L.record(results, '3. Voix : le chevron déplie taille et instrument, puis les replie', pageName,
      opened.expanded && !opened.hidden && opened.sizeHeight >= 44 && opened.programHeight >= 44 &&
        closed.expanded === false && closed.hidden ? 'OK' : 'ÉCHEC',
      `déplié : aria-expanded ${opened.expanded}, taille ${opened.sizeHeight} px, ` +
      `instrument ${opened.programHeight} px, libellé « ${opened.sizeLabel} » ; ` +
      `replié : aria-expanded ${closed.expanded}, caché ${closed.hidden}`);

    // Un appui sur la ligne (hors contrôle) déplie sans toucher aux interrupteurs.
    const before = await L.partRows(page);
    await page.evaluate(() => document.querySelector('#parts-list .part-row').click());
    await page.waitForTimeout(150);
    const after = await L.partRows(page);
    const statesSame = before.every((r, i) => r.displayed === after[i].displayed && r.played === after[i].played);
    L.record(results, '3. Voix : un appui sur la ligne déplie sans changer les interrupteurs', pageName,
      statesSame && after[0]?.expanded ? 'OK' : 'ÉCHEC',
      `avant ${before.map((r) => `${r.displayed ? 'a' : 'm'}/${r.played ? 'j' : 'c'}`).join(' ')} ; ` +
      `après ${after.map((r) => `${r.displayed ? 'a' : 'm'}/${r.played ? 'j' : 'c'}`).join(' ')}, ` +
      `déplié ${after[0]?.expanded}`);

    // Aucun débordement horizontal à 390 px, y compris dans le panneau.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      overlay: (() => {
        const el = document.getElementById('settings-overlay');
        return { scroll: el.scrollWidth, client: el.clientWidth };
      })(),
      listOverflow: (() => {
        const list = document.getElementById('parts-list');
        return list.scrollWidth > list.clientWidth;
      })(),
    }));
    L.record(results, '3. Réglages : aucun débordement horizontal à 390 px', pageName,
      overflow.scrollWidth <= overflow.innerWidth && overflow.overlay.scroll <= overflow.overlay.client &&
        !overflow.listOverflow ? 'OK' : 'ÉCHEC',
      `document ${overflow.scrollWidth}/${overflow.innerWidth} px, panneau ${overflow.overlay.scroll}/${overflow.overlay.client} px, ` +
      `liste débordante : ${overflow.listOverflow}`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (cibles tactiles des voix)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Cibles tactiles des voix', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

// Grand écran : tous les contrôles d'une voix (nom, 👁, 🔊, volume, taille,
// instrument) sont affichés directement sur une ligne lisible, sans repli.
// À 768 px (liseuse en portrait), la ligne redevient repliable. La disposition
// est en CSS ; la bascule de largeur régénère seulement la liste des voix.
async function runVoiceLayout(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, {
    pageName, viewport: { width: 1280, height: 900 },
  });
  try {
    await importLoaded(page, L.FILES.telemannXml);
    await L.openSettings(page);
    const checkLayout = await page.evaluate(() => {
      const choices = [...document.querySelectorAll('#settings-overlay .settings-choice')];
      const items = choices.map((choice) => {
        const check = choice.querySelector('.settings-check');
        const hint = choice.querySelector('.settings-hint');
        const cr = check?.getBoundingClientRect();
        const hr = hint?.getBoundingClientRect();
        return {
          label: check?.textContent.trim() || '',
          top: Math.round(cr?.top || 0),
          hint: !!hint,
          sameChoice: !hint || hint.closest('.settings-choice') === choice,
          below: !hint || (!!cr && !!hr && hr.top >= cr.bottom - 1),
        };
      });
      return { items, tops: items.map((item) => item.top), hints: items.filter((item) => item.hint) };
    });
    const checksOneLine = checkLayout.items.length === 4 &&
      Math.max(...checkLayout.tops) - Math.min(...checkLayout.tops) < 12;
    const checksHints = checkLayout.hints.length === 2 &&
      checkLayout.hints.every((item) => item.sameChoice && item.below);
    L.record(results, '3. Réglages à 1280 px : quatre cases sur une ligne, aides groupées', pageName,
      checksOneLine && checksHints ? 'OK' : 'ÉCHEC',
      `${checkLayout.items.length} case(s) [${checkLayout.items.map((item) => item.label).join(' / ')}], ` +
      `même ligne : ${checksOneLine}, aides sous leur case : ${checksHints}`);
    await page.evaluate(() => {
      const overlay = document.getElementById('settings-overlay');
      const group = document.getElementById('highlight-measure').closest('.settings-checks');
      overlay.scrollTop += group.getBoundingClientRect().top - overlay.getBoundingClientRect().top - 80;
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: '/tmp/cantus-voix/reglages-lecture-ordinateur.png' });
    await page.evaluate(() => document.getElementById('parts-group').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(200);

    const layout = await page.evaluate(() => {
      const list = document.getElementById('parts-list');
      const rows = [...list.querySelectorAll('.part-row')].map((row) => {
        const rect = (el) => el.getBoundingClientRect();
        const controls = rect(row.querySelector('.part-controls'));
        const details = row.querySelector('.part-details');
        const detailFields = [...details.querySelectorAll('.part-detail-field')].map(rect);
        const order = [...row.querySelectorAll('.part-toggle, select.part-volume')].map((el) => (
          el.classList.contains('part-display') ? 'display'
            : el.classList.contains('part-sound') ? 'sound' : 'volume'));
        return {
          name: row.querySelector('.part-name')?.textContent?.trim(),
          controlsTop: Math.round(controls.top),
          controlsBottom: Math.round(controls.bottom),
          detailTops: detailFields.map((r) => Math.round(r.top)),
          detailBottoms: detailFields.map((r) => Math.round(r.bottom)),
          order,
          detailsDisplay: getComputedStyle(details).display,
          detailsHiddenClass: details.classList.contains('hidden'),
          caretDisplay: getComputedStyle(row.querySelector('.part-caret')).display,
          expandDisabled: row.querySelector('.part-expand').disabled,
          expandAria: row.querySelector('.part-expand').getAttribute('aria-expanded'),
          sizeVisible: !!row.querySelector('select.part-size'),
          programVisible: !!row.querySelector('select.part-program'),
          rowOverflow: row.scrollWidth > row.clientWidth,
        };
      });
      return {
        listWidth: Math.round(list.getBoundingClientRect().width),
        listOverflow: list.scrollWidth > list.clientWidth,
        rows,
      };
    });
    const expected = 'display,sound,volume';
    const orderOk = layout.rows.length >= 2 && layout.rows.every((r) => r.order.join(',') === expected);
    // Une seule ligne : le haut des réglages fins est dans la bande verticale
    // des interrupteurs/volume, et aucun chevron ni repli n'est actif.
    const oneLine = layout.rows.every((r) =>
      r.detailTops.length >= 2 &&
      r.detailTops.every((top) => Math.abs(top - r.controlsTop) < 16));
    const noCollapse = layout.rows.every((r) =>
      r.detailsDisplay === 'flex' && r.caretDisplay === 'none' && r.expandDisabled &&
      r.expandAria === 'true');
    const fieldsOk = layout.rows.every((r) => r.sizeVisible && r.programVisible);
    const rowsFit = layout.rows.every((r) => !r.rowOverflow);
    L.record(results, '3. Voix à 1280 px : tous les contrôles directs sur une ligne, sans repli', pageName,
      orderOk && oneLine && noCollapse && fieldsOk && !layout.listOverflow && rowsFit
        ? 'OK' : 'ÉCHEC',
      `ordre ${layout.rows.map((r) => r.order.join('+')).join(' | ')} ; une ligne : ${oneLine}, ` +
      `sans repli : ${noCollapse}, taille+instrument : ${fieldsOk}, ` +
      `débordement lignes/liste : ${!rowsFit}/${layout.listOverflow}`);
    await page.evaluate(() => document.getElementById('parts-group').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(200);
    await page.screenshot({ path: '/tmp/cantus-voix/reglages-voix-ordinateur.png' });

    // Liseuse en portrait (768 px) : la ligne redevient repliable, sans
    // débordement ; un appui déplie les réglages fins.
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(500);
    const narrow = await page.evaluate(() => {
      const row = document.querySelector('#parts-list .part-row');
      const details = row.querySelector('.part-details');
      return {
        detailsDisplay: getComputedStyle(details).display,
        hiddenClass: details.classList.contains('hidden'),
        caretDisplay: getComputedStyle(row.querySelector('.part-caret')).display,
        expandDisabled: row.querySelector('.part-expand').disabled,
        expandAria: row.querySelector('.part-expand').getAttribute('aria-expanded'),
        listOverflow: document.getElementById('parts-list').scrollWidth >
          document.getElementById('parts-list').clientWidth,
      };
    });
    await page.click('#parts-list .part-expand >> nth=0');
    await page.waitForTimeout(200);
    const narrowOpen = await page.evaluate(() => {
      const row = document.querySelector('#parts-list .part-row');
      const details = row.querySelector('.part-details');
      return {
        display: getComputedStyle(details).display,
        hiddenClass: details.classList.contains('hidden'),
        expandAria: row.querySelector('.part-expand').getAttribute('aria-expanded'),
        sizeHeight: Math.round(row.querySelector('select.part-size')?.getBoundingClientRect().height || 0),
      };
    });
    L.record(results, '3. Voix à 768 px (liseuse) : repli conservé, dépliage lisible sans débordement', pageName,
      narrow.detailsDisplay === 'none' && narrow.hiddenClass && narrow.caretDisplay !== 'none' &&
        !narrow.expandDisabled && narrow.expandAria === 'false' && !narrow.listOverflow &&
        narrowOpen.display !== 'none' && !narrowOpen.hiddenClass && narrowOpen.expandAria === 'true' &&
        narrowOpen.sizeHeight >= 44 ? 'OK' : 'ÉCHEC',
      `replié ${narrow.detailsDisplay}/${narrow.hiddenClass}, chevron ${narrow.caretDisplay}, ` +
      `déplié ${narrowOpen.display}/${narrowOpen.expandAria}, taille ${narrowOpen.sizeHeight} px, ` +
      `débordement ${narrow.listOverflow}`);

    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (disposition des voix)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '3. Disposition des voix à 1280 px', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
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
      await runTextSize(browser, url, pageName, results);
      await runZoomAndScroll(browser, url, pageName, results);
      await runBackNavigation(browser, url, pageName, results);
      await runWheelBack(browser, url, pageName, results);
      await runBach(browser, url, pageName, results);
      await runPartSizeCacheRace(browser, url, pageName, results);
      await runTempo(browser, url, pageName, results);
      await runInstruments(browser, url, pageName, results);
      await runTransposition(browser, url, pageName, results);
      await runLanguage(browser, url, pageName, results);
      await runFolderVoices(browser, url, pageName, results);
      await runSettingsSections(browser, url, pageName, results);
      await runVoiceTouchTargets(browser, url, pageName, results);
      await runVoiceLayout(browser, url, pageName, results);
    }
  } catch (e) {
    console.log('ERREUR GÉNÉRALE', e.stack);
  }
  console.log('\n=== RÉSUMÉ S3 ===');
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  server.close();
})();
