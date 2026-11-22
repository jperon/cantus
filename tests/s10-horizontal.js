// Scénario 10 — disposition : en mode horizontal, une page rendue ne contient
// jamais deux systèmes. Byrd à 1200×800 et zoom 40 reproduit le mélange : la
// première page (début du premier mouvement) n'a qu'un système, donc le mode
// est horizontal, mais la page suivante (mouvement plus court) en contient deux
// et les superposait. Vérifie toutes les pages, après réouverture depuis les
// caches, le forçage « Vertical » puis le retour à « Auto », le passage en
// vertical décidé au rechargement après masquage d'une voix, une nouvelle
// session avec cette voix masquée (même décision), puis le retour à un fichier
// vertical.
const L = require('./lib');

const PAGES = ['index.html', 'spa.html'];
const VIEWPORT = { width: 1200, height: 800 };
const ZOOM = 40;

async function openWithZoom(browser, url, pageName) {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  await L.forceLanguage(ctx);
  // Le zoom fait partie de la géométrie du rendu : il est posé avant le
  // démarrage de l'application, comme un réglage déjà enregistré.
  await ctx.addInitScript((zoom) => {
    try { localStorage.setItem('musica-settings', JSON.stringify({ zoom })); } catch (e) { /* stockage absent */ }
  }, ZOOM);
  const { page, errors } = await L.newPage(browser, url, {
    pageName, context: ctx, viewport: VIEWPORT,
  });
  return { ctx, page, errors };
}

async function mode(page) {
  return page.evaluate(() => {
    const wrapper = document.querySelector('#page-current .scroll-wrapper');
    return wrapper && wrapper.classList.contains('vertical') ? 'vertical' : 'horizontal';
  });
}

// États des pages rendues : numéro et nombre de systèmes du SVG.
async function rendered(page) {
  return page.evaluate(() => [...document.querySelectorAll('#page-current .scroll-page')]
    .filter((div) => div.querySelector('svg'))
    .map((div) => ({
      page: parseInt(div.dataset.page, 10),
      systems: div.querySelectorAll('svg g.system').length,
    })));
}

// Parcourt toutes les pages en mode horizontal (deux demi-pages par page) et
// relève le nombre de systèmes de chaque page rendue. Le rendu est asynchrone :
// chaque appui attend le SVG de la page suivante avant de relever, sinon la
// page serait retirée du DOM avant d'avoir été comptée.
async function walk(page) {
  const counts = new Map();
  const sample = async () => {
    for (const { page: number, systems } of await rendered(page)) {
      counts.set(number, Math.max(counts.get(number) ?? 0, systems));
    }
  };
  const atEnd = async () => {
    const info = await L.pageInfo(page);
    const half = await page.evaluate(() => {
      const wrapper = document.querySelector('#page-current .scroll-wrapper');
      const match = /translateX\(-([\d.]+)vw\)/.exec(wrapper?.style.transform || '');
      return match ? parseFloat(match[1]) : 0;
    });
    return info.page >= info.total && half === 0;
  };
  const start = async () => {
    await L.gotoPage(page, 1);
    await page.waitForFunction(() => {
      const match = /^1\s*\//.exec(document.getElementById('page-number')?.textContent || '');
      return !!match && !!document.querySelector('#page-current .scroll-page[data-page="1"] svg');
    }, null, { timeout: 30000, polling: 100 });
    await page.waitForTimeout(200);
  };
  await start();
  await sample();
  let presses = 0;
  while (!(await atEnd())) {
    if (presses > 500) throw new Error('parcours non terminé après 500 pressions');
    await L.pressArrow(page, 'right');
    // L'indicateur ne change qu'à la page entière (deux demi-pages) : attendre
    // plutôt que toutes les pages présentes aient leur SVG. displayView crée la
    // page suivante immédiatement ; son rendu est asynchrone.
    await page.waitForTimeout(150);
    await page.waitForFunction(() => {
      const pages = [...document.querySelectorAll('#page-current .scroll-page')];
      return pages.length > 0 && pages.every((div) => div.querySelector('svg'));
    }, null, { timeout: 30000, polling: 100 });
    await sample();
    presses++;
  }
  return { counts, presses, total: (await L.pageInfo(page)).total };
}

async function waitRendered(page) {
  await L.waitFirstSvg(page, 180000);
  await L.waitBackgroundLoaded(page, 300000);
  await page.waitForTimeout(600);
}

// En mode vertical, displayView crée d'un coup les pages de la fenêtre : leur
// rendu est asynchrone. Attendre que toutes aient leur SVG avant de relever.
async function waitDisplayedRendered(page) {
  await page.waitForFunction(() => {
    const pages = [...document.querySelectorAll('#page-current .scroll-page')];
    return pages.length >= 1 && pages.every((div) => div.querySelector('svg'));
  }, null, { timeout: 180000, polling: 100 });
}

