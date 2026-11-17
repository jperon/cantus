// Scénario 7 — partage Android via share_target (POST multipart).
// Playwright ne peut pas déclencher le menu « Partager » d'Android : on envoie
// la même requête que lui depuis la page, le service worker actif l'intercepte
// exactement comme en production, puis on suit la redirection 303.
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const PAGES = ['index.html', 'spa.html'];
const FIXTURE = path.join(__dirname, 'fixtures', 'movements.xml');
const MSCZ = L.FILES.byrdMscz;

async function waitWorker(page) {
  await page.waitForFunction(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    return !!(r && r.active);
  }, null, { timeout: 30000, polling: 200 });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 30000, polling: 200 });
}

// Envoie un POST multipart vers ./share (comme Android) et renvoie l'URL finale
// après la redirection 303. Le GET final passe par le SW mais ne navigue pas.
async function shareFile(page, filePath, name, type) {
  const b64 = fs.readFileSync(filePath).toString('base64');
  return page.evaluate(async ({ b64, name, type }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const form = new FormData();
    form.append('file', new File([bytes], name, { type }));
    const response = await fetch('share', { method: 'POST', body: form });
    // Forcer la lecture du corps pour suivre la redirection jusqu'au GET.
    await response.text();
    return { status: response.status, url: response.url, type: response.type };
  }, { b64, name, type });
}

function sharedParam(url) {
  return new URL(url).searchParams.get('shared');
}

