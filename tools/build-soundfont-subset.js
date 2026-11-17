// Extrait un sous-ensemble de notes d'un fichier de soundfont MIDI.js
// (format gleitz/midi-js-soundfonts) et écrit un asset autonome.
//
// Usage :
//   curl -sS -o /tmp/acoustic_grand_piano-mp3.js \
//     https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/FluidR3_GM/acoustic_grand_piano-mp3.js
//   node tools/build-soundfont-subset.js /tmp/acoustic_grand_piano-mp3.js \
//     pwa/soundfonts/piano-fluidr3-13notes.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 13 notes de C2 à C6, une tous les 4 demi-tons (le player interpole entre
// deux échantillons voisins). Les bémols sont le nommage de FluidR3_GM.
const NOTES = ['C2', 'E2', 'Ab2', 'C3', 'E3', 'Ab3', 'C4', 'E4', 'Ab4', 'C5', 'E5', 'Ab5', 'C6'];
const INSTRUMENT = 'acoustic_grand_piano';
const SOURCE_URL =
  'https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/FluidR3_GM/acoustic_grand_piano-mp3.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage : node tools/build-soundfont-subset.js <source.js> <dest.js>');
  process.exit(1);
}

const source = fs.readFileSync(input, 'utf-8');
const match = source.match(/MIDI\.Soundfont\.acoustic_grand_piano\s*=\s*(\{[\s\S]*?\n\})/);
if (!match) {
  console.error(`Objet MIDI.Soundfont.${INSTRUMENT} introuvable dans ${input}`);
  process.exit(1);
}
// Le fichier d'origine n'est pas du JSON strict (virgule finale).
const samples = JSON.parse(match[1].replace(/,\s*\}/, '}'));
const missing = NOTES.filter((note) => !samples[note]);
if (missing.length) {
  console.error(`Notes absentes de ${input} : ${missing.join(', ')}`);
  process.exit(1);
}

const digest = crypto.createHash('sha256').update(source).digest('hex');
const date = new Date().toISOString().slice(0, 10);
const body = NOTES.map((note) => `"${note}": ${JSON.stringify(samples[note])}`).join(',\n');

const header = `// Cantus — extrait du soundfont FluidR3_GM (piano acoustique).
//
// Source : ${SOURCE_URL}
// Téléchargé le ${date} (fichier amont : ${source.length} octets, sha256 ${digest}).
// Licence : Creative Commons Attribution 3.0 Unported (CC-BY 3.0),
//   échantillons FluidR3 par Frank Wen, rendu MIDI.js par Benjamin Gleitzman.
//   Voir THIRD-PARTY.md et <https://creativecommons.org/licenses/by/3.0/>.
//
// 13 notes de C2 à C6 (une tous les 4 demi-tons) : ${Math.round(body.length / 1024)} Ko environ.
// Format MIDI.js : MIDI.Soundfont["${INSTRUMENT}"] = { note: data-URL, ... }.
//
// Régénération :
//   curl -sS -o /tmp/piano-mp3.js ${SOURCE_URL}
//   node tools/build-soundfont-subset.js /tmp/piano-mp3.js ${path.relative(process.cwd(), output)}
`;

const asset = `${header}
if (typeof(MIDI) === 'undefined') var MIDI = {};
if (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};
MIDI.Soundfont.${INSTRUMENT} = {
${body}
};
`;

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, asset);
console.log(`Écrit ${output} (${fs.statSync(output).size} octets, ${NOTES.length} notes)`);
