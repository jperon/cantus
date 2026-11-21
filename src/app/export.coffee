# Export de la partition courante : bouton de la barre du bas, petit dialogue
# de choix du format, puis téléchargement du fichier produit par scoretk.
# Le travail lourd (conversion) reste dans le worker ; la page ne transmet que
# les choix d'instrument et enregistre les octets reçus.

# Libellés lisibles des formats que scoretk sait écrire. Un format inconnu de
# cette table garde son nom technique, sans traduction inventée.
EXPORT_FORMAT_KEYS =
  musicxml: 'export.format.musicxml'
  mxl: 'export.format.mxl'
  mscx: 'export.format.mscx'
  mscz: 'export.format.mscz'
  ly: 'export.format.ly'
  abc: 'export.format.abc'
  midi: 'export.format.midi'

# Ordre d'affichage : les formats les plus courants d'abord, les autres
# ensuite dans l'ordre renvoyé par scoretk.
EXPORT_FORMAT_ORDER = ['musicxml', 'mxl', 'mscz', 'mscx', 'ly', 'abc', 'midi']

EXPORT_MIME =
  musicxml: 'application/vnd.recordare.musicxml+xml'
  mxl: 'application/vnd.recordare.musicxml'
  mscx: 'application/x-musescore'
  mscz: 'application/x-musescore'
  ly: 'text/x-lilypond'
  abc: 'text/vnd.abc'
  midi: 'audio/midi'

exportFormatLabel = (format) ->
  key = EXPORT_FORMAT_KEYS[format.name]
  if key then t(key) else (format.name or "")

sortWriteFormats = (formats) ->
  rank = (format) ->
    index = EXPORT_FORMAT_ORDER.indexOf format.name
    if index < 0 then EXPORT_FORMAT_ORDER.length else index
  (format for format in (formats ? []) when format?.write is true)
    .sort (a, b) -> rank(a) - rank(b)

# Demande à scoretk, dans le worker, la liste de ses formats d'écriture. Le
# résultat est mémorisé pour les ouvertures suivantes du dialogue.
requestWriteFormats = ->
  return Promise.resolve exportFormats if exportFormats?
  new Promise (resolve, reject) ->
    id = ++formatsRequestId
    pendingFormats.set id,
      resolve: (formats) ->
        exportFormats = sortWriteFormats formats
        resolve exportFormats
      reject: reject
    worker.postMessage {type: "listFormats", id}

# Source affichée : la partition courante, pas seulement la page ni le
# mouvement. Dans un dossier, `sourceIndex` remonte au fichier d'origine.
currentExportSource = ->
  result = getMovementForPage displayedPage()
  return null unless result?.movement?
  index = result.movement.sourceIndex ? 0
  source = currentSources?[index]
  return null unless source?
  {index, source}

# Choix d'instrument par voix, tels que les sélecteurs les ont mémorisés :
# libellé de voix -> programme GM (0..127). Le worker les associe ensuite aux
# ids de score-part. « Piano seulement » est un mode de répétition, pas un
# choix de partition : il n'est jamais exporté.
exportProgramChoices = ->
  choices = {}
  for own label, program of partPrograms
    value = parseInt program, 10
    choices[label] = value if isFinite(value) and value >= 0 and value <= 127
  choices

# Nom d'origine sans extension + extension du format choisi.
exportFileName = (source, format) ->
  extension = format.extensions?[0] ? format.name
  base = source?.name or "partition"
  base = base.replace /\.[^./\\]+$/, ""
  "#{base}.#{extension}"

downloadExport = (bytes, name, mime) ->
  blob = new Blob [bytes], {type: mime or 'application/octet-stream'}
  url = URL.createObjectURL blob
  link = document.createElement "a"
  link.href = url
  link.download = name
  link.style.display = "none"
  document.body.appendChild link
  link.click()
  document.body.removeChild link
  # Révocation différée : le téléchargement peut démarrer après le clic.
  setTimeout (-> URL.revokeObjectURL url), 10000

renderExportFormats = ->
  select = $("export-format")
  return unless select
  select.innerHTML = ""
  for format in (exportFormats ? [])
    option = document.createElement "option"
    option.value = format.name
    option.textContent = "#{exportFormatLabel format} (.#{format.extensions?[0] ? format.name})"
    select.appendChild option

closeExportDialog = ->
  $("export-overlay")?.classList.add "hidden"

openExportDialog = ->
  return unless fileLoaded and currentSources?.length
  confirmBtn = $("export-confirm")
  confirmBtn.disabled = true
  $("export-overlay").classList.remove "hidden"
  renderExportFormats()
  requestWriteFormats()
    .then ->
      renderExportFormats()
      confirmBtn.disabled = exportFormats.length is 0
    .catch (err) ->
      closeExportDialog()
      showError t("export.formatsError", {error: err?.message or err})

performExport = ->
  select = $("export-format")
  format = (exportFormats ? []).find (item) -> item.name is select?.value
  return unless format
  target = currentExportSource()
  return showError(t "export.noSource") unless target
  confirmBtn = $("export-confirm")
  return if confirmBtn.disabled
  confirmBtn.disabled = true
  new Promise (resolve, reject) ->
    id = ++exportRequestId
    pendingExports.set id, {resolve, reject}
    worker.postMessage
      type: "exportSource"
      id: id
      sourceId: target.index
      to: format.name
      programs: exportProgramChoices()
  .then (bytes) ->
    unless bytes?.length > 0
      throw new Error t("export.empty")
    downloadExport bytes, exportFileName(target.source, format), EXPORT_MIME[format.name]
    closeExportDialog()
  .catch (err) ->
    showError t("export.error", {error: err?.message or err})
  .then ->
    confirmBtn.disabled = false

setupExport = ->
  $("menu-export")?.addEventListener "click", openExportDialog
  $("export-close")?.addEventListener "click", closeExportDialog
  $("export-cancel")?.addEventListener "click", closeExportDialog
  $("export-confirm")?.addEventListener "click", performExport
  # Clic sur le fond assombri : fermer, comme un dialogue modal.
  $("export-overlay")?.addEventListener "click", (e) ->
    closeExportDialog() if e.target is $("export-overlay")
  document.addEventListener "keydown", (e) ->
    closeExportDialog() if e.key is "Escape" and
      $("export-overlay")? and not $("export-overlay").classList.contains "hidden"
