// Scénario 13 — dossier LilyPond à fichiers interdépendants (lot CC0
// alde-friezen) : deux .ly partagent noaten.ily. Deux pièces seulement,
// trois fichiers stockés, l'auxiliaire transmis à scoretk, notes et lecture,
// réouverture, anciennes entrées et import d'un fichier seul inchangé.
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const PAGES = ['index.html', 'spa.html'];
const DIR = L.FILES.lyIncludesDir;
const LEGACY_XML = path.join(__dirname, 'fixtures', 'scoretk', 'pauses-tempo.xml');

function sourceLogs(page) {
  const logs = [];
  page.on('console', (msg) => {
    const match = msg.text().match(/^Source (\d+)\/(\d+) : (\d+) mouvement/);
    if (match) logs.push(match.slice(1).map(Number));
  });
  return logs;
}

function dbEntry(page, index = 0) {
  return page.evaluate((i) => new Promise((resolve) => {
    const req = indexedDB.open('musica');
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) return resolve(null);
      const all = db.transaction('files', 'readonly').objectStore('files').getAll();
      all.onsuccess = () => {
        const entries = all.result.sort((a, b) => b.addedAt - a.addedAt);
        const e = entries[i];
        resolve(e ? {
          name: e.name,
          xml: typeof e.xml === 'string' ? e.xml.length : 0,
          files: (e.files || []).map((f) => ({
            name: f.name,
            role: f.role || null,
            includes: f.includes ? Object.keys(f.includes) : null,
          })),
        } : null);
      };
      all.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  }), index);
}

// Après rechargement, la bibliothèque s'ouvre d'elle-même ; son bouton peut
// rester masqué (aucune partition chargée), d'où un clic DOM plutôt que
// Playwright quand l'overlay n'est pas encore affiché.
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

async function probe(page) {
  const p = await page.evaluate(async () => {
    const info = await window.__musicaPlaybackProbe();
    return {
      midiBytes: info.midiBytes,
      marks: info.syncMarksCount,
      duration: info.duration,
      notes: window.__musicaAudio.getNotes().length,
      state: window.__musicaPlaybackState().state,
    };
  });
  return p;
}

async function importFolderAndWait(page) {
  await L.importFolder(page, DIR);
  const first = await L.waitFirstSvg(page, 180000);
  await L.waitBackgroundLoaded(page, 300000);
  await page.waitForTimeout(800);
  return first;
}

