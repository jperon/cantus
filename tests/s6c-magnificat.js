// Scénario 6c — non-régression de la boucle de lecture du Magnificat de Bach
// (fichier réel du 1er mouvement) : cale de page bornée pendant la lecture
// naturelle avec suivi, position monotone, scroll périmé sans retour, pause
// stable, suivi désactivé. index.html et spa.html.
const C = require('./s6-common');
const L = C.L;
const {
  WAIT, bounded, waitReady, waitFirstSvg, waitBackgroundLoaded, reloadPage,
  state, waitState, transportHidden, positionGrowing, horizontalScrollPos,
  seekFraction, alignedOnSystem, storedParts, partVolumeValues, playbackSample,
  displayedPageNumber, waitLibraryReady, MOVEMENTS_FIXTURE,
} = C;

async function runPage(browser, url, pageName, results) {
  // Non-régression de la boucle de lecture (version publiée 821b248) sur le
  // fichier réel du 1er mouvement du Magnificat de Bach : en lecture naturelle
  // avec suivi actif, la cale de page ne doit pas re-seeker en arrière et la
  // position doit rester monotone. Sur 821b248 les marqueurs du mouvement
  // commençaient à 90,25 s (durée 180 s) : le suivi restait bloqué page 1
  // pendant les 30 premières secondes. Les deux mesures ci-dessous échouent
  // donc sur l'ancien code et passent sur master. Sur le fichier actuel la
  // page 1 dure ~75 s : on démarre à une position d'où plusieurs pages
  // défilent en 30 s (calculée d'après les marqueurs, sans chemin en dur).
  if (L.FILES.magnificatBachMscz && require('fs').existsSync(L.FILES.magnificatBachMscz)) {
    const { page, ctx: ctxLoop, errors: errorsLoop } = await L.newPage(browser, url, { pageName });
    try {
      await waitReady(page);
      await L.importFile(page, L.FILES.magnificatBachMscz);
      await waitFirstSvg(page);
      await waitBackgroundLoaded(page);
      await page.waitForTimeout(800);

      // Marqueurs du mouvement affiché (mouvement 1) : le premier doit être au
      // début du mouvement, sinon le suivi et la cale sont désynchronisés.
      const sample = await playbackSample(page, 1);
      const firstMark = sample.syncMarks.length ? Number(sample.syncMarks[0].t) : null;
      L.record(results, '6. Magnificat : premier marqueur du mouvement 1 au début', pageName,
        firstMark != null && Number.isFinite(firstMark) && firstMark <= 500 ? 'OK' : 'ÉCHEC',
        `${sample.syncMarks.length} marqueurs, premier à ${firstMark} ms, durée ${sample.duration} ms`);

      // Position de départ : premier marqueur d'une fenêtre de 24 s qui
      // traverse au moins deux frontières de page (trois pages distinctes).
      // La marge de 6 s sur les 30 s de lecture absorbe l'imprécision du
      // déplacement (clic proportionnel sur le libellé de temps).
      const marks = sample.syncMarks
        .filter((m) => m.page != null && Number.isFinite(Number(m.t)))
        .map((m) => ({ t: Number(m.t), page: Number(m.page) }))
        .sort((a, b) => a.t - b.t);
      let startMs = null;
      for (let i = 0; i < marks.length && startMs == null; i += 1) {
        const seen = new Set();
        for (let j = i; j < marks.length && marks[j].t <= marks[i].t + 24000; j += 1) {
          seen.add(marks[j].page);
        }
        if (seen.size >= 3) startMs = marks[i].t;
      }
      if (startMs == null) startMs = 0;
      // La durée n'est connue du transport qu'une fois les données de lecture
      // chargées : un premier appui sur lecture puis pause permet de se
      // déplacer sur le libellé de temps, avant d'armer la sonde de seeks.
      if (startMs > 0 && sample.duration > 0) {
        await page.click('#transport-play');
        await waitState(page, 'playing');
        await page.click('#transport-play');
        await waitState(page, 'paused');
        await seekFraction(page, startMs / sample.duration);
        await page.waitForTimeout(600);
      }

      // Lecture naturelle de 30 s, suivi actif : compter les seeks moteur
      // (aucune action de test ne doit en déclencher) et échantillonner la
      // position et la page affichée.
      await page.evaluate(() => {
        window.__loopProbe = { seeks: [], samples: [] };
        const api = window.__musicaAudio;
        if (api && !api.__loopProbeWrapped) {
          api.__loopProbeWrapped = true;
          const orig = api.seek.bind(api);
          api.seek = (s) => {
            window.__loopProbe?.seeks.push(Math.round(s * 1000));
            return orig(s);
          };
        }
        window.__loopProbe.seeks = [];
        window.__loopProbe.samples = [];
        const slot = document.getElementById('page-current');
        window.__loopProbeTimer = setInterval(() => {
          const st = window.__musicaPlaybackState ? window.__musicaPlaybackState() : null;
          const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
          window.__loopProbe.samples.push({
            pos: st ? st.position : null,
            page: m ? parseInt(m[1], 10) : null,
          });
        }, 100);
        void slot;
      });
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForTimeout(30000);
      const natural = await page.evaluate(() => {
        clearInterval(window.__loopProbeTimer);
        return window.__loopProbe;
      });
      const pages = [];
      for (const s of natural.samples) {
        if (s.page != null && pages[pages.length - 1] !== s.page) pages.push(s.page);
      }
      const pageChanges = Math.max(0, pages.length - 1);
      const backs = [];
      for (let i = 1; i < natural.samples.length; i += 1) {
        const a = natural.samples[i - 1].pos;
        const b = natural.samples[i].pos;
        if (a != null && b != null && b < a - 300) backs.push(`${a}->${b}@p${natural.samples[i].page}`);
      }
      L.record(results, '6. Magnificat : cale de page bornée en lecture avec suivi', pageName,
        natural.seeks.length <= pageChanges + 2 ? 'OK' : 'ÉCHEC',
        `${natural.seeks.length} seek(s) pour ${pageChanges} changement(s) de page ` +
        `[${natural.seeks.join(',')}], pages ${pages.join('>')}`);
      L.record(results, '6. Magnificat : position monotone en lecture avec suivi', pageName,
        backs.length === 0 ? 'OK' : 'ÉCHEC',
        `${backs.length} recul(s) de plus de 300 ms : ${backs.slice(0, 6).join(' ')}`);
      L.record(results, '6. Magnificat : le suivi fait avancer la page en 30 s', pageName,
        pageChanges >= 2 && pages[pages.length - 1] > pages[0] ? 'OK' : 'ÉCHEC',
        `pages ${pages.join('>')} (${pageChanges} changement(s))`);

      // Événement scroll périmé : le suivi vient de viser la page courante mais
      // un `scroll` différé mesure encore la page précédente (cas d'une liseuse
      // lente). Sans le garde-fou, la cale seek vers le début de cette page et
      // la lecture recule : c'est la boucle observée en production.
      const currentPage = pages[pages.length - 1];
      const staleBefore = await page.evaluate((prevPage) => {
        const slot = document.getElementById('page-current');
        const wrapper = slot.querySelector('.scroll-wrapper');
        if (!wrapper || !(prevPage >= 1)) return null;
        const fake = document.createElement('div');
        fake.className = 'scroll-page stale-probe';
        fake.dataset.page = String(prevPage);
        const slotTop = slot.getBoundingClientRect().top;
        fake.getBoundingClientRect = () => ({
          top: slotTop - 10, bottom: slotTop + 1, left: 0, right: 0, width: 100, height: 11,
        });
        wrapper.insertBefore(fake, wrapper.firstChild);
        slot.dispatchEvent(new Event('scroll'));
        return { pos: window.__musicaPlaybackState().position, seeks: window.__loopProbe.seeks.length };
      }, currentPage - 1);
      await page.waitForTimeout(700);
      const staleAfter = await page.evaluate(() => {
        const slot = document.getElementById('page-current');
        for (const el of slot.querySelectorAll('.scroll-page.stale-probe')) el.remove();
        // Le faux élément avait faussé l'indicateur de page : le rafraîchir.
        slot.dispatchEvent(new Event('scroll'));
        return { pos: window.__musicaPlaybackState().position, seeks: window.__loopProbe.seeks.length };
      });
      const staleOk = staleBefore && staleAfter.seeks === staleBefore.seeks &&
        staleAfter.pos >= staleBefore.pos - 300;
      L.record(results, '6. Magnificat : un scroll périmé du suivi ne fait pas reculer la tête', pageName,
        staleOk ? 'OK' : 'ÉCHEC',
        staleBefore ? `page ${currentPage}, ${staleBefore.seeks} → ${staleAfter.seeks} seek(s), ` +
          `position ${staleBefore.pos} → ${staleAfter.pos} ms` : 'injection impossible');

      // Pause : plus aucun seek, page et position stables.
      await page.click('#transport-play');
      await waitState(page, 'paused');
      await page.waitForTimeout(400);
      const pausedBefore = await page.evaluate(() => {
        const st = window.__musicaPlaybackState();
        const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
        return { pos: st.position, page: m ? parseInt(m[1], 10) : null, seeks: window.__loopProbe.seeks.length };
      });
      await page.waitForTimeout(1000);
      const pausedAfter = await page.evaluate(() => {
        const st = window.__musicaPlaybackState();
        const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
        return { pos: st.position, page: m ? parseInt(m[1], 10) : null, state: st.state, seeks: window.__loopProbe.seeks.length };
      });
      const pausedOk = pausedAfter.state === 'paused' &&
        Math.abs(pausedAfter.pos - pausedBefore.pos) <= 100 &&
        pausedAfter.page === pausedBefore.page && pausedAfter.seeks === pausedBefore.seeks;
      L.record(results, '6. Magnificat : en pause, page et position stables, aucun seek', pageName,
        pausedOk ? 'OK' : 'ÉCHEC',
        `p.${pausedBefore.page}/${pausedBefore.pos} ms → p.${pausedAfter.page}/${pausedAfter.pos} ms, ` +
        `seeks ${pausedBefore.seeks} → ${pausedAfter.seeks}, état ${pausedAfter.state}`);

      // Suivi désactivé : la lecture ne doit provoquer aucun seek ni changement
      // de page automatique.
      await page.click('#transport-stop');
      await waitState(page, 'stopped');
      await L.openSettings(page);
      await page.$eval('#follow-playback', (el) => {
        el.checked = false;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await L.closeSettings(page);
      const followOffStart = await page.evaluate(() => {
        window.__loopProbe.seeks = [];
        const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
        return { page: m ? parseInt(m[1], 10) : null, seeks: window.__loopProbe.seeks.length };
      });
      await page.click('#transport-play');
      await waitState(page, 'playing');
      await page.waitForTimeout(6000);
      const followOffEnd = await page.evaluate(() => {
        const st = window.__musicaPlaybackState();
        const m = (document.getElementById('page-number')?.textContent || '').match(/(\d+)\s*\//);
        return { page: m ? parseInt(m[1], 10) : null, pos: st.position, seeks: window.__loopProbe.seeks.length };
      });
      L.record(results, '6. Magnificat, followPlayback=false : page stable, aucun seek', pageName,
        followOffEnd.page === followOffStart.page && followOffEnd.seeks === 0 && followOffEnd.pos > 1000 ? 'OK' : 'ÉCHEC',
        `page ${followOffStart.page} → ${followOffEnd.page}, position ${followOffEnd.pos} ms, ` +
        `${followOffEnd.seeks} seek(s)`);
      await page.click('#transport-stop');
      await waitState(page, 'stopped');
      await L.openSettings(page);
      await page.$eval('#follow-playback', (el) => {
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await L.closeSettings(page);
    } catch (e) {
      L.record(results, '6. Magnificat : boucle de lecture', pageName, 'ÉCHEC',
        'exception du test : ' + e.message);
    }
    const relevant = L.summarize(errorsLoop);
    L.record(results, '6. Erreurs JS (Magnificat, boucle de lecture)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
    await ctxLoop.close();
  } else {
    L.record(results, '6. Magnificat : boucle de lecture', pageName, 'SAUTÉ',
      `fichier absent : ${L.FILES.magnificatBachMscz}`);
  }

}

// Durées observées le 18/11/2026 (index.html + spa.html) : 89 à 98 s selon la
// charge ; budget ~2× le maximum. La lecture naturelle de 30 s par page est le
// gros de la durée.
C.main(runPage, { budgetMs: 210000, summary: 'S6C' });
