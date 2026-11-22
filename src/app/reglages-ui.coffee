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

# Noms General MIDI standard, en anglais et jamais traduits : un tableau
# unique indexé par le numéro de programme (0..127). Les familles de huit
# programmes sont les seuls libellés traduits.
GM_PROGRAMS = [
  'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
  'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavinet',
  'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone',
  'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
  'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ',
  'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
  'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)', 'Electric Guitar (clean)',
  'Electric Guitar (muted)', 'Overdriven Guitar', 'Distortion Guitar', 'Guitar Harmonics',
  'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
  'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
  'Violin', 'Viola', 'Cello', 'Contrabass',
  'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
  'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
  'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
  'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet',
  'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
  'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax',
  'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
  'Piccolo', 'Flute', 'Recorder', 'Pan Flute',
  'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
  'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
  'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
  'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
  'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
  'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
  'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
  'Sitar', 'Banjo', 'Shamisen', 'Koto',
  'Kalimba', 'Bag pipe', 'Fiddle', 'Shanai',
  'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock',
  'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
  'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet',
  'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot'
]

GM_FAMILY_KEYS = [
  'gm.family.piano', 'gm.family.chromatic', 'gm.family.organ', 'gm.family.guitar',
  'gm.family.bass', 'gm.family.strings', 'gm.family.ensemble', 'gm.family.brass',
  'gm.family.reed', 'gm.family.pipe', 'gm.family.synthLead', 'gm.family.synthPad',
  'gm.family.synthEffects', 'gm.family.ethnic', 'gm.family.percussive', 'gm.family.soundEffects'
]

# Programmes GM d'origine des voix, lus dans le MusicXML. <midi-program> est
# numéroté à partir de 1 ; son absence vaut 0, comme le programme par défaut du
# moteur. Sert seulement à l'étiquette « Partition (…) ».
partSourcePrograms = ->
  programs = {}
  for index in [0...(currentSources?.length or 0)]
    info = sourceCache.get index
    continue unless info
    map = partLabels info.splitInfo.doc
    for part in Array.from info.splitInfo.doc.querySelectorAll "score-part"
      label = map[part.getAttribute "id"]
      continue unless label?
      continue if programs[label]?
      raw = parseInt part.querySelector("midi-instrument midi-program")?.textContent
      programs[label] = if isFinite(raw) then Math.max(0, Math.min(127, raw - 1)) else 0
  programs

# Libellés des voix de batterie : canal MIDI 10 déclaré dans le MusicXML, ou
# canal 9 dans le plan de canaux du moteur une fois des données de lecture
# chargées. Aucune de ces voix ne reçoit de sélecteur d'instrument.
partPercussionLabels = ->
  labels = new Set()
  for index in [0...(currentSources?.length or 0)]
    info = sourceCache.get index
    continue unless info
    map = partLabels info.splitInfo.doc
    for part in Array.from info.splitInfo.doc.querySelectorAll "score-part"
      label = map[part.getAttribute "id"]
      continue unless label?
      channel = parseInt part.querySelector("midi-instrument midi-channel")?.textContent
      labels.add label if channel is 10
  engine = audioEngine()
  assignments = if engine?.getChannelAssignments? then engine.getChannelAssignments() else []
  for entry in assignments
    labels.add entry.label if entry.percussion and entry.label?
  labels

# Voix dont les réglages fins (taille, instrument) sont dépliés. L'état survit
# aux re-rendus de la liste (changement de taille, piano seulement…).
expandedVoiceLabels = new Set()

# Au-delà de cette largeur, tous les contrôles d'une voix tiennent sur une
# ligne lisible : ils sont alors affichés directement, sans repli (mise en page
# en CSS, voir styles.css). En dessous, la ligne reste repliable.
PARTS_WIDE_QUERY = "(min-width: 900px)"

partsWideLayout = ->
  return false unless window.matchMedia?
  window.matchMedia(PARTS_WIDE_QUERY).matches