async function runPage(browser, url, pageName, results) {
  // A. Le dossier complet : deux pièces, trois fichiers, notes et lecture.
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    const logs = sourceLogs(page);
    try {
      await L.waitReady(page);
      const first = await importFolderAndWait(page);
      const entry = await dbEntry(page);
      const twoPieces = logs.length === 2 && logs.every((l) => l[1] === 2 && l[2] === 1);
      L.record(results, '13. Dossier LilyPond : deux pièces seulement (les .ly non inclus)', pageName,
        twoPieces ? 'OK' : 'ÉCHEC',
        `1er SVG en ${first.ms} ms, conversions ${JSON.stringify(logs)}`);
      const names = entry?.files.map((f) => f.name).sort() || [];
      const stored = names.join(',') === 'fideo.ly,noaten.ily,partituer.ly' &&
        entry.files.filter((f) => f.role === 'main').length === 2 &&
        entry.files.filter((f) => f.role === 'aux').length === 1 &&
        entry.files.filter((f) => f.role === 'main')
          .every((f) => f.includes && f.includes.includes('noaten.ily'));
      L.record(results, '13. Fichier .ily conservé comme source auxiliaire, table includes sur les deux pièces', pageName,
        stored ? 'OK' : 'ÉCHEC', JSON.stringify(entry));

      const p1 = await probe(page);
      await page.click('#transport-play');
      await page.waitForTimeout(700);
      const play1 = await page.evaluate(() => ({
        state: window.__musicaPlaybackState().state,
        notes: window.__musicaAudio.getNotes().length,
      }));
      L.record(results, '13. Première pièce : notes et lecture', pageName,
        p1.midiBytes > 0 && p1.marks > 0 && play1.state === 'playing' && play1.notes > 0 ? 'OK' : 'ÉCHEC',
        JSON.stringify({ p1, play1 }));

      await page.click('.nav-btn[data-action="next-mov"]');
      await page.waitForTimeout(1200);
      const p2 = await probe(page);
      await page.click('#transport-play');
      await page.waitForTimeout(700);
      const play2 = await page.evaluate(() => ({
        state: window.__musicaPlaybackState().state,
        notes: window.__musicaAudio.getNotes().length,
      }));
      L.record(results, '13. Deuxième pièce : notes et lecture', pageName,
        p2.midiBytes > 0 && p2.marks > 0 && p2.notes > 0 &&
        (p2.state === 'playing' || play2.state === 'playing') && play2.notes > 0 ? 'OK' : 'ÉCHEC',
        JSON.stringify({ p2, play2 }));

      // B. Réouverture depuis la bibliothèque : les auxiliaires restent liés.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await L.waitReady(page);
      const reopened = [];
      page.on('console', (msg) => {
        const match = msg.text().match(/^Source (\d+)\/(\d+) :/);
        if (match) reopened.push(match.slice(1).map(Number));
      });
      await openLibraryForTest(page);
      await page.click('#library-list .library-item:nth-child(1) .library-item-info');
      await L.waitFirstSvg(page, 180000);
      await L.waitBackgroundLoaded(page, 300000);
      await page.waitForTimeout(600);
      const p3 = await probe(page);
      L.record(results, '13. Réouverture de l’entrée : deux pièces reconstruites avec les includes', pageName,
        reopened.length === 2 && reopened.every((l) => l[1] === 2) && p3.marks > 0 && p3.midiBytes > 0 ? 'OK' : 'ÉCHEC',
        JSON.stringify({ reopened, p3 }));

      // C. Une ancienne entrée {xml} sans fichiers reste lisible.
      const xml = fs.readFileSync(LEGACY_XML, 'utf8');
      await page.evaluate((data) => new Promise((resolve, reject) => {
        const req = indexedDB.open('musica');
        req.onsuccess = () => {
          const tx = req.result.transaction('files', 'readwrite');
          tx.objectStore('files').put({
            id: 'legacy-entry', name: 'Ancienne entrée', xml: data, addedAt: Date.now() + 5000,
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }), xml);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await L.waitReady(page);
      await openLibraryForTest(page);
      await page.click('#library-list .library-item:nth-child(1) .library-item-info');
      await L.waitFirstSvg(page, 180000);
      const legacyInfo = await L.pageInfo(page);
      L.record(results, '13. Ancienne entrée {xml} : toujours ouverte', pageName,
        (legacyInfo.svgCount || 0) > 0 ? 'OK' : 'ÉCHEC', JSON.stringify(legacyInfo));

      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (dossier LilyPond)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '13. Dossier LilyPond (bouton dossier)', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // D. Un fichier seul reste un import simple, sans table d'inclusions.
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    const logs = sourceLogs(page);
    try {
      await L.waitReady(page);
      await L.importFile(page, path.join(DIR, 'partituer.ly'));
      await L.waitFirstSvg(page, 180000);
      await L.waitBackgroundLoaded(page, 300000);
      const entry = await dbEntry(page);
      const unchanged = logs.length === 1 && logs[0][1] === 1 && entry.files.length === 1 &&
        !entry.files[0].role && !entry.files[0].includes;
      L.record(results, '13. Fichier .ly seul : une source, aucune table includes', pageName,
        unchanged ? 'OK' : 'ÉCHEC', JSON.stringify({ logs, entry }));
      const relevant = L.summarize(errors);
      L.record(results, '6. Erreurs JS (fichier seul)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '13. Fichier .ly seul', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
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
  console.log('\n=== RÉSUMÉ S13 ===');
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  server.close();
})();
