# Panneau de réglages : liste des voix et câblage des contrôles de
# l’interface.
# Library overlay controls
setupLibrary = ->
  $("btn-library").addEventListener "click", ->
    showLibrary()

  $("library-close").addEventListener "click", ->
    hideLibrary()

  libInput = $("library-file-input")
  $("library-import-btn").addEventListener "click", ->
    libInput.click()
  libInput.addEventListener "change", (e) ->
    handleImportFiles e.target.files
    e.target.value = ""

  libFolderInput = $("library-folder-input")
  $("library-folder-btn").addEventListener "click", ->
    libFolderInput.click()
  libFolderInput.addEventListener "change", (e) ->
    handleFolderImport e.target.files
    e.target.value = ""

# Resize handler with debounce
setupResize = ->
  window.addEventListener "resize", ->
    clearTimeout resizeTimer if resizeTimer
    resizeTimer = setTimeout ->
      return unless fileLoaded and currentSources?.length
      newWidth = window.innerWidth
      change = Math.abs(newWidth - lastWidth) / lastWidth
      return if change < 0.05
      lastWidth = newWidth
      reloadScore displayedPage()
    , 300

# Remplit la liste des voix avec l'union, dans l'ordre d'apparition, des voix
# de toutes les sources déjà converties de l'entrée (pas de re-parse). Chaque
# fichier renumérote ses parties à partir de P1 : les voix sont identifiées par
# leur libellé (partLabels), pas par leur id.
#
# Deux interrupteurs indépendants par voix : « affichage » (👁, rendu) et
# « lecture » (🔊, audio). Aucun <label> englobant : taper à côté ne bascule
# rien. Chaque interrupteur et son sélecteur (taille, volume) forment un groupe
# insécable placé juste après le nom ; la ligne se replie quand la place manque.
renderPartsList = ->
  group = $("parts-group")
  list = $("parts-list")
  return unless group and list
  labels = []
  seen = new Set()
  for index in [0...(currentSources?.length or 0)]
    info = sourceCache.get index
    continue unless info
    map = partLabels info.splitInfo.doc
    for part in Array.from info.splitInfo.doc.querySelectorAll "score-part"
      label = map[part.getAttribute "id"]
      continue if seen.has label
      seen.add label
      labels.push label
  group.classList.toggle "hidden", labels.length < 2
  list.innerHTML = ""
  for partLabel in labels
    do (partLabel) ->
      displayed = not hiddenParts.has partLabel
      played = not mutedParts.has partLabel
      row = document.createElement "div"
      row.className = "part-row"
      nameEl = document.createElement "span"
      nameEl.className = "part-name"
      nameEl.textContent = partLabel
      displayGroup = document.createElement "div"
      displayGroup.className = "part-group part-display-group"
      soundGroup = document.createElement "div"
      soundGroup.className = "part-group part-sound-group"
      displayBtn = document.createElement "button"
      displayBtn.type = "button"
      displayBtn.className = "part-toggle part-display"
      displayBtn.textContent = "👁"
      displayBtn.title = t "parts.displayTitle"
      displayBtn.setAttribute "aria-label", t("parts.displayAria", {part: partLabel})
      displayBtn.setAttribute "aria-pressed", String displayed
      soundBtn = document.createElement "button"
      soundBtn.type = "button"
      soundBtn.className = "part-toggle part-sound"
      soundBtn.textContent = "🔊"
      soundBtn.title = t "parts.soundTitle"
      soundBtn.setAttribute "aria-label", t("parts.soundAria", {part: partLabel})
      soundBtn.setAttribute "aria-pressed", String played
      sizeSel = document.createElement "select"
      sizeSel.className = "part-size"
      for pct in [50..150] by 10
        opt = document.createElement "option"
        opt.value = pct
        opt.textContent = "#{pct} %"
        sizeSel.appendChild opt
      sizeSel.value = partSizes[partLabel] or 100
      sizeSel.disabled = not displayed
      volumeSel = document.createElement "select"
      volumeSel.className = "part-volume"
      volumeSel.title = t "parts.volumeTitle"
      volumeSel.setAttribute "aria-label", t("parts.volumeAria", {part: partLabel})
      for pct in [10..100] by 10
        opt = document.createElement "option"
        opt.value = pct
        opt.textContent = t "parts.volumeOption", {pct}
        volumeSel.appendChild opt
      volumeSel.value = partVolumes[partLabel] or 100
      volumeSel.disabled = not played
      displayGroup.appendChild displayBtn
      displayGroup.appendChild sizeSel
      soundGroup.appendChild soundBtn
      soundGroup.appendChild volumeSel
      row.appendChild nameEl
      row.appendChild displayGroup
      row.appendChild soundGroup
      # Affichage : rendu seul, appliqué à la fermeture. La voix reste jouée.
      displayBtn.addEventListener "click", ->
        now = displayBtn.getAttribute("aria-pressed") isnt "true"
        displayBtn.setAttribute "aria-pressed", String now
        if now then hiddenParts.delete partLabel else hiddenParts.add partLabel
        sizeSel.disabled = not now
        savePartSettings()
        updatePartsDisabled()
        partsChanged = true
      # Lecture : audio seul, appliqué à chaud. La voix reste affichée.
      soundBtn.addEventListener "click", ->
        now = soundBtn.getAttribute("aria-pressed") isnt "true"
        soundBtn.setAttribute "aria-pressed", String now
        if now then mutedParts.delete partLabel else mutedParts.add partLabel
        volumeSel.disabled = not now
        savePartSettings()
        applyVoiceAudio [partLabel]
      sizeSel.addEventListener "change", ->
        pct = parseInt sizeSel.value
        if pct is 100 then delete partSizes[partLabel] else partSizes[partLabel] = pct
        savePartSettings()
        updatePartsSizesReset()
        partsChanged = true
      volumeSel.addEventListener "change", ->
        pct = parseInt volumeSel.value
        pct = 100 unless isFinite pct
        if pct is 100 then delete partVolumes[partLabel] else partVolumes[partLabel] = pct
        savePartSettings()
        updatePartsVolumesReset()
        # Application immédiate au moteur : jamais de partsChanged ni de rendu
        engine = audioEngine()
        engine?.setVoiceVolume partLabel, pct
      list.appendChild row
  updatePartsDisabled()
  updatePartsSizesReset()
  updatePartsVolumesReset()