# Remplit la liste des voix avec l'union, dans l'ordre d'apparition, des voix
# de toutes les sources déjà converties de l'entrée (pas de re-parse). Chaque
# fichier renumérote ses parties à partir de P1 : les voix sont identifiées par
# leur libellé (partLabels), pas par leur id.
#
# Une ligne compacte par voix : nom, interrupteurs « affichage » (👁, rendu) et
# « lecture » (🔊, audio), volume. Aucun <label> englobant : taper à côté ne
# bascule rien. Le chevron (ou un appui sur la ligne) déplie la taille et
# l'instrument de la voix.
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
  sourcePrograms = partSourcePrograms()
  percussion = partPercussionLabels()
  for partLabel, index in labels
    do (partLabel, index) ->
      displayed = not hiddenParts.has partLabel
      played = not mutedParts.has partLabel
      row = document.createElement "div"
      row.className = "part-row"
      # La ligne compacte : le nom (avec le chevron) ouvre les réglages fins,
      # puis viennent 👁, 🔊 et le volume. Aucun <label> englobant : taper à
      # côté ne bascule rien.
      expandBtn = document.createElement "button"
      expandBtn.type = "button"
      expandBtn.className = "part-expand"
      caret = document.createElement "span"
      caret.className = "part-caret"
      nameEl = document.createElement "span"
      nameEl.className = "part-name"
      nameEl.textContent = partLabel
      expandBtn.appendChild caret
      expandBtn.appendChild nameEl
      controls = document.createElement "div"
      controls.className = "part-controls"
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
      volumeSel = document.createElement "select"
      volumeSel.className = "part-volume"
      volumeSel.title = t "parts.volumeTitle"
      volumeSel.setAttribute "aria-label", t("parts.volumeAria", {part: partLabel})
      for pct in [PART_VOLUME_MIN..PART_VOLUME_MAX] by PART_VOLUME_STEP
        opt = document.createElement "option"
        opt.value = pct
        opt.textContent = "#{pct} %"
        volumeSel.appendChild opt
      volumeSel.value = partVolumes[partLabel] ? DEFAULT_PART_VOLUME
      volumeSel.disabled = not played
      controls.appendChild displayBtn
      controls.appendChild soundBtn
      controls.appendChild volumeSel
      details = document.createElement "div"
      details.className = "part-details"
      details.id = "part-details-#{index}"
      sizeField = document.createElement "label"
      sizeField.className = "part-detail-field"
      sizeLabel = document.createElement "span"
      sizeLabel.className = "part-detail-label"
      sizeLabel.textContent = t "parts.sizeLabel"
      sizeSel = document.createElement "select"
      sizeSel.className = "part-size"
      for pct in [PART_SIZE_MIN..PART_SIZE_MAX] by PART_SIZE_STEP
        opt = document.createElement "option"
        opt.value = pct
        opt.textContent = "#{pct} %"
        sizeSel.appendChild opt
      sizeSel.value = partSizes[partLabel] ? DEFAULT_PART_SIZE
      sizeSel.disabled = not displayed
      sizeField.appendChild sizeLabel
      sizeField.appendChild sizeSel
      details.appendChild sizeField
      # Instrument de la voix : « Partition » puis les 128 programmes GM, par
      # famille de huit. La batterie n'en reçoit pas ; les choix par voix
      # restent mémorisés et sont seulement désactivés par « Piano seulement ».
      programSel = null
      unless percussion.has partLabel
        scoreProgram = sourcePrograms[partLabel] ? 0
        programField = document.createElement "label"
        programField.className = "part-detail-field"
        programLabel = document.createElement "span"
        programLabel.className = "part-detail-label"
        programLabel.textContent = t "parts.instrumentLabel"
        programSel = document.createElement "select"
        programSel.className = "part-program"
        programSel.title = t "parts.programTitle"
        programSel.setAttribute "aria-label", t("parts.programAria", {part: partLabel})
        scoreOpt = document.createElement "option"
        scoreOpt.value = ""
        scoreOpt.textContent = "#{t('parts.programScore')} (#{GM_PROGRAMS[scoreProgram]})"
        programSel.appendChild scoreOpt
        for familyKey, family in GM_FAMILY_KEYS
          optGroup = document.createElement "optgroup"
          optGroup.label = t familyKey
          for program in [family * 8 ... family * 8 + 8]
            opt = document.createElement "option"
            opt.value = String program
            opt.textContent = GM_PROGRAMS[program]
            optGroup.appendChild opt
          programSel.appendChild optGroup
        chosen = partPrograms[partLabel]
        programSel.value = if chosen? then String(chosen) else ""
        programSel.disabled = pianoOnly
        programField.appendChild programLabel
        programField.appendChild programSel
        details.appendChild programField
      expandBtn.setAttribute "aria-controls", details.id
      setExpanded = (expanded) ->
        wide = partsWideLayout()
        details.classList.toggle "hidden", not (expanded or wide)
        # Sur écran large, le bouton n'est plus un pli : le nom reste lisible,
        # mais aucun chevron ni bascule (les détails sont toujours affichés).
        expandBtn.disabled = wide
        expandBtn.setAttribute "aria-expanded", String(expanded or wide)
        labelKey = if expanded then "parts.collapseAria" else "parts.expandAria"
        expandBtn.title = if wide then partLabel else t(labelKey, {part: partLabel})
        expandBtn.setAttribute "aria-label", expandBtn.title
        caret.textContent = if wide then "" else if expanded then "▾" else "▸"
      setExpanded expandedVoiceLabels.has partLabel
      expandBtn.addEventListener "click", (e) ->
        e.stopPropagation()
        return if partsWideLayout()
        expanded = expandBtn.getAttribute("aria-expanded") isnt "true"
        if expanded then expandedVoiceLabels.add partLabel else expandedVoiceLabels.delete partLabel
        setExpanded expanded
      # Un appui sur la ligne (hors contrôle) déplie ou replie aussi.
      row.addEventListener "click", (e) ->
        return if partsWideLayout()
        return if e.target.closest "button, select, input, label, a"
        expandBtn.click()
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
        if pct is DEFAULT_PART_SIZE then delete partSizes[partLabel] else partSizes[partLabel] = pct
        savePartSettings()
        renderPartsBulkSelects()
        partsChanged = true
      volumeSel.addEventListener "change", ->
        pct = parseInt volumeSel.value
        pct = DEFAULT_PART_VOLUME unless isFinite pct
        if pct is DEFAULT_PART_VOLUME then delete partVolumes[partLabel] else partVolumes[partLabel] = pct
        savePartSettings()
        renderPartsBulkSelects()
        # Application immédiate au moteur : jamais de partsChanged ni de rendu
        engine = audioEngine()
        engine?.setVoiceVolume partLabel, pct
      if programSel
        programSel.addEventListener "change", ->
          raw = programSel.value
          if raw is "" then delete partPrograms[partLabel] else partPrograms[partLabel] = parseInt raw
          savePartSettings()
          engine = audioEngine()
          engine?.setVoiceProgram partLabel, (if raw is "" then null else parseInt raw)
      row.appendChild expandBtn
      row.appendChild controls
      row.appendChild details
      list.appendChild row
  updatePartsDisabled()
  renderPartsBulkSelects()

