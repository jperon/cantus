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
// Paquet wasm d'import MuseScore (mscz2xml), produit par le projet ../musescore
const MSCZ2XML_CLASSIC = path.join(
  process.env.MSCZ2XML_PKG || path.join(__dirname, '..', 'musescore', 'result-wasm'),
  'classic'
);

// Minification (désactivée en --watch ou --no-minify pour déboguer)
const MINIFY = !process.argv.includes('--watch') && !process.argv.includes('--no-minify');
const minify = (js) => MINIFY ? esbuild.transformSync(js, { minify: true }).code : js;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readSrc(file) {
  return fs.readFileSync(path.join(SRC, file), 'utf-8');
}

function compileCoffee(file) {
  const src = readSrc(file);
  return CoffeeScript.compile(src, { bare: true });
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

// Copie le paquet mscz2xml dans dist/mscz2xml ; renvoie false s'il est absent
function copyMscz2xml() {
  if (!fs.existsSync(MSCZ2XML_CLASSIC)) {
    console.warn(`  Attention : ${MSCZ2XML_CLASSIC} introuvable, import MuseScore désactivé`);
    return false;
  }
  console.log('  Copying mscz2xml...');
  ensureDir(path.join(DIST, 'mscz2xml'));
  for (const file of fs.readdirSync(MSCZ2XML_CLASSIC)) {
    fs.copyFileSync(path.join(MSCZ2XML_CLASSIC, file), path.join(DIST, 'mscz2xml', file));
  }
  console.log('  -> dist/mscz2xml');
  return true;
}

// Sources du paquet mscz2xml pour le SPA (tout est inliné dans la page)
function readMscz2xml() {
  if (!fs.existsSync(MSCZ2XML_CLASSIC)) {
    console.warn(`  Attention : ${MSCZ2XML_CLASSIC} introuvable, import MuseScore désactivé`);
    return null;
  }
  const read = (file) => fs.readFileSync(path.join(MSCZ2XML_CLASSIC, file), 'utf-8');
  console.log('  Reading mscz2xml...');
  return {
    wasmJs: read('mscz2xml_wasm.js'),
    wasm: fs.readFileSync(path.join(MSCZ2XML_CLASSIC, 'mscz2xml_wasm_bg.wasm')).toString('base64'),
  };
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
    workerJs: minify(compileCoffee('worker.coffee')),
    appJs: minify(compileCoffee('app.coffee')),
  };
}

function copyPwaFiles(buildDate) {
  console.log('  Copying PWA files...');
  fs.copyFileSync(path.join(PWA, 'manifest.json'), path.join(DIST, 'manifest.json'));

  // Service worker : date de build comme version de cache (avant minification)
  console.log('  Compiling sw.coffee...');
  const swJs = CoffeeScript.compile(fs.readFileSync(path.join(PWA, 'sw.coffee'), 'utf-8'), { bare: true });
  const swWithVersion = swJs.replace("VERSION = 'dev'", `VERSION = '${buildDate}'`);
  fs.writeFileSync(path.join(DIST, 'sw.js'), minify(swWithVersion));

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

  const msczAvailable = copyMscz2xml();

  const fflateSetup = readFflate();
  const { mxlJs, storageJs, svgCacheJs, workerJs, appJs } = compileScripts();

  // 10. Read CSS
  const css = readSrc('styles.css');

  // 11. Create worker setup script
  // Write worker to separate file and load via importScripts
  fs.writeFileSync(path.join(DIST, 'worker.js'), workerJs);
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
    appJs,
    buildDate,
    msczAvailable,
  });

  // 13. Write dist/index.html
  fs.writeFileSync(path.join(DIST, 'index.html'), html);
  const sizeMB = (fs.statSync(path.join(DIST, 'index.html')).size / 1024 / 1024).toFixed(1);
  console.log(`  -> dist/index.html (${sizeMB} MB)`);

  copyPwaFiles(buildDate);
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
  const { mxlJs, storageJs, svgCacheJs, workerJs, appJs } = compileScripts();
  const msczInline = readMscz2xml();
  const msczAvailable = !!msczInline;

  // 4. Read CSS
  const css = readSrc('styles.css');

  // 5. Create worker with Verovio inlined (for SPA without blob: URL issues)
  // Inject Verovio code directly into worker
  let workerSource = `
// Inline Verovio for SPA mode
${verovioJs}

// Worker code
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

      // MuseScore import: the wasm module is inlined too
      var msczWasmJs = document.getElementById('mscz2xml-wasm-src');
      if (msczWasmJs) {
        worker.postMessage({
          type: 'msczInline',
          wasmJs: msczWasmJs.textContent,
          wasm: document.getElementById('mscz2xml-wasm-b64').textContent
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
    mxlJs,
    storageJs,
    svgCacheJs,
    appJs,
    buildDate,
    msczAvailable,
    msczInline,
  });

  // 8. Write dist/spa.html
  fs.writeFileSync(path.join(DIST, 'spa.html'), html);
  const sizeMB = (fs.statSync(path.join(DIST, 'spa.html')).size / 1024 / 1024).toFixed(1);
  console.log(`  -> dist/spa.html (${sizeMB} MB)`);

  copyPwaFiles(buildDate);
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
