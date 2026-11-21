// Scénario 12 — export de la partition courante.
// Ouvre un .mscz de test, choisit un instrument pour une voix dans les
// réglages, puis exporte en MusicXML et en MIDI par le bouton « Exporter ».
// Le téléchargement est intercepté par Playwright : le MusicXML doit porter le
// midi-program choisi et le MIDI commencer par l'en-tête MThd.
const fs = require('fs');
const path = require('path');
const L = require('./lib');

const PAGES = ['index.html', 'spa.html'];
const MSCZ = L.FILES.byrdMscz;
// Flûte : programme GM 0..127 ; MusicXML numérote midi-program à partir de 1.
const PROGRAM = 73;
const MUSICXML_PROGRAM = PROGRAM + 1;

async function newDownloadPage(browser, url, pageName) {
  const ctx = await browser.newContext({
    viewport: { width: 500, height: 900 },
    acceptDownloads: true,
  });
  return L.newPage(browser, url, { pageName, context: ctx });
}

// Ouvre le dialogue, attend la liste des formats proposés par le worker.
async function openExport(page) {
  await page.click('#btn-export');
  await page.waitForFunction(
    () => !document.getElementById('export-overlay').classList.contains('hidden'),
    null,
    { timeout: 10000, polling: 100 }
  );
  await page.waitForFunction(
    () => document.querySelectorAll('#export-format option').length > 0,
    null,
    { timeout: 60000, polling: 200 }
  );
}

async function downloadFormat(page, format) {
  await openExport(page);
  await page.selectOption('#export-format', format);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.click('#export-confirm'),
  ]);
  const file = await download.path();
  return { download, name: download.suggestedFilename(), bytes: fs.readFileSync(file) };
}

// Bloc complet d'un score-part (le MusicXML exporté est petit et non indenté).
function scorePartBlocks(xml) {
  return [...xml.matchAll(/<score-part\b[^>]*>[\s\S]*?<\/score-part>/g)].map((m) => m[0]);
}

async function runPage(browser, url, pageName, results) {
  const { page, ctx, errors } = await newDownloadPage(browser, url, pageName);
  try {
    await L.waitReady(page);
    await L.importFile(page, MSCZ);
    const first = await L.waitFirstSvg(page, 180000);
    await L.waitBackgroundLoaded(page, 180000);
    L.record(results, '12. Partition .mscz ouverte', pageName,
      first.svgCount > 0 ? 'OK' : 'ÉCHEC', `1er SVG en ${first.ms} ms`);
    const label = await page.getAttribute('#btn-export', 'aria-label');
    const title = await page.getAttribute('#btn-export', 'title');
    L.record(results, '12. Bouton Exporter visible, libellés traduits', pageName,
      label === 'Exporter' && title === 'Exporter' ? 'OK' : 'ÉCHEC',
      `aria-label « ${label} », title « ${title} »`);

    // Choisit un instrument pour la première voix non percussive.
    await L.openSettings(page);
    const rows = await page.$$eval('#parts-list .part-row', (items) => items.map((row, index) => ({
      index,
      name: row.querySelector('.part-name')?.textContent?.trim(),
      hasProgram: !!row.querySelector('select.part-program'),
    })));
    const target = rows.find((row) => row.hasProgram);
    if (!target) {
      L.record(results, '12. Sélecteur d’instrument présent pour une voix', pageName,
        'ÉCHEC', `voix : ${JSON.stringify(rows)}`);
      return;
    }
    await page.selectOption(
      `#parts-list .part-row:nth-child(${target.index + 1}) select.part-program`,
      String(PROGRAM)
    );
    const chosen = await page.$eval(
      `#parts-list .part-row:nth-child(${target.index + 1}) select.part-program`,
      (select) => select.value
    );
    L.record(results, '12. Instrument choisi pour une voix', pageName,
      chosen === String(PROGRAM) ? 'OK' : 'ÉCHEC',
      `voix « ${target.name} », programme ${chosen}`);
    await L.closeSettings(page);

    // --- export MusicXML ---
    const xml = await downloadFormat(page, 'musicxml');
    const text = xml.bytes.toString('utf8');
    const blocks = scorePartBlocks(text);
    const targetBlock = blocks.find((block) => block.includes(`>${target.name}<`));
    const programOk = !!targetBlock && targetBlock.includes(
      `<midi-program>${MUSICXML_PROGRAM}</midi-program>`
    );
    const wholeSource = blocks.length === rows.length && /<measure\b[^>]*>[\s\S]*<measure\b/.test(text);
    L.record(results, '12. Export MusicXML : téléchargement, nom et extension', pageName,
      xml.name === 'Ave_Verum_Corpus_-_William_Byrd.musicxml' ? 'OK' : 'ÉCHEC',
      `fichier « ${xml.name} », ${xml.bytes.length} octets`);
    L.record(results, '12. Export MusicXML : partition complète, toutes les voix', pageName,
      wholeSource ? 'OK' : 'ÉCHEC',
      `${blocks.length} score-part pour ${rows.length} voix`);
    L.record(results, '12. Export MusicXML : midi-program de la voix choisie', pageName,
      programOk ? 'OK' : 'ÉCHEC',
      targetBlock
        ? targetBlock.match(/<midi-program>[^<]*<\/midi-program>/)?.[0] || 'aucun midi-program'
        : `score-part « ${target.name} » introuvable`);

    // --- export MIDI ---
    const midi = await downloadFormat(page, 'midi');
    const magic = midi.bytes.subarray(0, 4).toString('ascii');
    L.record(results, '12. Export MIDI : téléchargement et en-tête MThd', pageName,
      magic === 'MThd' && /\.mid$/.test(midi.name) ? 'OK' : 'ÉCHEC',
      `fichier « ${midi.name} », en-tête ${JSON.stringify(magic)}`);

    const relevant = L.summarize(errors);
    L.record(results, '12. Erreurs JS (export)', pageName,
      relevant.length ? 'ÉCHEC' : 'OK', relevant.join(' | '));
  } catch (e) {
    L.record(results, '12. Export de la partition', pageName, 'ÉCHEC',
      'exception du test : ' + e.message);
  }
  await ctx.close();
}

(async () => {
  const results = [];
  if (!fs.existsSync(MSCZ)) {
    L.record(results, '12. Export de la partition', '-', 'SAUTÉ',
      `fichier de test absent : ${MSCZ}`);
  } else {
    const { server, url } = await L.startServer();
    const browser = await L.launch();
    try {
      for (const pageName of PAGES) await runPage(browser, url, pageName, results);
    } catch (e) {
      console.log('ERREUR GÉNÉRALE', e.stack);
    }
    console.log('\n=== RÉSUMÉ S12 ===');
    console.log(JSON.stringify(results, null, 1));
    await browser.close();
    server.close();
  }
})();