# Au moins une voix reste affichée : on désactive l'interrupteur d'affichage
# de la dernière voix affichée. Rien n'impose de voix jouée.
updatePartsDisabled = ->
  list = $("parts-list")
  return unless list
  buttons = Array.from list.querySelectorAll ".part-display"
  active = buttons.filter (btn) -> btn.getAttribute("aria-pressed") is "true"
  for btn in buttons
    btn.disabled = active.length is 1 and btn.getAttribute("aria-pressed") is "true"

# Valeur d'une voix dans `partSizes` / `partVolumes`, avec le défaut du champ
# quand la voix n'a pas de réglage enregistré.
partValueOf = (values, label, fallback) ->
  value = parseInt values[label]
  if isFinite(value) then value else fallback

# Valeur commune à toutes les voix, ou null si elles divergent : le menu
# affiche alors l'option vide « — ».
commonPartValue = (labels, values, fallback) ->
  return null if labels.length is 0
  first = partValueOf values, labels[0], fallback
  return first if labels.every (label) -> partValueOf(values, label, fallback) is first
  null

# Libellés des voix de la liste affichée, dans l'ordre.
currentPartLabels = ->
  (el.textContent for el in document.querySelectorAll "#parts-list .part-name")

# Remplit un menu de pourcentages : option vide « — » puis les valeurs, avec
# la valeur commune sélectionnée si elle existe.
fillBulkSelect = (sel, min, max, step, common) ->
  sel.innerHTML = ""
  mixed = document.createElement "option"
  mixed.value = ""
  mixed.textContent = t "parts.mixed"
  sel.appendChild mixed
  for pct in [min..max] by step
    opt = document.createElement "option"
    opt.value = String pct
    opt.textContent = "#{pct} %"
    sel.appendChild opt
  sel.value = if common? then String(common) else ""

