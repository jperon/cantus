// Harnais de test Cantus — serveur local et aides Playwright.
// Aucun fichier de src/, pwa/ ni build.js n'est modifié par ces tests.
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PW = path.join(ROOT, 'node_modules/playwright');
const { chromium } = require(PW);

// Données de test stables, hors de tout répertoire temporaire de session.
const DATA = process.env.CANTUS_TEST_DATA || path.join(os.homedir(), '.local/share/cantus/test-data');
const FILES = {
  telemannXml: path.join(DATA, 'telemann/telemann-sonatas-for-two-recorders.xml'),
  bachXml: path.join(DATA, 'bach/Magnificat_Bach.xml'),
  bachMxl: path.join(DATA, 'downloads/Magnificat_Bach.mxl'),
  byrdMscz: path.join(DATA, 'downloads/Ave_Verum_Corpus_-_William_Byrd.mscz'),
  faureMscz: path.join(DATA, 'downloads/Cantique de Jean Racine - Fauré.mscz'),
  laFouleMxl: path.join(ROOT, 'La_foule.mxl'),
  magnificatDir: path.join(DATA, 'magnificat'),
  // Fichier réel du 1er mouvement du Magnificat de Bach (bug de boucle de
  // lecture signalé sur la version publiée 821b248).
  magnificatBachMscz: path.join(DATA, 'magnificat-bach/01- Magnificat.mscz'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
};

// Sert un dossier dist. Les requêtes sont journalisées pour diagnostiquer
// les tests hors ligne.
function startServer(dist = DIST, { log = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let rel = urlPath === '/' ? '/index.html' : urlPath;
    const file = path.normalize(path.join(dist, rel));
    if (!file.startsWith(dist)) {
      res.writeHead(403);
      return res.end();
    }
    if (log) requests.push(urlPath);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function launch() {
  return chromium.launch({ executablePath: process.env.CHROMIUM });
}

// Langue des scénarios : leurs assertions portent sur les textes français.
// Elle est forcée par la préférence de l'application (localStorage), dans
// chaque contexte, pour ne dépendre ni de navigator.languages ni d'un
// rechargement. Un test qui vérifie la détection par le navigateur passe
// `language: null` à newPage et fournit un contexte à la locale voulue.
const TEST_LANGUAGE = 'fr';

async function forceLanguage(ctx, language = TEST_LANGUAGE) {
  await ctx.addInitScript((code) => {
    try {
      localStorage.setItem('musica-language', code);
    } catch (e) {
      // page sans localStorage (about:blank) : sans effet
    }
  }, language);
  return ctx;
}

// Ouvre une page et collecte les erreurs JS (pageerror + console.error)
async function newPage(browser, url, {
  pageName = 'index.html',
  viewport = { width: 500, height: 900 },
  context,
  language = TEST_LANGUAGE,
} = {}) {
  const ctx = context || await browser.newContext({ viewport });
  if (language) await forceLanguage(ctx, language);
  if (context) context.setDefaultTimeout?.(0);
  const page = await ctx.newPage();
  await page.setViewportSize(viewport);
  const errors = [];
  // Erreurs JS seules : un échec réseau (attendu hors ligne) n'en est pas une
  const netFailures = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + (e.stack || e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  page.on('requestfailed', (r) => {
    netFailures.push(`${r.url()} ${r.failure()?.errorText || ''}`);
  });
  const target = `${url}/${pageName}`;
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { page, ctx, errors, netFailures, target };
}

async function waitReady(page, timeout = 60000) {
  await page.waitForFunction(() => {
    const el = document.getElementById('overlay-loading');
    return el && el.classList.contains('hidden');
  }, null, { timeout });
}

// Attend le premier SVG affiché. Renvoie aussi l'état du chargement de fond
// au moment où le SVG apparaît.
async function waitFirstSvg(page, timeout = 120000) {
  const t0 = Date.now();
  await page.waitForSelector('#page-current .scroll-page svg', { timeout });
  const state = await page.evaluate(() => ({
    pageNumber: document.getElementById('page-number')?.textContent || '',
    backgroundLoading: !document.getElementById('loading-indicator')?.classList.contains('hidden'),
    svgCount: document.querySelectorAll('#page-current .scroll-page svg').length,
  }));
  return { ms: Date.now() - t0, ...state };
}

async function pageInfo(page) {
  return page.evaluate(() => {
    const txt = document.getElementById('page-number')?.textContent || '';
    const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
    const slot = document.getElementById('page-current');
    return {
      page: m ? parseInt(m[1], 10) : null,
      total: m ? parseInt(m[2], 10) : null,
      scrollTop: Math.round(slot.scrollTop),
      scrollHeight: slot.scrollHeight,
      clientHeight: slot.clientHeight,
      svgCount: slot.querySelectorAll('.scroll-page svg').length,
      loadingHidden: document.getElementById('loading-indicator')?.classList.contains('hidden'),
      overlayHidden: document.getElementById('overlay-loading')?.classList.contains('hidden'),
      importHidden: document.getElementById('import-section')?.classList.contains('hidden'),
      libraryHidden: document.getElementById('library-overlay')?.classList.contains('hidden'),
      errorText: document.getElementById('protocol-error')?.textContent || '',
      errorVisible: document.getElementById('protocol-error')?.style.display === 'block',
    };
  });
}

async function waitPage(page, expected, timeout = 60000) {
  await page.waitForFunction((p) => {
    const txt = document.getElementById('page-number')?.textContent || '';
    const m = txt.match(/(\d+)\s*\/\s*\d+/);
    return m && parseInt(m[1], 10) === p;
  }, expected, { timeout, polling: 200 });
}

async function waitTotalAtLeast(page, n, timeout = 300000) {
  await page.waitForFunction((minimum) => {
    const txt = document.getElementById('page-number')?.textContent || '';
    const m = txt.match(/\d+\s*\/\s*(\d+)/);
    return m && parseInt(m[1], 10) >= minimum;
  }, n, { timeout, polling: 300 });
}

async function waitBackgroundLoaded(page, timeout = 300000) {
  await page.waitForFunction(() => {
    const el = document.getElementById('loading-indicator');
    return el && el.classList.contains('hidden');
  }, null, { timeout, polling: 300 });
}

async function importFile(page, file) {
  await page.setInputFiles('#file-input', file);
}

async function importFiles(page, files) {
  await page.setInputFiles('#file-input', files);
}

async function importFolder(page, dir) {
  await page.setInputFiles('#folder-input', dir);
}

async function openLibrary(page) {
  const visible = await page.evaluate(() => !document.getElementById('library-overlay').classList.contains('hidden'));
  if (!visible) await page.click('#btn-library');
  await page.waitForFunction(() => !document.getElementById('library-overlay').classList.contains('hidden'), null, { timeout: 10000 });
  await page.waitForSelector('#library-list .library-item, #library-list .library-empty', { timeout: 10000 });
}

async function libraryEntries(page) {
  return page.$$eval('#library-list .library-item', (items) => items.map((it) => ({
    name: it.querySelector('.library-item-name')?.textContent?.trim(),
    meta: it.querySelector('.library-item-date')?.textContent?.trim(),
  })));
}

async function openLibraryEntry(page, index = 0) {
  await openLibrary(page);
  await page.click(`#library-list .library-item:nth-child(${index + 1}) .library-item-info`);
}

async function deleteLibraryEntry(page, index = 0) {
  await openLibrary(page);
  await page.click(`#library-list .library-item:nth-child(${index + 1}) .library-item-delete`);
  await page.waitForTimeout(300);
}

async function openSettings(page) {
  const visible = await page.evaluate(() => !document.getElementById('settings-overlay').classList.contains('hidden'));
  if (!visible) await page.click('#btn-settings');
  await page.waitForFunction(() => !document.getElementById('settings-overlay').classList.contains('hidden'), null, { timeout: 10000 });
}

async function closeSettings(page) {
  await page.click('#settings-close');
  await page.waitForFunction(() => document.getElementById('settings-overlay').classList.contains('hidden'), null, { timeout: 10000 });
}

async function staffHeights(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('#page-current .scroll-page svg');
    if (!svg) return null;
    return Array.from(svg.querySelectorAll('g.staff')).map((s) => Math.round(s.getBoundingClientRect().height * 100) / 100);
  });
}

async function partRows(page) {
  return page.$$eval('#parts-list label', (labels) => labels.map((l) => ({
    name: l.querySelector('span')?.textContent?.trim(),
    checked: l.querySelector('input')?.checked,
    disabled: l.querySelector('input')?.disabled,
    size: l.querySelector('select')?.value,
    sizeDisabled: l.querySelector('select')?.disabled,
  })));
}

// Marque le SVG affiché pour prouver qu'il n'est pas re-rendu.
async function markSvg(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('#page-current .scroll-page svg');
    if (!svg) return false;
    svg.setAttribute('data-test-mark', '1');
    return true;
  });
}

