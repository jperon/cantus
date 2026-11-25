// Génération des captures d'écran de la PWA (pwa/screenshots/).
//
// Le build appelle ce module avec --screenshots ; les images sont toujours
// régénérées, jamais conservées parce qu'elles existent déjà. L'application
// est servie depuis dist/ par un petit serveur local (port libre, query string
// ignorée) et pilotée dans Chromium headless uniquement.
//
// La partition vient du lot libre CC0 tests/fixtures/alde-friezen : les trois
// fichiers LilyPond sont importés comme un dossier (partituer.ly est la pièce
// affichée, fideo.ly et noaten.ily restent dans la même entrée).
const { chromium } = require('playwright');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const SCREENSHOTS_DIR = path.join(ROOT, 'pwa', 'screenshots');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'alde-friezen');
// Les trois fichiers de la fixture : les deux .ly et l'auxiliaire partagé.
// LICENSE (CC0) n'est pas un fichier de partition.
const FIXTURE_FILES = ['fideo.ly', 'noaten.ily', 'partituer.ly'];
const MASTER_FILE = 'partituer.ly';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function startServer() {
  const server = http.createServer((req, res) => {
    // Les paramètres d'URL (?file=…) ne désignent pas de fichier local.
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.normalize(path.join(DIST_DIR, rel));
    if (!file.startsWith(DIST_DIR + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('403');
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function newContext(browser, viewport) {
  const context = await browser.newContext({
    viewport,
    locale: 'en-US',
    serviceWorkers: 'block',
  });
  // Langue de l'interface et thème clair avant tout chargement. Le surlignage
  // de la mesure est activé pour la capture de lecture ; il reste sans effet
  // sur les autres captures.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('musica-language', 'en');
      localStorage.setItem('musica-settings', JSON.stringify({
        theme: 'white',
        highlightMeasure: true,
      }));
    } catch (e) {
      // pas de localStorage : l'anglais reste la langue de repli
    }
  });
  return context;
}

// L'upload de répertoire de Playwright (setInputFiles sur #folder-input) ne
// remplit pas l'input webkitdirectory avec le Chromium fourni. On y dépose les
// trois fichiers avec leur chemin relatif, ce qui déclenche le même
// handleFolderImport que le bouton « Open a folder ».
async function importFixtureFolder(page) {
  const files = FIXTURE_FILES.map((name) => ({
    name,
    relativePath: `alde-friezen/${name}`,
    base64: fs.readFileSync(path.join(FIXTURE_DIR, name)).toString('base64'),
  }));
  await page.evaluate((entries) => {
    const input = document.getElementById('folder-input');
    const transfer = new DataTransfer();
    for (const entry of entries) {
      const bytes = Uint8Array.from(atob(entry.base64), (char) => char.charCodeAt(0));
      const file = new File([bytes], entry.name, { type: 'text/plain' });
      Object.defineProperty(file, 'webkitRelativePath', { value: entry.relativePath });
      transfer.items.add(file);
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, files);
}

// Attend le rendu réel : premier SVG, chargement de fond terminé et au moins
// une mesure gravée, sans délai fixe.
async function waitForRenderedScore(page, timeout = 180000) {
  await page.waitForFunction(
    () => document.getElementById('overlay-loading')?.classList.contains('hidden'),
    null, { timeout, polling: 100 });
  await page.waitForSelector('#page-current .scroll-page svg', { timeout });
  await page.waitForFunction(
    () => document.getElementById('loading-indicator')?.classList.contains('hidden'),
    null, { timeout, polling: 200 });
  // Toutes les sources du dossier sont converties et chargées : la liste des
  // mouvements et leurs nombres de pages sont alors définitifs.
  await page.waitForFunction(
    () => typeof allSourcesLoaded === 'undefined' || allSourcesLoaded === true,
    null, { timeout, polling: 200 });
  await page.waitForFunction(() => {
    const svg = document.querySelector('#page-current .scroll-page svg');
    return !!svg && svg.querySelectorAll('g.measure').length > 0;
  }, null, { timeout, polling: 200 });
}

// Index du mouvement (dans le tableau global) qui vient de partituer.ly, et
// page globale où il commence.
async function masterMovementStart(page) {
  return page.evaluate((master) => {
    if (typeof currentSources === 'undefined' || typeof movements === 'undefined') return null;
    const sourceIndex = currentSources.findIndex((source) => new RegExp(`${master}$`, 'i').test(source.name || ''));
    if (sourceIndex < 0) return null;
    let start = 1;
    for (const movement of movements) {
      if (movement.sourceIndex === sourceIndex) return { index: movement.id, start };
      start += movement.pageCount || 0;
    }
    return null;
  }, MASTER_FILE);
}

async function showMasterPiece(page) {
  const target = await masterMovementStart(page);
  if (!target) {
    throw new Error(`${MASTER_FILE} introuvable après l'import du dossier`);
  }
  const pageNumber = () => page.evaluate(() => {
    const text = document.getElementById('page-number')?.textContent || '';
    const match = text.match(/(\d+)\s*\/\s*\d+/);
    return match ? parseInt(match[1], 10) : null;
  });
  let current = await pageNumber();
  while (current !== null && current < target.start) {
    await page.click('.nav-btn[data-action="next-mov"]');
    await page.waitForFunction((wanted) => {
      const text = document.getElementById('page-number')?.textContent || '';
      const match = text.match(/(\d+)\s*\/\s*\d+/);
      return match && parseInt(match[1], 10) === wanted;
    }, target.start, { timeout: 30000, polling: 100 });
    await waitForRenderedScore(page);
    current = await pageNumber();
  }
  const displayed = await page.evaluate(() => {
    if (typeof currentSources === 'undefined' || typeof movements === 'undefined' ||
        typeof getCurrentMovementIndex !== 'function') return null;
    const movement = movements[getCurrentMovementIndex()];
    return movement ? currentSources[movement.sourceIndex]?.name || null : null;
  });
  if (displayed && !new RegExp(`${MASTER_FILE}$`, 'i').test(displayed)) {
    throw new Error(`partition affichée inattendue : ${displayed}`);
  }
}

async function openSettings(page) {
  await page.click('#btn-menu');
  await page.waitForSelector('#command-menu:not(.hidden)', { timeout: 10000 });
  await page.click('#menu-settings');
  await page.waitForFunction(
    () => !document.getElementById('settings-overlay').classList.contains('hidden'),
    null, { timeout: 10000, polling: 100 });
  await page.evaluate(() => { document.getElementById('settings-overlay').scrollTop = 0; });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// Aucune notification, erreur ou chargement visible au moment de la capture.
async function visibleNotices(page) {
  return page.evaluate(() => {
    const hidden = (id) => {
      const el = document.getElementById(id);
      if (!el) return true;
      const style = getComputedStyle(el);
      return el.classList.contains('hidden') || style.display === 'none' || style.visibility === 'hidden';
    };
    const overlayError = document.getElementById('overlay-error');
    const protocolError = document.getElementById('protocol-error');
    const storageMessage = document.getElementById('storage-message');
    return {
      loadingOverlay: !hidden('overlay-loading'),
      loadingIndicator: !hidden('loading-indicator'),
      errorOverlay: !hidden('overlay-error') &&
        !!(overlayError?.classList.contains('visible') || getComputedStyle(overlayError).display !== 'none'),
      protocolError: !!protocolError && getComputedStyle(protocolError).display !== 'none',
      storageMessage: !!storageMessage && getComputedStyle(storageMessage).display !== 'none',
      transcription: !!document.getElementById('transcription-notice') &&
        getComputedStyle(document.getElementById('transcription-notice')).display !== 'none',
    };
  });
}

async function assertClean(page, { bar = false, settings = false } = {}) {
  const notices = await visibleNotices(page);
  if (notices.loadingOverlay || notices.loadingIndicator) {
    throw new Error(`chargement encore visible : ${JSON.stringify(notices)}`);
  }
  if (notices.errorOverlay || notices.protocolError || notices.storageMessage || notices.transcription) {
    throw new Error(`notification ou erreur visible : ${JSON.stringify(notices)}`);
  }
  const state = await page.evaluate(() => ({
    language: window.__musicaI18n?.language?.(),
    htmlLang: document.documentElement.lang,
    dark: document.body.classList.contains('theme-dark'),
    sepia: document.body.classList.contains('theme-sepia'),
    barHidden: document.getElementById('command-bar')?.classList.contains('hidden') ?? true,
    settingsHidden: document.getElementById('settings-overlay')?.classList.contains('hidden') ?? true,
    headings: Array.from(document.querySelectorAll('#settings-header h2')).map((el) => el.textContent.trim()),
  }));
  if (state.language !== 'en' || state.htmlLang !== 'en') {
    throw new Error(`interface non anglaise : ${JSON.stringify(state)}`);
  }
  if (state.dark || state.sepia) {
    throw new Error(`thème non clair : ${JSON.stringify(state)}`);
  }
  if (bar && state.barHidden) {
    throw new Error('barre du bas masquée alors que le suivi de lecture la maintient');
  }
  if (settings) {
    if (state.settingsHidden) throw new Error('panneau Settings non ouvert');
    if (!state.headings.includes('Settings')) {
      throw new Error(`titre Settings absent : ${JSON.stringify(state.headings)}`);
    }
  }
}

async function screenshot(page, name) {
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, name), fullPage: false });
  console.log(`  -> pwa/screenshots/${name}`);
}

async function captureMobile(browser, url) {
  const viewport = { width: 390, height: 844 };
  const context = await newContext(browser, viewport);
  try {
    const page = await context.newPage();
    await page.goto(`${url}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await importFixtureFolder(page);
    await waitForRenderedScore(page);
    await showMasterPiece(page);
    await assertClean(page, { bar: true });
    await screenshot(page, 'mobile-1.png');

    await openSettings(page);
    await assertClean(page, { settings: true });
    await screenshot(page, 'mobile-2.png');
  } finally {
    await context.close();
  }
}

async function captureDesktop(browser, url) {
  const context = await newContext(browser, { width: 1280, height: 720 });
  try {
    const page = await context.newPage();
    await page.goto(`${url}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await importFixtureFolder(page);
    await waitForRenderedScore(page);
    await showMasterPiece(page);

    // Lecture audio : le bouton reste visible dans la barre du bas. Le
    // surlignage est utilisé s'il apparaît ; sinon la partition est capturée
    // simplement affichée pendant la lecture.
    await page.click('#transport-play');
    await page.waitForFunction(
      () => window.__musicaPlaybackState?.().state === 'playing',
      null, { timeout: 60000, polling: 100 });
    let highlighted = false;
    try {
      await page.waitForSelector('#page-current .measure-highlight', { timeout: 15000 });
      highlighted = true;
    } catch (e) {
      console.warn('  Surlignage de la mesure indisponible, capture sans surlignage.');
    }
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await assertClean(page, { bar: true });
    await screenshot(page, 'desktop-1.png');
    console.log(`  Lecture audio ${highlighted ? 'avec mesure surlignée' : 'sans surlignage'}`);
  } finally {
    await context.close();
  }
}

async function generateScreenshots() {
  console.log('📸 Génération des captures PWA (Chromium headless)...');
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error('dist/index.html introuvable : construire avant de générer les captures');
  }
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const { server, url } = await startServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM || undefined,
  });
  try {
    await captureMobile(browser, url);
    await captureDesktop(browser, url);
    console.log('✅ Captures générées.');
  } catch (error) {
    process.exitCode = 1;
    console.error('❌ Échec de la génération des captures :', error);
    throw error;
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (require.main === module) {
  generateScreenshots().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = { generateScreenshots };
