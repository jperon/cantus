const fs = require('fs');
const path = require('path');
const pug = require('pug');
const CoffeeScript = require('coffeescript');
const esbuild = require('esbuild');
const { generateScreenshots } = require('./tools/screenshots');

const SRC = path.join(__dirname, 'src');
const PWA = path.join(__dirname, 'pwa');
const DIST = path.join(__dirname, 'dist');
const VEROVIO_TOOLKIT = path.join(__dirname, '..', 'partitura', 'verovio-toolkit-wasm.js');
// Paquet wasm scoretk (import MuseScore et autres formats), produit par le
// projet ../musescore. Seule la variante classic est utilisée dans le worker.
const SCORETK_CLASSIC = path.join(
  process.env.SCORETK_PKG || path.join(__dirname, '..', 'musescore', 'result'),
  'classic'
);
// Échantillons General MIDI du moteur natif (tools/build-samples.py) :
// un manifeste JSON et un Ogg Vorbis par programme.
const SAMPLES_SRC = path.join(PWA, 'samples');
const SAMPLES_MANIFEST = path.join(SAMPLES_SRC, 'manifest.json');

// Formats importables : src/formats.coffee est la seule source (extensions,
// `from` scoretk, types MIME). Le module y est évalué en CommonJS pour calculer
// l'attribut `accept` et le manifeste, et compilé pour le navigateur.
function loadFormats() {
  const js = CoffeeScript.compile(readSrc('formats.coffee'), { bare: true });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', js)(mod, mod.exports);
  return mod.exports;
}

function importAccept(formats, scoretkAvailable) {
  // Sans doublon : gabc est à la fois direct et scoretk.
  const extensions = [...new Set(formats.baseExtensions.concat(
    scoretkAvailable ? formats.scoretkExtensions : []
  ))];
  return extensions.map((ext) => `.${ext}`).join(',');
}

// Noms des caches de rendu préservés par le service worker : ils sont lus dans
// les modules qui les possèdent (CACHE_NAME), pour qu'il n'y ait qu'une valeur
// par cache. Lève une erreur si un module ne déclare plus CACHE_NAME.
function preservedCacheNames() {
  return ['svgCache.coffee', 'playbackCache.coffee'].map((file) => {
    const match = readSrc(file).match(/^[ \t]*CACHE_NAME = "([^"]+)"/m);
    if (!match) {
      throw new Error(`CACHE_NAME introuvable dans src/${file}`);
    }
    return match[1];
  });
}

// Minification (désactivée en --watch ou --no-minify pour déboguer)
const MINIFY = !process.argv.includes('--watch') && !process.argv.includes('--no-minify');
const minify = (js) => MINIFY ? esbuild.transformSync(js, { minify: true }).code : js;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readSrc(file) {
  return fs.readFileSync(path.join(SRC, file), 'utf-8');
}

// Police de texte des partitions. Verovio grave les paroles avec les métriques
// de Times ; sur Android, « Times » est absent et la police de repli (Noto
// Serif) est plus large, d'où des syllabes qui se chevauchent. On embarque
// donc la police dans le CSS (build normal et SPA), pour que tous les appareils
// utilisent les mêmes métriques que celles prévues par Verovio.
const SERIF_FONT = path.join(PWA, 'fonts', 'CantusSerif-Regular.woff');
let cssCache = null;

function readCss() {
  if (cssCache) return cssCache;
  let css = readSrc('styles.css');
  if (css.includes('__CANTUS_SERIF_WOFF__')) {
    if (!fs.existsSync(SERIF_FONT)) {
      throw new Error(`Police introuvable : ${SERIF_FONT}`);
    }
    const b64 = fs.readFileSync(SERIF_FONT).toString('base64');
    css = css.replaceAll('__CANTUS_SERIF_WOFF__', `data:font/woff;base64,${b64}`);
  }
  cssCache = css;
  return css;
}

function compileCoffee(file) {
  const src = readSrc(file);
  return CoffeeScript.compile(src, { bare: true });
}