# Au moins une voix reste affichée : on désactive l'interrupteur d'affichage
# de la dernière voix affichée. Rien n'impose de voix jouée.
updatePartsDisabled = ->
  list = $("parts-list")
  return unless list
  buttons = Array.from list.querySelectorAll ".part-display"
  active = buttons.filter (btn) -> btn.getAttribute("aria-pressed") is "true"
  for btn in buttons
    btn.disabled = active.length is 1 and btn.getAttribute("aria-pressed") is "true"

# Bouton « Tailles à 100 % » : actif dès qu'une taille diffère de 100
updatePartsSizesReset = ->
  btn = $("parts-sizes-reset")
  return unless btn
  btn.disabled = Object.keys(partSizes).every (id) -> partSizes[id] is 100

# Bouton « Volumes à 100 % » : actif dès qu'un volume diffère de 100
updatePartsVolumesReset = ->
  btn = $("parts-volumes-reset")
  return unless btn
  btn.disabled = Object.keys(partVolumes).every (id) -> parseInt(partVolumes[id]) is 100

# --- Transpositions visuelle et auditive ------------------------------------
# Affichage neutre du sélecteur : « +2 », « 0 », « −3 » (signe moins
# typographique, jamais de valeur vide).
formatTranspose = (semitones) ->
  return "0" unless semitones
  if semitones < 0 then "−#{-semitones}" else "+#{semitones}"

# Remplit les deux sélecteurs une seule fois puis affiche les valeurs du
# fichier courant. Les options vont de −12 à +12 demi-tons.
renderTranspositionUi = ->
  for [id, value] in [["transpose-visual", visualTranspose], ["transpose-audio", auditoryTranspose]]
    select = $(id)
    continue unless select
    if select.options.length is 0
      for semitones in [TRANSPOSE_MIN..TRANSPOSE_MAX]
        option = document.createElement "option"
        option.value = String semitones
        option.textContent = formatTranspose semitones
        select.appendChild option
    select.value = String value

# --- Tempo de lecture -------------------------------------------------------
# Affiche le tempo effectif : réglage du fichier s'il existe, sinon le défaut
# du fichier (tempo initial explicite, ou 80). Le bouton « Tempo du fichier »
# n'est actif que si un réglage s'écarte du défaut ; vider le champ fait de
# même.
renderTempoUi = ->
  input = $("tempo-input")
  return unless input
  info = currentFileTempo()
  if playbackTempoOverride?
    input.value = playbackTempoOverride
  else if info?
    input.value = window.__musicaTimeline.defaultPlaybackTempo info
  else
    # Tempo du fichier pas encore connu : ne pas afficher un défaut trompeur.
    input.value = ""
  input.placeholder = if info? then "" else "…"
  unit = info?.unit ? "quarter"
  label = t "tempo.unit.#{unit}", {count: 1}
  input.setAttribute "aria-label", t("tempo.aria", {unit: label})
  unitEl = $("tempo-unit")
  if unitEl
    unitEl.textContent = window.__musicaTimeline.tempoUnitSymbol unit
    unitEl.title = label
  reset = $("tempo-reset")
  reset.disabled = playbackTempoOverride is null if reset
  hint = $("tempo-hint")
  return unless hint
  plural = t "tempo.unit.#{unit}", {count: 2}
  if info?
    if info.explicit
      hint.textContent = t "tempo.fileExplicit", {bpm: info.bpm, unit: plural}
    else
      hint.textContent = t "tempo.fileDefault",
        {bpm: DEFAULT_PLAYBACK_TEMPO_BPM, unit: plural, ref: DEFAULT_FILE_TEMPO_BPM}
  else if fileTempoError
    hint.textContent = t "tempo.unavailable", {bpm: DEFAULT_PLAYBACK_TEMPO_BPM, unit: plural}
  else
    hint.textContent = t "tempo.pending"

