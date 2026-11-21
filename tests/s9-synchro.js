// Scénario 9 — le suivi visuel doit afficher la page de l'élément qui joue.
// Fichier réel à mesures multi-repos (Magnificat) : Verovio replie les mesures
// de silence et n'émet pas de measureOn pour elles. La page attendue est
// calculée indépendamment des marqueurs : on prend le xmlId de la mesure en
// cours et on lit la page du SVG qui la contient (repli sur la mesure
// précédente quand Verovio l'a repliée).
const L = require('./lib');

const PARTITION = L.FILES.magnificatBachMscz;
const FRACTIONS = [0.1, 0.3, 0.5, 0.7, 0.9];
const TOLERANCE = 1;
const SETTLE_MS = 600;

async function runPage(browser, url, pageName, results) {
  const { page, ctx, errors } = await L.newPage(browser, url, { pageName });
  try {
    await L.waitReady(page);
    await L.importFile(page, PARTITION);
    const first = await L.waitFirstSvg(page, 180000);
    await L.waitBackgroundLoaded(page, 180000);
    await page.waitForTimeout(800);
    L.record(results, '9. Partition Magnificat importée', pageName,
      first.svgCount > 0 ? 'OK' : 'ÉCHEC', `1er SVG en ${first.ms} ms`);

    // Charge les données de lecture (MIDI + marqueurs) puis démarre.
    await page.click('#transport-play');
    await page.waitForFunction(() => {
      const st = window.__musicaPlaybackState?.() || {};
      return st.state === 'playing' && st.duration > 0;
    }, null, { timeout: 180000, polling: 200 });
    const probe = await page.evaluate(() => window.__musicaPlaybackProbe());
    await page.evaluate((marks) => { window.__s9marks = marks; }, probe.marks || []);
    const withXmlId = (probe.marks || []).filter((m) => m.xmlId).length;
    L.record(results, '9. Marqueurs de synchro porteurs d’un xmlId', pageName,
      withXmlId > 0 ? 'OK' : 'ÉCHEC',
      `${probe.syncMarksCount} marqueur(s), ${withXmlId} avec xmlId, durée ${probe.duration} ms`);

    for (const frac of FRACTIONS) {
      // Déplacement dans la lecture par la barre de position.
      await page.evaluate((ratio) => {
        const el = document.getElementById('transport-seek');
        el.value = String(Math.round(ratio * 1000));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, frac);
      await page.waitForTimeout(900);

      // Page attendue à la position courante, calculée depuis le xmlId de la
      // mesure active et le DOM (jamais depuis le champ page des marqueurs).
      const expected = await page.evaluate(() => {
        const marks = window.__s9marks || [];
        const st = window.__musicaPlaybackState?.() || {};
        const pos = st.position || 0;
        let idx = -1;
        for (let i = 0; i < marks.length; i += 1) {
          if ((Number(marks[i].t) || 0) <= pos) idx = i; else break;
        }
        for (let i = idx; i >= 0; i -= 1) {
          const xid = marks[i].xmlId || marks[i].id;
          const el = xid && document.getElementById(xid);
          const slot = el?.closest?.('.scroll-page');
          if (slot) {
            return {
              page: parseInt(slot.dataset.page, 10),
              xmlId: xid,
              source: marks[i].xmlId ? 'xmlId' : 'id',
              markPage: marks[i].page,
              position: pos,
            };
          }
        }
        return { page: null, position: pos };
      });

      // Attendre que la page attendue soit rendue (rendu à la demande).
      if (expected.page) {
        await page.waitForFunction((p) => !!document.querySelector(
          `.scroll-page[data-page="${p}"] svg`), expected.page, { timeout: 15000 })
          .catch(() => {});
        await page.waitForTimeout(SETTLE_MS);
      }

      const shown = await L.pageInfo(page);
      const ok = expected.page != null && shown.page != null
        && Math.abs(shown.page - expected.page) <= TOLERANCE;
      L.record(results, `9. Suivi à ${Math.round(frac * 100)} % : page de l’élément joué`, pageName,
        ok ? 'OK' : 'ÉCHEC',
        `t=${expected.position} ms, page attendue ${expected.page} (${expected.xmlId || '?'}, ` +
        `${expected.source || '-'}) → affichée ${shown.page}`);
    }

    await page.click('#transport-play');  // pause
    const relevant = L.summarize(errors);
    L.record(results, '9. Aucune erreur JS pendant le suivi', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '9. Synchro page↔temps', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

(async () => {
  const results = [];
  const { server, url } = await L.startServer();
  const browser = await L.launch();
  try {
    await runPage(browser, url, 'index.html', results);
  } catch (e) {
    console.log('ERREUR GÉNÉRALE', e.stack);
  }
  console.log('\n=== RÉSUMÉ S9 ===');
  console.log(JSON.stringify(results, null, 1));
  await browser.close();
  server.close();
})();