# Menus « Tailles à » et « Volumes à » : valeur commune des voix, sinon « — ».
renderPartsBulkSelects = ->
  labels = currentPartLabels()
  sizeSel = $("parts-sizes-reset")
  if sizeSel
    fillBulkSelect sizeSel, PART_SIZE_MIN, PART_SIZE_MAX, PART_SIZE_STEP,
      (commonPartValue labels, partSizes, DEFAULT_PART_SIZE)
  volumeSel = $("parts-volumes-reset")
  if volumeSel
    fillBulkSelect volumeSel, PART_VOLUME_MIN, PART_VOLUME_MAX, PART_VOLUME_STEP,
      (commonPartValue labels, partVolumes, DEFAULT_PART_VOLUME)

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

# L'installation n'est proposée que lorsque l'écran d'import la propose aussi
# (section visible, donc application non installée et navigateur compatible).
syncInstallRow = ->
  group = $("settings-install-group")
  return unless group
  source = $("install-section")
  available = source? and not source.classList.contains "hidden"
  group.classList.toggle "hidden", not available

# Affiche l'occupation du stockage dans les réglages.
updateStorageInfo = ->
  if navigator.storage?.estimate?
    navigator.storage.estimate().then (estimate) ->
      usageMB = (estimate.usage / 1024 / 1024).toFixed(2)
      quotaMB = (estimate.quota / 1024 / 1024).toFixed(0)
      storageInfo = $("storage-info")
      if storageInfo
        storageInfo.textContent = "#{usageMB}MB / #{quotaMB}MB"

        # Couleur selon l'occupation : teintes foncées, lisibles sur fond
        # blanc et sur les thèmes clairs.
        usagePercent = (estimate.usage / estimate.quota) * 100
        if usagePercent > 80
          storageInfo.style.color = '#b71c1c'
        else if usagePercent > 60
          storageInfo.style.color = '#8a4b00'
        else
          storageInfo.style.color = '#1b5e20'

# Ouvre le panneau des réglages depuis le menu ⋯ de la barre du bas.
openSettings = ->
  $("settings-overlay").classList.remove "hidden"
  renderPartsList()
  renderTempoUi()
  renderTranspositionUi()
  ensureFileTempo()
  updateStorageInfo()
  syncInstallRow()

