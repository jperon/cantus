// Scénario 5 — build sans paquet mscz2xml (MSCZ2XML_PKG=/nonexistent) :
// le build doit réussir et l'import .mscz doit être refusé proprement.
// Le script reconstruit dist/ normalement à la fin.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./lib');

function build(args, env) {
  const r = spawnSync(process.execPath, ['build.js', ...args], {
    cwd: L.ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 180000,
  });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}

async function testPage(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  try {
    await L.waitReady(page, 90000);
    const flags = await page.evaluate(() => ({
      available: window.__musicaMsczAvailable,
      accept: document.getElementById('file-input').accept,
    }));
    await L.importFile(page, L.FILES.byrdMscz);
    await page.waitForFunction(() => document.getElementById('protocol-error')?.style.display === 'block', null, { timeout: 30000 });
    await page.waitForTimeout(800);
    const info = await L.pageInfo(page);
    const refused = /import MuseScore non disponible/.test(info.errorText) && info.svgCount === 0 && info.importHidden === false;
    L.record(results, '5. Build sans paquet : .mscz refusé proprement', pageName,
      flags.available === false && !/mscz/.test(flags.accept) && refused ? 'OK' : 'ÉCHEC',
      `__musicaMsczAvailable=${flags.available}, accept="${flags.accept}", message « ${info.errorText} », écran d'import affiché : ${!info.importHidden}, SVG=${info.svgCount}`);
    const relevant = L.summarize(errors);
    L.record(results, '6. Erreurs JS (build sans paquet)', pageName, relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '5. Build sans paquet : .mscz refusé proprement', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

(async () => {
  const results = [];
  const out = {};
  try {
    fs.rmSync(path.join(L.DIST, 'mscz2xml'), { recursive: true, force: true });
    const b1 = build([], { MSCZ2XML_PKG: '/nonexistent' });
    out.build = { status: b1.status, mentionsMissing: /introuvable/.test(b1.output) };
    const b2 = build(['--spa'], { MSCZ2XML_PKG: '/nonexistent' });
    out.buildSpa = { status: b2.status, mentionsMissing: /introuvable/.test(b2.output) };
    out.noDir = !fs.existsSync(path.join(L.DIST, 'mscz2xml'));
    L.record(results, '5. Build sans paquet mscz2xml : le build réussit', '-',
      b1.status === 0 && b2.status === 0 && out.build.mentionsMissing && out.noDir ? 'OK' : 'ÉCHEC',
      `build.js code ${b1.status} (paquet signalé introuvable : ${out.build.mentionsMissing}), build.js --spa code ${b2.status}, dist/mscz2xml absent : ${out.noDir}`);

    const { server, url } = await L.startServer();
    const browser = await L.launch();
    try {
      await testPage(browser, url, 'index.html', results);
      await testPage(browser, url, 'spa.html', results);
    } finally {
      await browser.close();
      server.close();
    }
  } catch (e) {
    L.record(results, '5. Build sans paquet', '-', 'ÉCHEC', 'exception du test : ' + e.message);
  } finally {
    // Restaure un dist normal pour les autres tests / l'usage courant
    out.restore = [build([], {}).status, build(['--spa'], {}).status];
  }
  console.log('\n=== RÉSUMÉ S5 ===');
  console.log(JSON.stringify({ results, out }, null, 1));
})();
