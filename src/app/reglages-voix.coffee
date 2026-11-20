# Réglages persistants (zoom, thème, défilement…), voix masquées ou coupées,
# tailles et volumes, tempo de lecture par fichier, et variantes de cache qui en
# dérivent. « Masquée » ne concerne que le rendu ; « coupée » que la lecture.
# Only returns loaded movements, falls back to movement 1 if not loaded
getMovementForPage = (globalPage) ->
  offset = 0
  for m in movements
    if m.loaded and offset + m.pageCount >= globalPage
      return {movement: m, localPage: globalPage - offset}
    offset += m.pageCount or 0
  # Fallback: use first loaded movement (movement 1 should always be loaded first)
  firstMv = movements[0]
  if firstMv?.loaded
    return {movement: firstMv, localPage: 1}
  null

# Settings defaults
defaultSettings = { zoom: 40, theme: "white", tapSize: 30, scrollUnit: "page", overlap: 0, masterVolume: 80, followPlayback: true, expandRepeats: true }

# Bornes des transpositions visuelle et auditive, en demi-tons.
TRANSPOSE_MIN = -12
TRANSPOSE_MAX = 12

loadSettings = ->
  try
    saved = localStorage.getItem "musica-settings"
    parsed = if saved then JSON.parse(saved) else {}
    # Les réglages ajoutés depuis une version antérieure prennent leur défaut
    Object.assign {}, defaultSettings, parsed
  catch
    Object.assign({}, defaultSettings)

saveSettings = (settings) ->
  try
    localStorage.setItem "musica-settings", JSON.stringify(settings)
  catch
    # localStorage unavailable (file:// on some browsers)

applyTheme = (theme) ->
  document.body.classList.remove "theme-sepia", "theme-dark"
  document.body.classList.add "theme-#{theme}" if theme isnt "white"
  # Update active button
  for btn in document.querySelectorAll(".theme-btn")
    btn.classList.toggle "active", btn.dataset.theme is theme

applyTapSize = (size) ->
  $("tap-left").style.width = "#{size}%"
  $("tap-right").style.width = "#{size}%"
  for btn in document.querySelectorAll(".tap-btn")
    btn.classList.toggle "active", btn.dataset.size is String(size)

applyZoom = (zoom) ->
  currentScale = zoom
  $("zoom-range").value = zoom
  $("zoom-value").textContent = zoom

applyScrollSettings = (unit, overlap) ->
  currentScrollUnit = unit or "page"
  for btn in document.querySelectorAll ".scroll-unit-btn"
    btn.classList.toggle "active", btn.dataset.unit is unit
  $("overlap-select").value = String overlap
  $("overlap-row").classList.toggle "hidden", unit isnt "page"

applyFollowPlayback = (enabled) ->
  followPlaybackEnabled = enabled isnt false
  box = $("follow-playback")
  box.checked = followPlaybackEnabled if box

applyExpandRepeats = (enabled) ->
  expandRepeats = enabled isnt false
  box = $("expand-repeats")
  box.checked = expandRepeats if box

applyMasterVolume = (volume) ->
  value = parseInt volume
  value = 80 unless isFinite value
  value = Math.max 0, Math.min 100, value
  engine = audioEngine()
  engine?.setMasterVolume value
  range = $("master-volume-range")
  range.value = value if range
  label = $("master-volume-value")
  label.textContent = value if label

applyAllSettings = ->
  settings = loadSettings()
  applyTheme settings.theme
  applyTapSize settings.tapSize
  applyZoom settings.zoom
  applyScrollSettings settings.scrollUnit or "page", settings.overlap or 0
  applyMasterVolume settings.masterVolume
  applyFollowPlayback settings.followPlayback
  applyExpandRepeats settings.expandRepeats

# Applique les volumes et les voix coupées au moteur audio, par libellé.
# C'est le seul réglage de voix audible : le masquage ne touche que le rendu.
# Les libellés inconnus du mouvement chargé sont acceptés sans erreur : une
# voix coupée peut avoir disparu du MIDI, et le volume reste mémorisé pour son
# retour. Aucun re-rendu n'est déclenché ici.
applyVoiceAudio = (labels) ->
  engine = audioEngine()
  return unless engine?.setVoiceVolume?
  list = []
  seen = new Set()
  add = (label) ->
    return unless label? and not seen.has label
    seen.add label
    list.push label
  add label for label in (labels ? [])
  add label for label in Object.keys partVolumes
  add label for label in Array.from mutedParts
  for label in list
    volume = parseInt partVolumes[label] ? 100
    volume = 100 unless isFinite volume
    engine.setVoiceVolume label, volume
    engine.setVoiceMuted label, mutedParts.has(label) if engine.setVoiceMuted?