# Settings overlay controls
setupSettings = ->
  # Franchissement du seuil « tous les contrôles sur une ligne » : la liste des
  # voix est régénérée pour que l'état ARIA (replié/déplié) suive la mise en
  # page CSS. Le rendu de la partition n'est pas touché.
  if window.matchMedia?
    wideMedia = window.matchMedia PARTS_WIDE_QUERY
    onChange = ->
      return if $("settings-overlay").classList.contains "hidden"
      renderPartsList()
    if wideMedia.addEventListener? then wideMedia.addEventListener "change", onChange
    else wideMedia.addListener? onChange

  $("menu-settings").addEventListener "click", openSettings

  $("settings-close").addEventListener "click", closeSettings

  # Le bouton d'installation des réglages déclenche celui de l'écran d'import,
  # seul détenteur de l'invite différée du navigateur.
  installBtn = $("settings-install-btn")
  if installBtn
    installBtn.addEventListener "click", ->
      $("btn-install")?.click()
      setTimeout syncInstallRow, 500

  # Applique la taille choisie à toutes les voix (les voix masquées restent
  # masquées) ; le rendu attend la fermeture des réglages.
  $("parts-sizes-reset").addEventListener "change", (e) ->
    pct = parseInt e.target.value
    return renderPartsBulkSelects() unless isFinite pct
    labels = currentPartLabels()
    changed = labels.some (label) -> partValueOf(partSizes, label, DEFAULT_PART_SIZE) isnt pct
    partSizes = {}
    partSizes[label] = pct for label in labels when pct isnt DEFAULT_PART_SIZE
    savePartSettings()
    renderPartsList()
    partsChanged = true if changed

  # Applique le volume choisi à toutes les voix : immédiatement au moteur,
  # sans aucun re-rendu de la partition.
  $("parts-volumes-reset").addEventListener "change", (e) ->
    pct = parseInt e.target.value
    return renderPartsBulkSelects() unless isFinite pct
    labels = currentPartLabels()
    partVolumes = {}
    partVolumes[label] = pct for label in labels when pct isnt DEFAULT_PART_VOLUME
    savePartSettings()
    renderPartsList()
    applyVoiceAudio labels

  # Zoom slider: live label, apply on release
  $("zoom-range").addEventListener "input", (e) ->
    $("zoom-value").textContent = formatPercent e.target.value

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

  # Disposition : le mode change la pagination, donc on recharge la partition
  # (comme le zoom).
  for btn in document.querySelectorAll(".layout-btn")
    do (btn) ->
      btn.addEventListener "click", ->
        applyLayoutSetting btn.dataset.layout
        settings = loadSettings()
        settings.layout = layoutPreference
        saveSettings settings
        if fileLoaded and currentSources?.length
          reloadScore displayedPage()

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

  # Portées vides : option de rendu, appliquée au rechargement à la fermeture
  # du panneau (comme les tailles de voix et la transposition visuelle).
  emptyStavesBox = $("hide-empty-staves")
  if emptyStavesBox
    emptyStavesBox.addEventListener "change", (e) ->
      enabled = e.target.checked
      applyHideEmptyStaves enabled
      settings = loadSettings()
      settings.hideEmptyStaves = enabled
      saveSettings settings
      partsChanged = true

  # Surligner la mesure jouée : appliqué à chaud, sans re-rendu.
  highlightBox = $("highlight-measure")
  if highlightBox
    highlightBox.addEventListener "change", (e) ->
      enabled = e.target.checked
      applyHighlightMeasure enabled
      settings = loadSettings()
      settings.highlightMeasure = enabled
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

  # Piano seulement : réglage global, appliqué à chaud sans effacer les choix
  # d'instrument par voix (les sélecteurs restent visibles mais désactivés).
  pianoBox = $("piano-only")
  if pianoBox
    pianoBox.addEventListener "change", (e) ->
      enabled = e.target.checked
      applyPianoOnly enabled
      settings = loadSettings()
      settings.pianoOnly = enabled
      saveSettings settings
      renderPartsList()

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