# Demande les données de lecture du mouvement affiché pour connaître le tempo
# initial du fichier. Une seule demande par fichier/mouvement ; le cache de
# lecture fait le reste. N'écrit aucune donnée dans le cache SVG.
ensureFileTempo = ->
  result = getMovementForPage displayedPage()
  return Promise.resolve(currentFileTempo()) unless result
  known = currentFileTempo()
  return Promise.resolve(known) if known?
  fileId = currentFileId
  movementId = result.movement.id
  if fileTempoRequest?.fileId is fileId and fileTempoRequest?.movementId is movementId
    return fileTempoRequest.promise
  fileTempoError = false
  promise = requestPlaybackData movementId
    .then (data) ->
      info = fileTempoFromData data, movementId
      info.fileId = fileId
      fileTempo = info
      info
    .catch (err) ->
      fileTempoError = true
      console.warn "Tempo du fichier indisponible : #{err?.message or err}"
      null
    .then (info) ->
      if fileTempoRequest?.promise is promise then fileTempoRequest = null
      renderTempoUi() unless $("settings-overlay").classList.contains "hidden"
      info
  fileTempoRequest = {fileId, movementId, promise}
  promise

# Applique (et mémorise) le tempo de lecture du fichier courant.
setPlaybackTempo = (value) ->
  playbackTempoOverride = window.__musicaTimeline.clampPlaybackTempo value
  savePlaybackTempo()
  renderTempoUi()
  applyTempoToPlayback()

# Retour au tempo du fichier : supprime le réglage du fichier courant.
resetTempoToFile = ->
  playbackTempoOverride = null
  savePlaybackTempo()
  renderTempoUi()
  applyTempoToPlayback()

# Fermer les réglages : applique en une seule fois les changements de voix
closeSettings = ->
  $("settings-overlay").classList.add "hidden"
  if partsChanged
    partsChanged = false
    reloadScore displayedPage() if fileLoaded and currentSources?.length