async function markerPresent(page) {
  return page.evaluate(() => !!document.querySelector('#page-current .scroll-page svg[data-test-mark="1"]'));
}

// État du défilement : positions des systèmes et des pages, en coordonnées
// de défilement du slot.
async function scrollState(page) {
  return page.evaluate(() => {
    const slot = document.getElementById('page-current');
    const base = slot.getBoundingClientRect().top - slot.scrollTop;
    const systems = [...slot.querySelectorAll('.scroll-page svg g.system')]
      .map((g) => Math.round((g.getBoundingClientRect().top - base) * 10) / 10);
    const pages = [...slot.querySelectorAll('.scroll-page')].map((d) => ({
      page: parseInt(d.dataset.page, 10),
      top: Math.round(d.getBoundingClientRect().top - base),
      hasSvg: !!d.querySelector('svg'),
    }));
    const txt = document.getElementById('page-number')?.textContent || '';
    const m = txt.match(/(\d+)\s*\/\s*(\d+)/);
    return {
      page: m ? parseInt(m[1], 10) : null,
      total: m ? parseInt(m[2], 10) : null,
      top: Math.round(slot.scrollTop),
      clientHeight: slot.clientHeight,
      scrollHeight: slot.scrollHeight,
      systems,
      pages,
    };
  });
}