async function runPage(browser, url, pageName, results) {
  // --- partage d'un .musicxml valide ---
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await waitWorker(page);
      const sent = await shareFile(page, FIXTURE, 'movements.xml', 'application/xml');
      const token = sharedParam(sent.url);
      L.record(results, '7. POST multipart vers ./share : redirection 303 vers ?shared=<jeton>', pageName,
        sent.status === 200 && !!token ? 'OK' : 'ÉCHEC',
        `statut ${sent.status}, URL finale ${sent.url}`);

      await page.goto(sent.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await L.waitReady(page, 60000);
      const first = await L.waitFirstSvg(page, 120000);
      await L.waitTotalAtLeast(page, 3, 120000);
      const info = await L.pageInfo(page);
      const clean = !sharedParam(page.url());
      L.record(results, '7. Partage d’un .musicxml : partition ouverte, 3 pages', pageName,
        first.svgCount > 0 && info.total === 3 && clean ? 'OK' : 'ÉCHEC',
        `1er SVG en ${first.ms} ms, ${info.page}/${info.total}, URL ${page.url()}`);

      // Le nom de l'entrée vient du fichier partagé : visible dans la bibliothèque.
      let entries = [];
      try {
        await L.openLibrary(page);
        entries = await L.libraryEntries(page);
        await page.click('#library-close');
      } catch (e) { entries = [{ name: `(bibliothèque indisponible : ${e.message})` }]; }
      L.record(results, '7. Nom du fichier partagé conservé dans la bibliothèque', pageName,
        entries.some((e) => e.name === 'movements') ? 'OK' : 'ÉCHEC',
        JSON.stringify(entries.map((e) => e.name)));

      // Le jeton est consommé : un rechargement n'importe rien et l'URL reste propre.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await L.waitReady(page, 60000);
      await page.waitForTimeout(700);
      const after = await L.pageInfo(page);
      const reloadClean = !sharedParam(page.url());
      L.record(results, '7. Rechargement après partage : pas de réimport, URL sans ?shared', pageName,
        reloadClean && after.svgCount === 0 && !after.importHidden ? 'OK' : 'ÉCHEC',
        `URL ${page.url()}, SVG=${after.svgCount}, écran d’import affiché : ${!after.importHidden}`);

      const relevant = L.summarize(errors);
      L.record(results, '7. Erreurs JS (partage .musicxml)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '7. Partage d’un .musicxml', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // --- non-régression : protocole web+musicxml (?file=data:...) ---
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      const dataUrl = 'data:application/vnd.recordare.musicxml+xml;base64,' +
        fs.readFileSync(FIXTURE).toString('base64');
      await page.goto(`${url}/?file=${encodeURIComponent(dataUrl)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await L.waitReady(page, 60000);
      const first = await L.waitFirstSvg(page, 120000);
      await L.waitTotalAtLeast(page, 3, 120000);
      const info = await L.pageInfo(page);
      L.record(results, '7. Non-régression : ?file= (web+musicxml) ouvre toujours la partition', pageName,
        first.svgCount > 0 && info.total === 3 ? 'OK' : 'ÉCHEC',
        `1er SVG en ${first.ms} ms, ${info.page}/${info.total}`);
      const relevant = L.summarize(errors);
      L.record(results, '7. Erreurs JS (?file=)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '7. Non-régression ?file=', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }

  // --- fichier incompatible : message propre, pas d'écran cassé ---
  {
    const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
    try {
      await L.waitReady(page);
      await waitWorker(page);
      const tmp = path.join(require('os').tmpdir(), 'cantus-partage-incompatible.txt');
      fs.writeFileSync(tmp, 'ceci n’est pas une partition');
      const sent = await shareFile(page, tmp, 'notes.txt', 'text/plain');
      fs.rmSync(tmp, { force: true });
      await page.goto(sent.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await L.waitReady(page, 60000);
      await page.waitForFunction(() => document.getElementById('protocol-error')?.style.display === 'block',
        null, { timeout: 30000, polling: 200 });
      await page.waitForTimeout(500);
      const info = await L.pageInfo(page);
      const expected = /Aucun fichier compatible/.test(info.errorText);
      L.record(results, '7. Fichier incompatible refusé proprement (message + écran d’import)', pageName,
        expected && info.svgCount === 0 && !info.importHidden && info.loadingHidden ? 'OK' : 'ÉCHEC',
        `message « ${info.errorText} », SVG=${info.svgCount}, import affiché : ${!info.importHidden}, URL ${page.url()}`);
      const relevant = L.summarize(errors);
      L.record(results, '7. Erreurs JS (fichier incompatible)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    } catch (e) {
      L.record(results, '7. Fichier incompatible', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
    }
    await ctx.close();
  }
}

async function runMscz(browser, url, results) {
  if (!fs.existsSync(MSCZ)) {
    L.record(results, '7. Partage d’un .mscz (application/octet-stream)', 'index.html', 'SAUTÉ',
      `fichier de test absent : ${MSCZ}`);
    return;
  }
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName: 'index.html' });
  try {
    await L.waitReady(page);
    await waitWorker(page);
    // Type annoncé par la plupart des fournisseurs Android pour .mscz.
    const sent = await shareFile(page, MSCZ, path.basename(MSCZ), 'application/octet-stream');
    await page.goto(sent.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await L.waitReady(page, 60000);
    const first = await L.waitFirstSvg(page, 180000);
    await L.waitBackgroundLoaded(page, 180000);
    await page.waitForTimeout(700);
    const info = await L.pageInfo(page);
    L.record(results, '7. Partage d’un .mscz (application/octet-stream) : partition convertie', 'index.html',
      first.svgCount > 0 && info.total > 1 && !sharedParam(page.url()) ? 'OK' : 'ÉCHEC',
      `1er SVG en ${first.ms} ms, ${info.page}/${info.total}, URL ${page.url()}`);
    const relevant = L.summarize(errors);
    L.record(results, '7. Erreurs JS (partage .mscz)', 'index.html', relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '7. Partage d’un .mscz', 'index.html', 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

function checkManifest(results) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(L.DIST, 'manifest.json'), 'utf8'));
    const st = manifest.share_target || {};
    const files = st.params?.files;
    const ok = st.action === './share' && st.method === 'POST' &&
      st.enctype === 'multipart/form-data' && Array.isArray(files) && files.length === 1 &&
      files[0].name === 'file' && files[0].accept.includes('application/octet-stream') &&
      files[0].accept.includes('.mscz') && files[0].accept.includes('.mscx');
    L.record(results, '7. dist/manifest.json : share_target POST multipart, une seule entrée files', '-',
      ok ? 'OK' : 'ÉCHEC', JSON.stringify(st));
  } catch (e) {
    L.record(results, '7. dist/manifest.json', '-', 'ÉCHEC', e.message);
  }
}

(async () => {
  const results = [];
  checkManifest(results);
  const { server, url } = await L.startServer();
  const browser = await L.launch();
  try {
    for (const pageName of PAGES) await runPage(browser, url, pageName, results);
    await runMscz(browser, url, results);
  } catch (e) {
    console.log('ERREUR GÉNÉRALE', e.stack);
  }
  console.log('\n=== RÉSUMÉ S7 ===');
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  server.close();
})();