// Sources de l'application principale, dans l'ordre de concaténation. Le
// découpage est purement physique : les fichiers sont mis bout à bout puis
// compilés en un seul programme (bare: true), donc une portée globale unique et
// aucune frontière de module. L'ordre est celui du monolithe d'origine et il est
// significatif : les initialisations exécutées au chargement (écouteurs,
// appels, état global) et le câblage final d'init.coffee en dépendent. Pour
// ajouter du code, le placer dans le fichier thématique correspondant ; pour
// créer un fichier, l'insérer ici à sa place dans l'ordre du chargement.
const APP_SOURCES = [
  'demarrage.coffee',              // PWA, service worker, date de build
  'etat.coffee',                   // état global, répartiteur des messages worker
  'langue.coffee',                 // langue de l'interface, textes data-i18n
  'pages-lecture.coffee',          // pages SVG et données de lecture (caches)
  'transport-suivi.coffee',        // transport audio et suivi du défilement
  'reglages-voix.coffee',          // réglages, voix, variantes de cache
  'affichage-navigation.coffee',   // affichage des pages, défilement, navigation
  'decoupage-xml.coffee',          // découpage MusicXML, masquage et tailles
  'gregorien.coffee',              // import gabc et notation carrée (exsurge)
  'sources.coffee',                // conversion scoretk, chargement des sources
  'bibliotheque-import.coffee',    // bibliothèque, tap, import de fichiers
  'reglages-ui.coffee',            // panneau de réglages
  'export.coffee',                 // dialogue et téléchargement de l'export
  'integration.coffee',            // stockage, protocole, URL, partage
  'init.coffee',                   // câblage DOMContentLoaded
];

// Contenu de l'application d'origine : concaténation sans séparateur ajouté, les
// fichiers se terminant chacun par un saut de ligne.
function readAppSource() {
  return APP_SOURCES.map((file) => readSrc(path.join('app', file))).join('');
}

function compileApp() {
  return CoffeeScript.compile(readAppSource(), { bare: true });
}

// Internationalisation : le module puis un dictionnaire par langue. Les
// dictionnaires s'enregistrent au chargement dans l'api du module, dans cet
// ordre (anglais d'abord, langue de référence). Pour ajouter une langue, créer
// src/i18n/<code>.coffee et l'ajouter ici.
const I18N_SOURCES = [
  'i18n.coffee',
  path.join('i18n', 'en.coffee'),
  path.join('i18n', 'fr.coffee'),
  path.join('i18n', 'es.coffee'),
  path.join('i18n', 'it.coffee'),
  path.join('i18n', 'de.coffee'),
];

function readI18nSource() {
  return I18N_SOURCES.map(readSrc).join('');
}

function compileI18n() {
  return CoffeeScript.compile(readI18nSource(), { bare: true });
}

function prepareDist() {
  ensureDir(DIST);
  ensureDir(path.join(DIST, 'icons'));
  ensureDir(path.join(DIST, 'screenshots'));
}

function verovioToolkit() {
  if (!fs.existsSync(VEROVIO_TOOLKIT)) {
    throw new Error('Partitura verovio-toolkit-wasm.js not found; run npm install or update the path.');
  }
  return VEROVIO_TOOLKIT;
}

function readFflate() {
  console.log('  Reading fflate...');
  const src = fs.readFileSync(path.join(__dirname, 'node_modules', 'fflate', 'umd', 'index.js'), 'utf-8');
  return minify(`(function(){${src}; window.__fflate = fflate;})()`);
}

// exsurge (notation carrée gabc) : MIT, bundle UMD exposant le global
// `exsurge`. Copié dans dist/ pour la PWA, inliné dans spa.html.
const EXSURGE_DIST = path.join(__dirname, 'node_modules', 'exsurge-ts', 'dist', 'exsurge.min.js');

function copyExsurge() {
  if (!fs.existsSync(EXSURGE_DIST)) {
    throw new Error(`exsurge introuvable : ${EXSURGE_DIST} (lancer npm install)`);
  }
  console.log('  Copying exsurge...');
  const dest = path.join(DIST, 'exsurge.min.js');
  fs.rmSync(dest, { force: true });
  fs.copyFileSync(EXSURGE_DIST, dest);
  fs.chmodSync(dest, 0o644);
  console.log('  -> dist/exsurge.min.js');
}

function readExsurge() {
  if (!fs.existsSync(EXSURGE_DIST)) {
    throw new Error(`exsurge introuvable : ${EXSURGE_DIST} (lancer npm install)`);
  }
  return fs.readFileSync(EXSURGE_DIST, 'utf-8');
}