# Settings overlay controls
setupSettings = ->
  # Show current storage usage
  updateStorageInfo = ->
    if navigator.storage?.estimate?
      navigator.storage.estimate().then (estimate) ->
        usageMB = (estimate.usage / 1024 / 1024).toFixed(2)
        quotaMB = (estimate.quota / 1024 / 1024).toFixed(0)
        storageInfo = $("storage-info")
        if storageInfo
          storageInfo.textContent = "#{usageMB}MB / #{quotaMB}MB"

          # Change color based on usage
          usagePercent = (estimate.usage / estimate.quota) * 100
          if usagePercent > 80
            storageInfo.style.color = '#f44336'  # Red
          else if usagePercent > 60
            storageInfo.style.color = '#ff9800'  # Orange
          else
            storageInfo.style.color = '#4caf50'  # Green

  $("btn-settings").addEventListener "click", ->
    $("settings-overlay").classList.remove "hidden"
    renderPartsList()
    renderTempoUi()
    renderTranspositionUi()
    ensureFileTempo()
    updateStorageInfo()

  $("settings-close").addEventListener "click", closeSettings

  # Remet toutes les tailles de voix à 100 % (les voix masquées sont conservées)
  $("parts-sizes-reset").addEventListener "click", ->
    changed = Object.keys(partSizes).some (id) -> partSizes[id] isnt 100
    partSizes = {}
    savePartSettings()
    renderPartsList()
    partsChanged = true if changed

  # Remet tous les volumes de voix à 100 % : aucun re-rendu, seulement le moteur
  $("parts-volumes-reset").addEventListener "click", ->
    labels = Object.keys partVolumes
    partVolumes = {}
    savePartSettings()
    renderPartsList()
    applyVoiceAudio labels

  # Zoom slider: live label, apply on release
  $("zoom-range").addEventListener "input", (e) ->
    $("zoom-value").textContent = parseInt e.target.value

  $("zoom-range").addEventListener "change", (e) ->
    val = parseInt e.target.value
    currentScale = val
    settings = loadSettings()
    settings.zoom = val
    saveSettings settings
    # Re-render current score with new zoom
    if fileLoaded and currentSources?.length
      reloadScore displayedPage()

  # Theme buttons
  for btn in document.querySelectorAll(".theme-btn")
    do (btn) ->
      btn.addEventListener "click", ->
        theme = btn.dataset.theme
        applyTheme theme
        settings = loadSettings()
        settings.theme = theme
        saveSettings settings

  # Tap size buttons
  for btn in document.querySelectorAll(".tap-btn")
    do (btn) ->
      btn.addEventListener "click", ->
        size = parseInt btn.dataset.size
        applyTapSize size
        settings = loadSettings()
        settings.tapSize = size
        saveSettings settings

  # Scroll unit buttons
  for btn in document.querySelectorAll(".scroll-unit-btn")
    do (btn) ->
      btn.addEventListener "click", ->
        settings = loadSettings()
        settings.scrollUnit = btn.dataset.unit
        saveSettings settings
        applyScrollSettings settings.scrollUnit, settings.overlap or 0

  # Overlap select
  $("overlap-select").addEventListener "change", (e) ->
    settings = loadSettings()
    settings.overlap = parseInt e.target.value
    saveSettings settings

  # Suivi du défilement : appliqué immédiatement, sans re-rendu
  followBox = $("follow-playback")
  if followBox
    followBox.addEventListener "change", (e) ->
      enabled = e.target.checked
      applyFollowPlayback enabled
      settings = loadSettings()
      settings.followPlayback = enabled
      saveSettings settings

  # Dérouler les reprises : le mode change le contenu des données de lecture.
  # On arrête la lecture en cours et on oublie les données du mouvement ; la
  # clé de cache inclut le mode, la prochaine lecture demandera les bonnes.
  expandBox = $("expand-repeats")
  if expandBox
    expandBox.addEventListener "change", (e) ->
      enabled = e.target.checked
      applyExpandRepeats enabled
      settings = loadSettings()
      settings.expandRepeats = enabled
      saveSettings settings
      resetPlayback()

  # Volume général : appliqué en direct, conservé à la fin du glissement
  volumeRange = $("master-volume-range")
  if volumeRange
    volumeRange.addEventListener "input", (e) ->
      applyMasterVolume parseInt e.target.value
    volumeRange.addEventListener "change", (e) ->
      value = parseInt e.target.value
      applyMasterVolume value
      settings = loadSettings()
      settings.masterVolume = value
      saveSettings settings

  # Tempo de lecture : appliqué immédiatement, propre au fichier. Un champ vidé
  # revient au tempo du fichier, comme le bouton dédié.
  tempoInput = $("tempo-input")
  if tempoInput
    tempoInput.addEventListener "change", (e) ->
      raw = String(e.target.value ? "").trim()
      if raw is ""
        resetTempoToFile()
        return
      value = parseInt raw, 10
      if isFinite value
        setPlaybackTempo value
      else
        resetTempoToFile()
  tempoReset = $("tempo-reset")
  tempoReset?.addEventListener "click", resetTempoToFile

  # Transposition visuelle : purement rendu, appliquée au rechargement à la
  # fermeture du panneau (comme les tailles de voix).
  transposeVisual = $("transpose-visual")
  if transposeVisual
    transposeVisual.addEventListener "change", (e) ->
      visualTranspose = clampTranspose e.target.value
      e.target.value = String visualTranspose
      saveTranspose "visual", visualTranspose
      partsChanged = true

  # Transposition auditive : purement audio, appliquée à chaud au moteur pour
  # les notes suivantes ; aucun re-rendu, aucune clé de cache.
  transposeAudio = $("transpose-audio")
  if transposeAudio
    transposeAudio.addEventListener "change", (e) ->
      auditoryTranspose = clampTranspose e.target.value
      e.target.value = String auditoryTranspose
      saveTranspose "audio", auditoryTranspose
      engine = audioEngine()
      engine?.setTranspose auditoryTranspose

  # Vidage des caches de rendu (SVG et données de lecture). Les fichiers de
  # la bibliothèque (IndexedDB) ne sont pas touchés.
  storageBtn = $("btn-storage")
  if storageBtn
    storageBtn.addEventListener "click", ->
      tasks = []
      tasks.push svgStore.clearAll() if svgStore?.clearAll?
      tasks.push playbackStore.clearAll() if playbackStore?.clearAll?
      Promise.all(tasks).then ->
        memoryCache.clear()
        playbackCache.clear()
        pendingRequests.clear()
        updateStorageInfo()
        showStorageMessage t("storage.cacheCleared"), "success"
      .catch (err) ->
        console.warn "Vidage des caches impossible : #{err?.message or err}"
        showStorageMessage t("storage.clearFailed"), "error"