async function resetScrollTop(page) {
  await page.evaluate(() => { document.getElementById('page-current').scrollTop = 0; });
  await page.waitForTimeout(300);
}

async function staffCount(page) {
  return page.evaluate(() => {
    const svg = document.querySelector('#page-current .scroll-page svg');
    return svg ? svg.querySelectorAll('g.staff').length : 0;
  });
}

async function tap(page, side) {
  const box = { x: side === 'left' ? 60 : 440, y: 450 };
  await page.mouse.click(box.x, box.y);
}

async function pressArrow(page, dir) {
  await page.keyboard.press(dir === 'right' ? 'ArrowRight' : 'ArrowLeft');
}

// Attend que la page affichée change (utile pour la navigation)
async function waitPageChange(page, from, timeout = 30000) {
  await page.waitForFunction((prev) => {
    const txt = document.getElementById('page-number')?.textContent || '';
    const m = txt.match(/(\d+)\s*\/\s*\d+/);
    return m && parseInt(m[1], 10) !== prev;
  }, from, { timeout, polling: 100 });
}

function summarize(errors) {
  // Les 404 de favicon n'ont pas d'incidence ; on garde tout le reste.
  return errors.filter((e) => !/favicon\.ico.*404|404.*favicon\.ico/i.test(e));
}

// Compteurs globaux du scénario courant : tout appel à record() en ÉCHEC
// rend le script fautif, même si le scénario a été interrompu proprement et
// que son IIFE se termine sans exception.
let assertions = 0;
let failures = 0;

function record(results, scenario, pageName, outcome, detail = '') {
  results.push({ scenario, page: pageName, outcome, detail });
  assertions++;
  if (outcome === 'ÉCHEC') failures++;
  const line = `[${outcome}] ${scenario} (${pageName})${detail ? ' — ' + detail : ''}`;
  console.log(line);
}

// Convention : un scénario sort en code 1 dès qu'une assertion a échoué.
// beforeExit laisse le temps aux sorties console de se vider (et à
// browser.close()/server.close() de finir) ; on ne masque pas un code déjà
// non nul (crash, exception non gérée).
process.on('beforeExit', (code) => {
  if (failures > 0 && code === 0) {
    console.error(`\n${failures} assertion(s) en échec sur ${assertions} : code de sortie 1.`);
    process.exitCode = 1;
  }
});

// Bilan du scénario, écrit de façon SYNCHRONE dans le descripteur 1 : il
// part même si le processus appelle process.exit() juste après, et il ne
// dépend pas du vidage asynchrone de stdout (tube de run.sh). run.sh relit
// ce nombre et le compare aux lignes [OK]/[ÉCHEC]/[SAUTÉ] du journal : un
// écart signale une sortie perdue, une assertion non journalisée ou une
// renumérotation de la campagne. Convention : une assertion = une ligne.
const SCRIPT = path.basename(process.argv[1] || 'scénario');
process.on('exit', (code) => {
  const line = `=== BILAN ${SCRIPT} : ${assertions} assertion(s), ${failures} échec(s) ===\n`;
  try {
    fs.writeSync(1, line);
  } catch (e) {
    // descripteur déjà fermé : rien à sauver
  }
  if (failures > 0 && code === 0) process.exitCode = 1;
});

module.exports = {
  ROOT, DIST, DATA, FILES, TEST_LANGUAGE, startServer, launch, newPage, forceLanguage,
  waitReady, waitFirstSvg, pageInfo, waitPage, waitTotalAtLeast,
  waitBackgroundLoaded, importFile, importFiles, importFolder,
  openLibrary, libraryEntries, openLibraryEntry, deleteLibraryEntry,
  openSettings, closeSettings, staffHeights, partRows,
  markSvg, markerPresent, tap, pressArrow, waitPageChange,
  scrollState, resetScrollTop, staffCount,
  summarize, record,
  stats: () => ({ assertions, failures }),
};