# Réglages de voix propres à chaque fichier : voix masquées (rendu), voix
# coupées (lecture), tailles et volumes. Le champ `muted` absent vaut aucune
# voix coupée ; `volumes` absent vaut 100 % partout.
loadPartSettings = ->
  hiddenParts = new Set()
  mutedParts = new Set()
  partSizes = {}
  partVolumes = {}
  return unless currentFileId
  try
    saved = localStorage.getItem "musica-hidden-parts-#{currentFileId}"
    return unless saved
    data = JSON.parse saved
    if Array.isArray data
      # ancien format : tableau d'ids, ignorés s'ils ne sont pas des libellés
      hiddenParts = new Set data
    else
      hiddenParts = new Set data.hidden or []
      mutedParts = new Set data.muted or []
      partSizes = data.sizes or {}
      partVolumes = data.volumes or {}
  catch
    # localStorage unavailable (file:// on some browsers)

savePartSettings = ->
  return unless currentFileId
  try
    data =
      hidden: Array.from hiddenParts
      muted: Array.from mutedParts
      sizes: partSizes
      volumes: partVolumes
    localStorage.setItem "musica-hidden-parts-#{currentFileId}", JSON.stringify(data)
  catch
    # localStorage unavailable (file:// on some browsers)

# Tempo de lecture propre au fichier, sur le même modèle que les réglages de
# voix : une clé localStorage par identifiant de bibliothèque. Absence de clé
# (ou valeur hors bornes) = pas de réglage : le tempo du fichier fait foi.
loadPlaybackTempo = ->
  playbackTempoOverride = null
  return unless currentFileId
  try
    saved = localStorage.getItem "musica-tempo-#{currentFileId}"
    value = parseInt saved, 10
    playbackTempoOverride = value if isFinite(value) and value >= TEMPO_MIN_BPM and value <= TEMPO_MAX_BPM
  catch
    # localStorage unavailable (file:// on some browsers)

savePlaybackTempo = ->
  return unless currentFileId
  try
    if playbackTempoOverride?
      localStorage.setItem "musica-tempo-#{currentFileId}", String(playbackTempoOverride)
    else
      localStorage.removeItem "musica-tempo-#{currentFileId}"
  catch
    # localStorage unavailable (file:// on some browsers)

# Tempo initial du fichier chargé, s'il a déjà été obtenu des données de
# lecture. Le cache est lié au fichier : changer de mouvement n'y touche pas.
currentFileTempo = ->
  return null unless fileTempo? and fileTempo.fileId is currentFileId
  fileTempo

# Transpositions visuelle et auditive, propres au fichier, sur le modèle du
# tempo : une clé localStorage par identifiant et par sorte. Absence de clé,
# valeur illisible ou hors bornes = 0 (aucune transposition).
clampTranspose = (value) ->
  number = parseInt value, 10
  return 0 unless isFinite number
  Math.max TRANSPOSE_MIN, Math.min TRANSPOSE_MAX, number

readTranspose = (kind) ->
  return 0 unless currentFileId
  try
    clampTranspose localStorage.getItem "musica-transpose-#{kind}-#{currentFileId}"
  catch
    0

loadTransposition = ->
  visualTranspose = readTranspose "visual"
  auditoryTranspose = readTranspose "audio"

saveTranspose = (kind, value) ->
  return unless currentFileId
  try
    key = "musica-transpose-#{kind}-#{currentFileId}"
    if value is 0
      localStorage.removeItem key
    else
      localStorage.setItem key, String(value)
  catch
    # localStorage unavailable (file:// on some browsers)

# Suffixe de clé du cache SVG : une page rendue avec une autre sélection ou une
# autre transposition visuelle diffère. Les voix coupées et la transposition
# auditive sont purement audio et n'entrent donc jamais dans une clé de cache.
partsVariant = ->
  hidden = Array.from(hiddenParts).sort().join ","
  sizes = (for id in Object.keys(partSizes).sort() when partSizes[id] isnt 100
    "#{id}=#{partSizes[id]}")
  variant = if sizes.length is 0 then hidden else "#{hidden}|#{sizes.join ','}"  # clé inchangée quand toutes les voix sont à 100 %
  return variant if visualTranspose is 0
  "#{variant}|t#{visualTranspose}"

# Variante du XML que le worker a chargé pour un mouvement (voir
# movementVariants). Tant qu'un mouvement n'a pas été chargé, les réglages
# courants font foi.
loadedVariant = (movementId) -> movementVariants[movementId] ? partsVariant()

# Le cache mémoire ne porte pas la variante dans sa clé : dès que les réglages
# de voix changent, ses pages ne valent plus (le rechargement le vide aussi,
# mais une page peut être demandée entre le changement et le rechargement).
syncMemoryVariant = ->
  variant = partsVariant()
  return variant if variant is memoryVariant
  memoryVariant = variant
  memoryCache.clear()
  pendingRequests.clear()
  variant

