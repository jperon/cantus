// Scénario 8 — boucle de lecture entre le suivi et la cale de page.
// Lecture réelle d'une partition avec suivi actif : la position doit rester
// monotone croissante. Un retour en arrière signale une cale de page (seek)
// déclenchée par le déplacement du suivi lui-même, qui ramène la lecture sur
// la page précédente et boucle.
const path = require('path');
const L = require('./lib');

const PAGES = ['index.html'];
const PARTITION = path.join(
  process.env.HOME,
  'Musique/Partitions/Chorales/Bach_JS/Magnificat/01- Magnificat.mscz'
);
const DURATION_MS = Number(process.env.S8_MS) || 30000;  // > une page, < 60 s
const SAMPLE_MS = 500;
const MONOTONE_TOLERANCE_MS = 2000;  // (a) à 2 s près
const REWIND_TOLERANCE_MS = 1000;    // (b) retour arrière toléré

async function runPage(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  try {
    await L.waitReady(page);
    await L.importFile(page, PARTITION);
    const first = await L.waitFirstSvg(page, 180000);
    await L.waitBackgroundLoaded(page, 180000);
    await page.waitForTimeout(800);
    L.record(results, '8. Partition importée et première page rendue', pageName,
      first.svgCount > 0 ? 'OK' : 'ÉCHEC', `1er SVG en ${first.ms} ms`);

    // Suivi actif par défaut : on vérifie seulement qu'il est bien activé.
    const follow = await page.evaluate(() =>
      (JSON.parse(localStorage.getItem('musica-settings') || '{}').followPlayback) !== false);
    L.record(results, '8. Suivi automatique actif pendant la lecture', pageName,
      follow ? 'OK' : 'ÉCHEC', `followPlayback = ${follow}`);

    await page.click('#transport-play');
    await page.waitForFunction(
      () => window.__musicaPlaybackState?.().state === 'playing',
      null, { timeout: 30000, polling: 100 }
    );

    // Échantillonnage : position du moteur + page affichée.
    const samples = [];
    const t0 = Date.now();
    while (Date.now() - t0 < DURATION_MS) {
      const s = await page.evaluate(() => {
        const st = window.__musicaPlaybackState?.() || {};
        return { position: st.position, state: st.state };
      });
      samples.push({ at: Date.now() - t0, ...s });
      await page.waitForTimeout(SAMPLE_MS);
    }
    // Déplacement manuel d'une page vers l'arrière pendant la lecture : la
    // cale de page ne doit pas ramener la lecture en arrière (sinon la page
    // suivante la fait ré-avancer : c'est la boucle observée sur liseuse).
    const beforeBack = await page.evaluate(() => window.__musicaPlaybackState?.().position);
    await L.pressArrow(page, 'left');
    await page.waitForTimeout(1500);
    const afterBack = await page.evaluate(() => window.__musicaPlaybackState?.() || {});
    const backDrop = beforeBack - afterBack.position;
    L.record(results, "8. Recul de page pendant la lecture : pas de seek arrière", pageName,
      afterBack.state === 'playing' && backDrop <= REWIND_TOLERANCE_MS ? 'OK' : 'ÉCHEC',
      `position ${beforeBack} → ${afterBack.position} ms (recul ${backDrop} ms), état ${afterBack.state}`);

    await page.click('#transport-play');  // pause

    const positions = samples.map((s) => s.position);
    const progressed = positions[positions.length - 1] - positions[0];
    L.record(results, '8. La lecture progresse réellement pendant l’échantillonnage', pageName,
      progressed > 5000 ? 'OK' : 'ÉCHEC',
      `${samples.length} échantillons, position ${positions[0]} → ${positions[positions.length - 1]} ms`);

    let worstBack = 0;
    let worstBackAt = null;
    for (let i = 1; i < samples.length; i++) {
      const delta = samples[i].position - samples[i - 1].position;
      if (-delta > worstBack) {
        worstBack = -delta;
        worstBackAt = samples[i].at;
      }
    }
    L.record(results, '8. Aucun retour arrière > 1 s pendant la lecture', pageName,
      worstBack <= REWIND_TOLERANCE_MS ? 'OK' : 'ÉCHEC',
      `recul max ${worstBack} ms${worstBackAt === null ? '' : ` à ${worstBackAt} ms`}`);

    // (a) monotone croissante à 2 s près : aucun échantillon sous le précédent
    // de plus de MONOTONE_TOLERANCE_MS.
    let worstDrop = 0;
    for (let i = 1; i < samples.length; i++) {
      const delta = samples[i].position - samples[i - 1].position;
      if (-delta > worstDrop) worstDrop = -delta;
    }
    L.record(results, '8. Position monotone croissante à 2 s près', pageName,
      worstDrop <= MONOTONE_TOLERANCE_MS ? 'OK' : 'ÉCHEC',
      `chute max ${worstDrop} ms`);

    const relevant = L.summarize(errors);
    L.record(results, '8. Aucune erreur JS pendant la lecture', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '8. Boucle de lecture', pageName, 'ÉCHEC', 'exception du test : ' + e.message);
  }
  await ctx.close();
}

(async () => {
  const results = [];
  const { server, url } = await L.startServer();
  const browser = await L.launch();
  try {
    for (const pageName of PAGES) await runPage(browser, url, pageName, results);
  } catch (e) {
    console.log('ERREUR GÉNÉRALE', e.stack);
  }
  console.log('\n=== RÉSUMÉ S8 ===');
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  server.close();
})();