async function checkAll(page, results, label, pageName, expectedTotal) {
  const currentMode = await mode(page);
  const { counts, presses, total } = await walk(page);
  const entries = [...counts.entries()];
  const tooMany = entries.filter(([, systems]) => systems > 1);
  const complete = counts.size === total;
  const totalOk = expectedTotal == null || total === expectedTotal;
  L.record(results, label, pageName,
    currentMode === 'horizontal' && complete && tooMany.length === 0 && totalOk ? 'OK' : 'ÉCHEC',
    `mode ${currentMode}, ${counts.size}/${total} page(s) relevée(s) en ${presses} appui(s), ` +
    `systèmes ${entries.map(([p, n]) => `${p}:${n}`).join(' ')}` +
    (tooMany.length ? ` — pages à plusieurs systèmes : ${tooMany.map(([p, n]) => `${p}:${n}`).join(', ')}` : '') +
    (expectedTotal != null && !totalOk ? ` — total ${total} au lieu de ${expectedTotal}` : '') +
    (complete ? '' : ' — toutes les pages n’ont pas été rendues'));
  return { total, presses };
}

async function runPage(browser, url, pageName, results) {
  const { ctx, page, errors } = await openWithZoom(browser, url, pageName);
  try {
    await L.waitReady(page);
    await L.importFile(page, L.FILES.byrdMscz);
    await waitRendered(page);

    const first = await checkAll(page, results,
      '10. Mode horizontal : une page = un système sur toutes les pages (Byrd 1200×800, zoom 40)',
      pageName);

    // Surlignage horizontal : le rectangle de fond reste dans la page affichée
    // quand le suivi change de page (wrapper translaté en vw).
    await L.openSettings(page);
    await page.check('#highlight-measure');
    await L.closeSettings(page);
    await page.click('#transport-play');
    await page.waitForFunction(() => window.__musicaPlaybackState?.().state === 'playing',
      null, { timeout: 60000, polling: 100 });
    await page.waitForSelector('#page-current .measure-highlight', { timeout: 60000 });
    const highlightAt = async () => page.evaluate(() => {
      const rect = document.querySelector('#page-current .measure-highlight');
      const pageDiv = rect?.closest('.scroll-page');
      const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
      return {
        key: window.__musicaMeasureHighlightState().key,
        current: window.__musicaPlaybackCurrentMark().id,
        rectPage: pageDiv ? parseInt(pageDiv.dataset.page, 10) : null,
        displayed: m ? parseInt(m[1], 10) : null,
      };
    });
    const hStart = await highlightAt();
    await page.$eval('#transport-seek', (el) => {
      el.value = '500';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    let moved = true;
    try {
      await page.waitForFunction((prev) => {
        const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
        return !!m && parseInt(m[1], 10) !== prev;
      }, hStart.displayed, { timeout: 30000, polling: 100 });
    } catch {
      moved = false;
    }
    await page.waitForTimeout(400);
    const hMoved = await highlightAt();
    L.record(results, '10. Mode horizontal : la mesure surlignée reste sur la page affichée', pageName,
      moved && hStart.key != null && String(hStart.key) === String(hStart.current) &&
        hStart.rectPage === hStart.displayed &&
        hMoved.key != null && String(hMoved.key) === String(hMoved.current) &&
        hMoved.rectPage === hMoved.displayed ? 'OK' : 'ÉCHEC',
      `départ page ${hStart.displayed} / mesure ${hStart.key}, ` +
      `après saut page ${hMoved.displayed} / mesure ${hMoved.key}, ` +
      `rectangle sur la page ${hMoved.rectPage}`);
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press('s');
    await page.waitForTimeout(300);
    await L.gotoPage(page, 1);

    // Réouverture depuis la bibliothèque : le mode et la pagination doivent
    // être identiques, servis par les caches SVG et de lecture de la version
    // courante (une page mise en cache avec deux systèmes serait resservie).
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page, 60000);
    await page.waitForTimeout(400);
    await L.openLibraryEntry(page, 0);
    await waitRendered(page);
    await checkAll(page, results,
      '10. Réouverture depuis les caches : même pagination, toujours un système par page',
      pageName, first.total);

    // Forçage « Vertical » sur un fichier que « Auto » met en horizontal : la
    // mise en page naturelle revient (moins de pages, dont certaines à deux
    // systèmes) et le réglage est conservé. Revenir au début : le parcours
    // précédent a laissé la vue sur la dernière page.
    await L.gotoPage(page, 1);
    await page.waitForFunction(() => {
      const match = /^1\s*\//.exec(document.getElementById('page-number')?.textContent || '');
      return !!match && !!document.querySelector('#page-current .scroll-page[data-page="1"] svg');
    }, null, { timeout: 30000, polling: 100 });
    await L.markSvg(page);
    await L.openSettings(page);
    await page.click('.layout-btn[data-layout="vertical"]', { timeout: 20000 });
    await page.waitForFunction(
      () => !document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
      null, { timeout: 120000, polling: 100 });
    await waitRendered(page);
    await waitDisplayedRendered(page);
    const forcedMode = await mode(page);
    const forced = await L.pageInfo(page);
    const forcedPages = await rendered(page);
    const forcedStored = await page.evaluate(
      () => JSON.parse(localStorage.getItem('musica-settings') || '{}').layout);
    await L.closeSettings(page);
    L.record(results, '10. Disposition « Vertical » forcée : mise en page naturelle du fichier horizontal', pageName,
      forcedMode === 'vertical' && forced.total < first.total && forcedPages.some((entry) => entry.systems > 1) &&
        forcedStored === 'vertical' ? 'OK' : 'ÉCHEC',
      `mode ${forcedMode}, ${forced.total} page(s) (horizontal : ${first.total}), ` +
      `systèmes ${forcedPages.map((entry) => `${entry.page}:${entry.systems}`).join(' ')}, réglage ${forcedStored}`);

    // Retour à « Auto » : le fichier redevient horizontal, et les pages mises
    // en cache pour la mise en page naturelle ne sont pas resservies.
    await L.markSvg(page);
    await L.openSettings(page);
    await page.click('.layout-btn[data-layout="auto"]', { timeout: 20000 });
    await page.waitForFunction(
      () => !document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
      null, { timeout: 120000, polling: 100 });
    await waitRendered(page);
    const autoMode = await mode(page);
    const auto = await L.pageInfo(page);
    await L.closeSettings(page);
    L.record(results, '10. Retour à « Auto » : le fichier redevient horizontal', pageName,
      autoMode === 'horizontal' && auto.total === first.total ? 'OK' : 'ÉCHEC',
      `mode ${autoMode}, ${auto.total} page(s) (attendu ${first.total})`);

    // Masquer une voix change la hauteur des systèmes : le rechargement qui
    // suit redécide la disposition sur la première page, qui contient
    // maintenant deux systèmes. Le mode n'est donc pas figé pour le fichier.
    await L.markSvg(page);
    await L.openSettings(page);
    await page.waitForFunction(
      () => document.querySelectorAll('#parts-list .part-row').length >= 2,
      null, { timeout: 30000, polling: 100 });
    await page.click('#parts-list .part-row:nth-child(1) .part-display');
    await L.closeSettings(page);
    await page.waitForFunction(
      () => !document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
      null, { timeout: 120000, polling: 100 });
    await waitRendered(page);
    await waitDisplayedRendered(page);
    const maskedMode = await mode(page);
    const masked = await L.pageInfo(page);
    const maskedPages = await rendered(page);
    L.record(results, '10. Après masquage d’une voix : Auto redécide au rechargement et passe en vertical', pageName,
      maskedMode === 'vertical' && masked.total < first.total && maskedPages.some((entry) => entry.systems > 1) ? 'OK' : 'ÉCHEC',
      `mode ${maskedMode}, ${masked.total} page(s), ` +
      `systèmes ${maskedPages.map((entry) => `${entry.page}:${entry.systems}`).join(' ')}`);

    // Nouvelle session avec la voix toujours masquée : la mise en page
    // naturelle de la première page a maintenant deux systèmes, donc le mode
    // redevient vertical. Les pages mises en cache pour la mise en page
    // horizontale (mêmes dimensions, mêmes voix) ne doivent pas être
    // resservies : la clé de cache porte la mise en page.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page, 60000);
    await page.waitForTimeout(400);
    await L.openLibraryEntry(page, 0);
    await waitRendered(page);
    await L.gotoPage(page, 1);
    await page.waitForFunction(() => {
      const match = /^1\s*\//.exec(document.getElementById('page-number')?.textContent || '');
      return !!match && !!document.querySelector('#page-current .scroll-page[data-page="1"] svg');
    }, null, { timeout: 30000, polling: 100 });
    const sessionMode = await mode(page);
    const sessionSystems = (await rendered(page)).find((entry) => entry.page === 1)?.systems ?? 0;
    L.record(results, '10. Nouvelle session avec la voix masquée : mise en page naturelle, pas les pages horizontales en cache', pageName,
      sessionMode === 'vertical' && sessionSystems > 1 ? 'OK' : 'ÉCHEC',
      `mode ${sessionMode}, ${sessionSystems} système(s) sur la page 1`);

    // Fichier vertical ensuite, dans la même application : le mode est
    // redécidé par fichier et la mise en page d'un système par page n'est pas
    // restée dans le toolkit du worker. Le SVG marqué garantit d'attendre le
    // nouveau fichier et non l'ancien, encore affiché pendant la lecture des
    // fichiers importés.
    await L.markSvg(page);
    await L.importFile(page, L.FILES.telemannXml);
    await page.waitForFunction(
      () => !document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'),
      null, { timeout: 30000, polling: 100 });
    await waitRendered(page);
    const verticalMode = await mode(page);
    const firstPageSystems = (await rendered(page)).find((entry) => entry.page === 1)?.systems ?? 0;
    const verticalOk = verticalMode === 'vertical' && firstPageSystems > 1;
    L.record(results, '10. Fichier vertical ensuite : deux systèmes ou plus par page', pageName,
      verticalOk ? 'OK' : 'ÉCHEC',
      `mode ${verticalMode}, ${firstPageSystems} système(s) sur la page 1 (Telemann 1200×800, zoom 40)`);

    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (mode horizontal)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '10. Mode horizontal (une page = un système)', pageName,
      'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
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
  console.log('\n=== RÉSUMÉ S10 ===');
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  server.close();
})();
