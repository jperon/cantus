const fs = require('fs');
const path = require('path');
const pug = require('pug');
const CoffeeScript = require('coffeescript');

const SRC = path.join(__dirname, 'src');
const PWA = path.join(__dirname, 'pwa');
const DIST = path.join(__dirname, 'dist');

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

function build() {
  console.time('build');
  ensureDir(DIST);
  ensureDir(path.join(DIST, 'icons'));

  const buildDate = new Date().toISOString();

  // 1. Copy Partitura's Verovio toolkit bundle to dist
  console.log('  Copying Partitura Verovio toolkit...');
  const partituraToolkit = path.join(__dirname, '..', 'partitura', 'verovio-toolkit-wasm.js');
  if (!fs.existsSync(partituraToolkit)) {
    throw new Error('Partitura verovio-toolkit-wasm.js not found; run npm install or update the path.');
  }
  fs.copyFileSync(partituraToolkit, path.join(DIST, 'verovio-toolkit-wasm.js'));
  console.log('  -> dist/verovio-toolkit-wasm.js (partitura)');

  // 5. Read fflate (for MXL/ZIP decompression)
  console.log('  Reading fflate...');
  const fflateSrc = fs.readFileSync(path.join(__dirname, 'node_modules', 'fflate', 'umd', 'index.js'), 'utf-8');
  const fflateSetup = `(function(){${fflateSrc}; window.__fflate = fflate;})()`;

  // 6. Compile mxl.coffee -> JS
  console.log('  Compiling mxl.coffee...');
  const mxlJs = compileCoffee('mxl.coffee');

  // 7. Compile storage.coffee -> JS
  console.log('  Compiling storage.coffee...');
  const storageJs = compileCoffee('storage.coffee');

  // 7b. Compile svgCache.coffee -> JS
  console.log('  Compiling svgCache.coffee...');
  const svgCacheJs = compileCoffee('svgCache.coffee');

  // 8. Compile worker.coffee -> JS
  console.log('  Compiling worker.coffee...');
  const workerJs = compileCoffee('worker.coffee');

  // 9. Compile app.coffee -> JS
  console.log('  Compiling app.coffee...');
  const appJs = compileCoffee('app.coffee');

  // 10. Read CSS
  const css = readSrc('styles.css');

  // 11. Create worker setup script
  // Write worker to separate file and load via importScripts
  fs.writeFileSync(path.join(DIST, 'worker.js'), workerJs);
  const workerSetup = `
    (function() {
      var worker = new Worker('worker.js');
      window.__musicaWorker = worker;
      worker.postMessage({type: 'setVerovioUrl', url: 'verovio-toolkit-wasm.js'});
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
  });

  // 13. Write dist/index.html
  fs.writeFileSync(path.join(DIST, 'index.html'), html);
  const sizeMB = (fs.statSync(path.join(DIST, 'index.html')).size / 1024 / 1024).toFixed(1);
  console.log(`  -> dist/index.html (${sizeMB} MB)`);

  // 12. Copy PWA files
  console.log('  Copying PWA files...');
  fs.copyFileSync(path.join(PWA, 'manifest.json'), path.join(DIST, 'manifest.json'));

  // Inject build date as cache version to force cache invalidation on updates
  const swSrc = fs.readFileSync(path.join(PWA, 'sw.js'), 'utf-8');
  const swWithVersion = swSrc.replace(
    "const CACHE_NAME = 'musica-v1';",
    `const CACHE_NAME = 'musica-${buildDate}';`
  );
  fs.writeFileSync(path.join(DIST, 'sw.js'), swWithVersion);
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

  console.timeEnd('build');
  console.log('Build complete.');
}

// Watch mode
if (process.argv.includes('--watch')) {
  const chokidar = require('chokidar');
  build();
  console.log('\nWatching for changes...');
  chokidar.watch([SRC, PWA], { ignoreInitial: true }).on('all', (event, filePath) => {
    console.log(`\n[${event}] ${path.relative(__dirname, filePath)}`);
    try {
      build();
    } catch (err) {
      console.error('Build error:', err.message);
    }
  });
} else {
  build();
}
