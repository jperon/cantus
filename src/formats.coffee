# formats.coffee — source unique des formats importables.
#
# Un seul endroit décrit ce que l'application sait ouvrir : extensions, format
# d'entrée scoretk (`from`), types MIME et listes `accept` du manifeste.
# build.js évalue ce module pour produire l'attribut `accept` des champs de
# fichier, dist/manifest.json (file_handlers et share_target) et les tables
# injectées dans pwa/sw.coffee ; l'application et le worker lisent la même api.
#
# Pour ajouter un format : une entrée dans FORMATS, et ses types MIME dans
# MIME_TYPES s'il en a. Rien d'autre à tenir à jour.
#
# API exposée (window.__musicaFormats dans la page, self.__musicaFormats dans
# le worker, module.exports en CommonJS pour build.js et les tests Node) :
#   baseExtensions     extensions lues directement par l'application
#   scoretkExtensions  extensions converties par scoretk
#   extensions         les deux listes, dans l'ordre d'import
#   scoretkFrom(name)  format d'entrée scoretk déduit de l'extension, ou undefined
#   mimeExtensions     type MIME -> extension du nom de repli (service worker)
#   fileHandlerAccept  type MIME -> extensions acceptées (file_handlers)
#   shareAccept        types MIME et extensions du partage (share_target)

FORMATS = [
  # MusicXML (lu directement ; .mxl est décompressé par mxl.coffee). `.xml` est
  # trop générique pour être réclamé par le partage Android : il reste accepté
  # à l'ouverture par le système, d'où `share: false`.
  {label: 'MusicXML', extensions: ['xml'], scoretk: false, share: false}
  {label: 'MusicXML', extensions: ['musicxml'], scoretk: false}
  {label: 'MusicXML', extensions: ['mxl'], scoretk: false}
  # MuseScore (.mscz = archive, .mscx = XML)
  {label: 'MuseScore', extensions: ['mscz', 'mscx'], scoretk: true, from: {mscz: 'mscz', mscx: 'mscx'}}
  # LilyPond
  {label: 'LilyPond', extensions: ['ly', 'lilypond'], scoretk: true, from: {ly: 'ly', lilypond: 'lilypond'}}
  # ABC
  {label: 'ABC', extensions: ['abc'], scoretk: true, from: {abc: 'abc'}}
  # MIDI : transcriptions, sans notation d'origine ; scoretk attend `midi`
  {label: 'MIDI', extensions: ['mid', 'midi'], scoretk: true, from: {mid: 'midi', midi: 'midi'}}
  # GABC : notation carrée lue directement par exsurge, sans scoretk ni
  # conversion MusicXML (voir src/app/gregorien.coffee).
  {label: 'GABC', extensions: ['gabc'], scoretk: false}
]

# Types MIME des formats. `extensions` : ce qu'un fichier de ce type peut être
# (accept des file_handlers) ; `fallback` : extension ajoutée par le service
# worker quand le nom du fichier est perdu (absent = type générique, aucune
# extension devinée) ; `fileHandler: false` : type accepté au partage mais pas
# déclaré à l'ouverture par le système. L'ordre fixe celui de file_handlers.
MIME_TYPES = [
  {type: 'application/vnd.recordare.musicxml+xml', extensions: ['musicxml', 'xml'], fallback: 'musicxml'}
  {type: 'application/vnd.recordare.musicxml', extensions: ['mxl'], fallback: 'mxl'}
  {type: 'text/xml', extensions: ['xml'], fallback: 'xml'}
  {type: 'application/xml', extensions: ['xml'], fallback: 'xml'}
  {type: 'application/x-musescore', extensions: ['mscz', 'mscx'], fallback: 'mscx'}
  {type: 'application/octet-stream', extensions: ['mscz', 'mscx']}
  {type: 'application/zip', extensions: ['mxl'], fallback: 'mxl', fileHandler: false}
  {type: 'audio/x-musescore', extensions: ['mscx'], fallback: 'mscx', fileHandler: false}
  {type: 'text/x-lilypond', extensions: ['ly', 'lilypond'], fallback: 'ly'}
  {type: 'text/vnd.abc', extensions: ['abc'], fallback: 'abc'}
  {type: 'text/x-gabc', extensions: ['gabc'], fallback: 'gabc'}
  {type: 'text/plain', extensions: ['ly', 'lilypond', 'abc', 'gabc']}
  {type: 'audio/midi', extensions: ['mid', 'midi'], fallback: 'mid'}
  {type: 'audio/x-midi', extensions: ['mid', 'midi'], fallback: 'mid'}
]

baseExtensions = []
scoretkExtensions = []
shareExtensions = []
for format in FORMATS
  for ext in format.extensions
    if format.scoretk then scoretkExtensions.push ext else baseExtensions.push ext
    shareExtensions.push ext unless format.share is false

extensions = baseExtensions.concat scoretkExtensions

# Libellés des formats, sans doublon, dans l'ordre d'import : une seule liste
# pour l'accroche de l'accueil (aucun nom de format écrit ailleurs).
formatLabels = []
for format in FORMATS
  formatLabels.push format.label unless format.label in formatLabels

# `from` toujours explicite : `detect` classerait un .mscx (XML sans
# <museScore) en musicxml, et un .ly ou .abc pourrait être mal classé selon son
# contenu.
fromByExtension = {}
for format in FORMATS when format.scoretk
  for ext in format.extensions
    fromByExtension[ext] = format.from[ext]

scoretkFrom = (name) ->
  ext = (name or '').split('.').pop().toLowerCase()
  fromByExtension[ext]

mimeExtensions = {}
for mime in MIME_TYPES when mime.fallback?
  mimeExtensions[mime.type] = mime.fallback

fileHandlerAccept = {}
for mime in MIME_TYPES when mime.fileHandler isnt false
  fileHandlerAccept[mime.type] = (".#{ext}" for ext in mime.extensions)

shareAccept = (mime.type for mime in MIME_TYPES)
shareAccept.push ".#{ext}" for ext in shareExtensions

api = {
  baseExtensions
  scoretkExtensions
  extensions
  formatLabels
  scoretkFrom
  mimeExtensions
  fileHandlerAccept
  shareAccept
}

window.__musicaFormats = api if typeof window isnt 'undefined'
self.__musicaFormats = api if typeof self isnt 'undefined'
module.exports = api if typeof module isnt 'undefined' and module.exports?