// Copie le paquet scoretk dans dist/scoretk ; renvoie false s'il est absent
function copyScoretk() {
  if (!fs.existsSync(SCORETK_CLASSIC)) {
    console.warn(`  Attention : ${SCORETK_CLASSIC} introuvable, import MuseScore/LilyPond/ABC/MIDI désactivé`);
    return false;
  }
  console.log('  Copying scoretk...');
  ensureDir(path.join(DIST, 'scoretk'));
  for (const file of fs.readdirSync(SCORETK_CLASSIC)) {
    // Seuls le JS et le wasm servent au navigateur
    if (!file.endsWith('.js') && !file.endsWith('.wasm')) continue;
    const dest = path.join(DIST, 'scoretk', file);
    // Le paquet vient du store Nix, en lecture seule : une destination
    // existante et en lecture seule ferait échouer la copie (EACCES)
    fs.rmSync(dest, { force: true });
    fs.copyFileSync(path.join(SCORETK_CLASSIC, file), dest);
    fs.chmodSync(dest, 0o644);
  }
  console.log('  -> dist/scoretk');
  return true;
}

// Sources du paquet scoretk pour le SPA (tout est inliné dans la page) : le
// glue no-modules et le .wasm, tous deux évalués dans le worker.
function readScoretk() {
  if (!fs.existsSync(SCORETK_CLASSIC)) {
    console.warn(`  Attention : ${SCORETK_CLASSIC} introuvable, import MuseScore/LilyPond/ABC/MIDI désactivé`);
    return null;
  }
  const read = (file) => fs.readFileSync(path.join(SCORETK_CLASSIC, file), 'utf-8');
  console.log('  Reading scoretk...');
  return {
    glue: read('scoretk_wasm.js'),
    wasm: fs.readFileSync(path.join(SCORETK_CLASSIC, 'scoretk_wasm_bg.wasm')).toString('base64'),
  };
}

// Copie les échantillons dans dist/samples ; renvoie la liste des fichiers
// copiés (diagnostic). Absents, le build reste valide : le moteur audio se
// rabat sur l'oscillateur.
function copySamples() {
  ensureDir(path.join(DIST, 'samples'));
  // Dossiers des anciens moteurs : retirés de dist pour ne pas rester
  // accessibles après une mise à jour.
  fs.rmSync(path.join(DIST, 'soundfonts'), { recursive: true, force: true });
  if (!fs.existsSync(SAMPLES_MANIFEST)) {
    console.warn(`  Attention : ${SAMPLES_MANIFEST} introuvable, échantillons audio désactivés`);
    return [];
  }
  console.log('  Copying samples...');
  const manifest = JSON.parse(fs.readFileSync(SAMPLES_MANIFEST, 'utf-8'));
  const files = ['samples/manifest.json'];
  for (const entry of Object.values(manifest.programs || {})) {
    if (!entry.file) continue;
    const src = path.join(SAMPLES_SRC, entry.file);
    if (!fs.existsSync(src)) {
      throw new Error(`Échantillon manquant : ${src}`);
    }
    const dest = path.join(DIST, 'samples', entry.file);
    fs.rmSync(dest, { force: true });
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o644);
    files.push(`samples/${entry.file}`);
  }
  fs.rmSync(path.join(DIST, 'samples', 'manifest.json'), { force: true });
  fs.copyFileSync(SAMPLES_MANIFEST, path.join(DIST, 'samples', 'manifest.json'));
  fs.chmodSync(path.join(DIST, 'samples', 'manifest.json'), 0o644);
  const size = files.reduce((sum, file) => {
    const full = path.join(DIST, file);
    return sum + (fs.existsSync(full) ? fs.statSync(full).size : 0);
  }, 0);
  console.log(`  -> dist/samples (${files.length} fichier(s), ${(size / 1024 / 1024).toFixed(2)} Mo)`);
  return files.map((file) => `./${file}`);
}

// Échantillons pour le SPA : manifeste et contenus inlinés (file:// interdit
// fetch). Le décodage reste paresseux, programme par programme.
function readSamplesForSpa() {
  if (!fs.existsSync(SAMPLES_MANIFEST)) {
    console.warn(`  Attention : ${SAMPLES_MANIFEST} introuvable, échantillons audio désactivés`);
    return { manifest: null, data: {} };
  }
  console.log('  Reading samples...');
  const manifestText = fs.readFileSync(SAMPLES_MANIFEST, 'utf-8');
  const manifest = JSON.parse(manifestText);
  const data = {};
  for (const [key, entry] of Object.entries(manifest.programs || {})) {
    if (!entry.file) continue;
    data[key] = fs.readFileSync(path.join(SAMPLES_SRC, entry.file)).toString('base64');
  }
  return { manifest, data };
}

