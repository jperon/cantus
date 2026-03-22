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

  // 1. Read Verovio toolkit (UMD, WASM inline)
  console.log('  Reading Verovio toolkit...');
  const verovioJs = fs.readFileSync(require.resolve('verovio'), 'utf-8');

  // 2. Compile worker.coffee -> JS
  console.log('  Compiling worker.coffee...');
  const workerJs = compileCoffee('worker.coffee');

  // 3. Build combined worker code: verovio UMD + worker logic
  //    The UMD sets globalThis.verovio which the worker code uses.
  const fullWorkerCode = verovioJs + '\n;\n' + workerJs;
  const workerB64 = Buffer.from(fullWorkerCode, 'utf-8').toString('base64');

  // 4. Build inline script that creates the worker from Blob URL
  const workerSetup = `
(function() {
  var workerCode = atob("${workerB64}");
  var blob = new Blob([workerCode], { type: "application/javascript" });
  var workerUrl = URL.createObjectURL(blob);
  window.__musicaWorker = new Worker(workerUrl);
})();
`;

  // 5. Compile app.coffee -> JS
  console.log('  Compiling app.coffee...');
  const appJs = compileCoffee('app.coffee');

  // 6. Read CSS
  const css = readSrc('styles.css');

  // 7. Compile Pug
  console.log('  Compiling index.pug...');
  const html = pug.renderFile(path.join(SRC, 'index.pug'), {
    css,
    workerSetup,
    appJs,
  });

  // 8. Write dist/index.html
  fs.writeFileSync(path.join(DIST, 'index.html'), html);
  const sizeMB = (fs.statSync(path.join(DIST, 'index.html')).size / 1024 / 1024).toFixed(1);
  console.log(`  -> dist/index.html (${sizeMB} MB)`);

  // 9. Copy PWA files
  console.log('  Copying PWA files...');
  fs.copyFileSync(path.join(PWA, 'manifest.json'), path.join(DIST, 'manifest.json'));
  fs.copyFileSync(path.join(PWA, 'sw.js'), path.join(DIST, 'sw.js'));

  const iconsDir = path.join(PWA, 'icons');
  if (fs.existsSync(iconsDir)) {
    for (const file of fs.readdirSync(iconsDir)) {
      fs.copyFileSync(path.join(iconsDir, file), path.join(DIST, 'icons', file));
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