// Le contenu d'un <script type="text/plain"> est du texte brut : un
// '</script' y fermerait la balise. L'échappement est sans effet sur le JS.
function escapeScript(source) {
  if (!/<\/script/i.test(source)) return source;
  console.warn("  Attention : '</script' échappé en '<\\/script' dans le HTML SPA");
  return source.replace(/<\/script/gi, '<\\/script');
}

function compileScripts() {
  console.log('  Compiling CoffeeScript files...');
  return {
    mxlJs: minify(compileCoffee('mxl.coffee')),
    storageJs: minify(compileCoffee('storage.coffee')),
    svgCacheJs: minify(compileCoffee('svgCache.coffee')),
    playbackCacheJs: minify(compileCoffee('playbackCache.coffee')),
    midiJs: minify(compileCoffee('midi.coffee')),
    formatsJs: minify(compileCoffee('formats.coffee')),
    timelineJs: minify(compileCoffee('timeline.coffee')),
    i18nJs: minify(compileI18n()),
    audioJs: minify(compileCoffee('audio.coffee')),
    playbackJs: minify(compileCoffee('playback.coffee')),
    workerJs: minify(compileCoffee('worker.coffee')),
    appJs: minify(compileApp()),
  };
}

// Manifeste : pwa/manifest.json est un modèle. Ses listes `accept` sont
// volontairement vides et régénérées ici depuis src/formats.coffee ; le reste
// (nom, icônes, share_target.action…) est recopié tel quel.
function buildManifest(formats) {
  const manifest = JSON.parse(fs.readFileSync(path.join(PWA, 'manifest.json'), 'utf-8'));
  for (const handler of manifest.file_handlers || []) {
    handler.accept = formats.fileHandlerAccept;
  }
  const files = manifest.share_target?.params?.files || [];
  for (const file of files) file.accept = formats.shareAccept;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// Remplace un marqueur du service worker compilé. Lève une erreur s'il a
// disparu : la valeur doit continuer de venir de src/formats.coffee.
function injectSw(source, marker, value) {
  if (!source.includes(marker)) {
    throw new Error(`« ${marker} » introuvable dans pwa/sw.coffee compilé`);
  }
  return source.replace(marker, () => value);
}

// Précache du service worker : le manifeste seulement. Les Ogg sont mis en
// cache à la demande (cacheFirst, /samples/ est un actif statique) : précacher
// 130 fichiers retarderait l'activation du SW, donc la lecture hors ligne.
function copySamplesAssetsFromDist() {
  const manifest = path.join(DIST, 'samples', 'manifest.json');
  return fs.existsSync(manifest) ? ['./samples/manifest.json'] : [];
}

function copyPwaFiles(buildDate, formats) {
  console.log('  Copying PWA files...');
  fs.writeFileSync(path.join(DIST, 'manifest.json'), buildManifest(formats));

  // Service worker : date de build comme version de cache (avant minification)
  console.log('  Compiling sw.coffee...');
  const swJs = CoffeeScript.compile(fs.readFileSync(path.join(PWA, 'sw.coffee'), 'utf-8'), { bare: true });
  const swWithVersion = swJs.replace("VERSION = 'dev'", `VERSION = '${buildDate}'`);
  // Caches de rendu préservés : noms injectés depuis les modules source
  const placeholder = 'PRESERVED_CACHES = []';
  if (!swWithVersion.includes(placeholder)) {
    throw new Error(`« ${placeholder} » introuvable dans pwa/sw.coffee compilé`);
  }
  const caches = JSON.stringify(preservedCacheNames());
  const swWithCaches = swWithVersion.replace(placeholder, () => `PRESERVED_CACHES = ${caches}`);
  // Échantillons audio facultatifs, précachés pour la lecture hors ligne.
  const sampleAssets = copySamplesAssetsFromDist();
  let swWithSamples = injectSw(swWithCaches, 'SAMPLE_ASSETS = []', `SAMPLE_ASSETS = ${JSON.stringify(sampleAssets)}`);
  // Formats importables : table MIME -> extension du nom de repli, et regex des
  // extensions à retirer pour nommer une entrée partagée (src/formats.coffee).
  const mimeExtensions = Object.fromEntries(
    Object.entries(formats.mimeExtensions).map(([type, ext]) => [type, `.${ext}`])
  );
  const shareExtRe = new RegExp(`\\.(${formats.extensions.join('|')})$`, 'i');
  let sw = injectSw(swWithSamples, 'MIME_EXTENSIONS = {}', `MIME_EXTENSIONS = ${JSON.stringify(mimeExtensions)}`);
  sw = injectSw(sw, 'SHARE_EXT_RE = null', `SHARE_EXT_RE = ${shareExtRe}`);
  fs.writeFileSync(path.join(DIST, 'sw.js'), minify(sw));

  const faviconSrc = path.join(PWA, 'favicon.ico');
  if (fs.existsSync(faviconSrc)) {
    fs.copyFileSync(faviconSrc, path.join(DIST, 'favicon.ico'));
  }

  const iconsDir = path.join(PWA, 'icons');
  if (fs.existsSync(iconsDir)) {
    for (const file of fs.readdirSync(iconsDir)) {
      if (file === 'favicon.ico') {
        fs.copyFileSync(path.join(iconsDir, file), path.join(DIST, file));
      } else {
        fs.copyFileSync(path.join(iconsDir, file), path.join(DIST, 'icons', file));
      }
    }
  }
}

function copyLegalFiles() {
  console.log('  Copying license files...');
  fs.copyFileSync(path.join(__dirname, 'LICENSE'), path.join(DIST, 'LICENSE'));
  fs.copyFileSync(path.join(__dirname, 'THIRD-PARTY.md'), path.join(DIST, 'THIRD-PARTY.md'));
}

function copyScreenshots(label = 'Copying screenshots...') {
  const screenshotsDir = path.join(PWA, 'screenshots');
  if (!fs.existsSync(screenshotsDir)) return;
  console.log(`  ${label}`);
  for (const file of fs.readdirSync(screenshotsDir)) {
    if (file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.jpeg')) {
      fs.copyFileSync(path.join(screenshotsDir, file), path.join(DIST, 'screenshots', file));
      console.log(`    -> dist/screenshots/${file}`);
    }
  }
}

async function build() {
  console.time('build');
  prepareDist();

  const buildDate = new Date().toISOString();

  // 1. Copy Partitura's Verovio toolkit bundle to dist
  console.log('  Copying Partitura Verovio toolkit...');
  fs.copyFileSync(verovioToolkit(), path.join(DIST, 'verovio-toolkit-wasm.js'));
  console.log('  -> dist/verovio-toolkit-wasm.js (partitura)');

  const scoretkAvailable = copyScoretk();
  copyExsurge();
  const sampleAssets = copySamples();
  const samplesAvailable = sampleAssets.length > 0;

  const fflateSetup = readFflate();
  const formats = loadFormats();
  const { mxlJs, storageJs, svgCacheJs, playbackCacheJs, midiJs, formatsJs, timelineJs, i18nJs, audioJs, playbackJs, workerJs, appJs } = compileScripts();

  // 10. Read CSS
  const css = readCss();

  // 11. Create worker setup script
  // Write worker to separate file and load via importScripts
  // Le worker a besoin du module timeline (slices, segments, syncMarks) et du
  // module formats (scoretkFrom) : ils sont injectés avant son code, comme
  // dans le build SPA.
  fs.writeFileSync(path.join(DIST, 'worker.js'), `${formatsJs}\n${timelineJs}\n${workerJs}`);
  const workerSetup = `
    (function() {
      var worker = new Worker('worker.js');
      window.__musicaWorker = worker;

      // The worker loads Verovio itself (importScripts)
      worker.postMessage({
        type: 'setVerovioUrl',
        url: 'verovio-toolkit-wasm.js'
      });
    })();
  `;

  // 12. Compile Pug
  console.log('  Compiling index.pug...');
  const html = pug.renderFile(path.join(SRC, 'index.pug'), {
    css,
    workerSetup,
    fflateSetup,
    mxlJs,
    storageJs,
    svgCacheJs,
    playbackCacheJs,
    midiJs,
    formatsJs,
    timelineJs,
    i18nJs,
    audioJs,
    playbackJs,
    appJs,
    buildDate,
    scoretkAvailable,
    samplesAvailable,
    importAccept: importAccept(formats, scoretkAvailable),
  });

  // 13. Write dist/index.html
  fs.writeFileSync(path.join(DIST, 'index.html'), html);
  const sizeMB = (fs.statSync(path.join(DIST, 'index.html')).size / 1024 / 1024).toFixed(1);
  console.log(`  -> dist/index.html (${sizeMB} MB)`);

  copyPwaFiles(buildDate, formats);
  copyLegalFiles();
  copyScreenshots();

  // Generate screenshots if they don't exist (only if --screenshots flag is passed)
  if (process.argv.includes('--screenshots')) {
    await generateScreenshots();
    copyScreenshots('Copying newly generated screenshots...');
  }

  console.timeEnd('build');
  console.log('Build complete.');
}

// Build SPA - single HTML file with everything inlined
async function buildSpa() {
  console.time('build-spa');
  prepareDist();

  const buildDate = new Date().toISOString();

  // 1. Read Verovio toolkit
  console.log('  Reading Verovio toolkit...');
  const verovioJs = fs.readFileSync(verovioToolkit(), 'utf-8');

  const fflateSetup = readFflate();
  const samples = readSamplesForSpa();
  const formats = loadFormats();
  const { mxlJs, storageJs, svgCacheJs, playbackCacheJs, midiJs, formatsJs, timelineJs, i18nJs, audioJs, playbackJs, workerJs, appJs } = compileScripts();
  const scoretkInline = readScoretk();
  const scoretkAvailable = !!scoretkInline;
  // exsurge est inliné en texte brut, évalué seulement au premier gabc.
  const exsurgeJs = escapeScript(readExsurge());

  // 4. Read CSS
  const css = readCss();

  // 5. Create worker with Verovio inlined (for SPA without blob: URL issues)
  // Inject Verovio code directly into worker
  let workerSource = `
// Inline Verovio for SPA mode
${verovioJs}

// Modules formats + timeline + code du worker
${formatsJs}
${timelineJs}
${workerJs}
  `;

  // Le worker va dans un <script type="text/js-worker"> : un </script dans son
  // contenu fermerait la balise.
  workerSource = escapeScript(workerSource);

  const workerSetup = `
    (function() {
      var workerCode = document.getElementById('worker-src').textContent;
      var blob = new Blob([workerCode], {type: 'application/javascript'});
      var workerUrl = URL.createObjectURL(blob);
      var worker = new Worker(workerUrl);
      window.__musicaWorker = worker;
      window.__musicaWorkerUrl = workerUrl;

      // Tell worker Verovio is already loaded (inline)
      worker.postMessage({type: 'verovioInline'});

      // scoretk (MuseScore, LilyPond, ABC, MIDI): glue and wasm are inlined too
      var scoretkGlue = document.getElementById('scoretk-wasm-src');
      if (scoretkGlue) {
        worker.postMessage({
          type: 'scoretkInline',
          glue: scoretkGlue.textContent,
          wasm: document.getElementById('scoretk-wasm-b64').textContent
        });
      }
    })();
  `;

  // 6. Compile Pug for SPA (no external references)
  console.log('  Compiling spa.pug...');
  const html = pug.renderFile(path.join(SRC, 'spa.pug'), {
    css,
    workerSource,
    workerSetup,
    fflateSetup,
    samplesManifest: samples.manifest ? escapeScript(JSON.stringify(samples.manifest)) : null,
    samplesData: samples.manifest ? escapeScript(JSON.stringify(samples.data)) : null,
    samplesAvailable: !!samples.manifest,
    mxlJs,
    storageJs,
    svgCacheJs,
    playbackCacheJs,
    midiJs,
    formatsJs,
    timelineJs,
    i18nJs,
    audioJs,
    playbackJs,
    appJs,
    buildDate,
    scoretkAvailable,
    scoretkInline,
    exsurgeJs,
    importAccept: importAccept(formats, scoretkAvailable),
  });

  // 8. Write dist/spa.html
  fs.writeFileSync(path.join(DIST, 'spa.html'), html);
  const sizeMB = (fs.statSync(path.join(DIST, 'spa.html')).size / 1024 / 1024).toFixed(1);
  console.log(`  -> dist/spa.html (${sizeMB} MB)`);

  copyExsurge();
  copyPwaFiles(buildDate, formats);
  copyLegalFiles();
  copyScreenshots();

  console.timeEnd('build-spa');
  console.log('SPA build complete.');
}

// Watch mode
if (process.argv.includes('--watch')) {
  const chokidar = require('chokidar');
  build().catch(console.error);
  console.log('\nWatching for changes...');
  chokidar.watch([SRC, PWA], { ignoreInitial: true }).on('all', (event, filePath) => {
    console.log(`\n[${event}] ${path.relative(__dirname, filePath)}`);
    try {
      build().catch(console.error);
    } catch (err) {
      console.error('Build error:', err.message);
    }
  });
} else if (process.argv.includes('--spa')) {
  buildSpa().catch(console.error);
} else {
  build().catch(console.error);
}
