# Bibliothèque des fichiers enregistrés, navigation tactile et import de
# fichiers ou de dossiers depuis le disque.
# Library overlay
formatDate = (ts) ->
  d = new Date ts
  locale = window.__musicaI18n?.language() ? "en"
  d.toLocaleDateString locale, { day: "numeric", month: "short", year: "numeric" }

# Nom affiché d'une entrée : soulignés en espaces, « - » isolé en tiret
# demi-cadratin et extension retirée. Le nom stocké en base n'est jamais
# modifié.
displayName = (name) ->
  text = String(name or "")
    .replace(IMPORT_EXT_RE, "")
    .replace(/_/g, " ")
    .replace(/\s+-\s+/g, " – ")
    .replace(/\s+/g, " ")
    .trim()
  text or String(name or "")

# Suppressions en attente : l'entrée disparaît tout de suite, mais ses données
# ne sont effacées qu'à l'expiration du délai, pour que « Annuler » puisse la
# restaurer telle quelle (plusieurs suppressions s'empilent). L'identifiant est
# aussi noté dans localStorage : si la page se ferme avant l'expiration, la
# suppression est reprise au chargement suivant.
DELETE_UNDO_MS = 6000
DELETE_TOMBSTONE_KEY = "musica-deletes-pending"
pendingDeletes = new Map()

readTombstones = ->
  try
    JSON.parse(localStorage.getItem DELETE_TOMBSTONE_KEY) or []
  catch
    []

writeTombstones = (ids) ->
  try
    if ids.length then localStorage.setItem DELETE_TOMBSTONE_KEY, JSON.stringify ids
    else localStorage.removeItem DELETE_TOMBSTONE_KEY

addTombstone = (id) ->
  ids = readTombstones()
  ids.push id unless id in ids
  writeTombstones ids

removeTombstone = (id) ->
  writeTombstones readTombstones().filter (kept) -> kept isnt id

# Suppressions confirmées par la fermeture de la page : reprises au chargement.
flushStoredDeletes = ->
  ids = readTombstones()
  return Promise.resolve() unless ids.length
  Promise.all(ids.map (id) ->
    storage.deleteFile(id).then -> removeTombstone id
  ).catch -> undefined

isPendingDelete = (id) ->
  pendingDeletes.has(id) or id in readTombstones()

# Fichiers récents de l'accueil (5 au plus)
RECENT_LIMIT = 5

renderLibrary = ->
  renderDeleteToasts()
  list = $("library-list")
  storage.listFiles().then (files) ->
    visible = (file for file in files when not isPendingDelete file.id)
    updateClearAllButton visible.length
    if visible.length is 0
      list.innerHTML = "<div class=\"library-empty\">#{t 'library.empty'}</div>"
      return
    list.innerHTML = ""
    for file in visible
      do (file) ->
        item = document.createElement "div"
        item.className = "library-item"
        count = file.files?.length or 0
        meta = formatDate file.addedAt
        meta += " · #{t 'library.fileCount', {count}}" if count > 1
        name = displayName file.name
        info = document.createElement "div"
        info.className = "library-item-info"
        nameEl = document.createElement "div"
        nameEl.className = "library-item-name"
        nameEl.textContent = name
        nameEl.title = name
        dateEl = document.createElement "div"
        dateEl.className = "library-item-date"
        dateEl.textContent = meta
        info.appendChild nameEl
        info.appendChild dateEl
        remove = document.createElement "button"
        remove.type = "button"
        remove.className = "library-item-delete"
        remove.textContent = "✕"
        remove.title = t "library.deleteAria", {name}
        remove.setAttribute "aria-label", remove.title
        info.addEventListener "click", ->
          openFromLibrary file.id
        remove.addEventListener "click", (e) ->
          e.stopPropagation()
          deleteFromLibrary file.id
        item.appendChild info
        item.appendChild remove
        list.appendChild item

# « Tout effacer » n'a de sens que s'il reste au moins une entrée visible.
updateClearAllButton = (count) ->
  button = $("library-clear-btn")
  return unless button
  if count > 0 then button.classList.remove "hidden" else button.classList.add "hidden"

# Bandeau de suppression différée, reconstruit depuis l'état (donc traduit à
# nouveau si la langue change). Un bandeau par suppression, empilés.
renderDeleteToasts = ->
  container = $("library-toasts")
  return unless container
  container.innerHTML = ""
  pendingDeletes.forEach (entry, id) ->
    toast = document.createElement "div"
    toast.className = "library-toast"
    text = document.createElement "span"
    text.className = "library-toast-text"
    text.textContent = t "library.deleted", {name: entry.displayName}
    undo = document.createElement "button"
    undo.type = "button"
    undo.className = "library-toast-undo"
    undo.textContent = t "library.undo"
    undo.title = t "library.undoAria", {name: entry.displayName}
    undo.setAttribute "aria-label", undo.title
    undo.addEventListener "click", -> undoDelete id
    toast.appendChild text
    toast.appendChild undo
    container.appendChild toast

# Accueil : accroche construite à partir de src/formats.coffee (source unique
# des formats) et fichiers récents de la bibliothèque.
renderHomeTexts = ->
  tagline = $("import-tagline")
  return unless tagline
  labels = window.__musicaFormats?.formatLabels or []
  locale = window.__musicaI18n?.language() ? "en"
  formats = if labels.length is 0
    ""
  else
    try
      new Intl.ListFormat(locale, {style: "long", type: "conjunction"}).format labels
    catch
      labels.join ", "
  tagline.textContent = t "import.tagline", {formats}

renderRecentFiles = ->
  section = $("import-recents")
  list = $("recent-list")
  return unless section and list
  storage.listFiles().then (files) ->
    recent = (file for file in files when not isPendingDelete file.id).slice 0, RECENT_LIMIT
    list.innerHTML = ""
    if recent.length is 0
      section.classList.add "hidden"
      return
    section.classList.remove "hidden"
    for file in recent
      do (file) ->
        name = displayName file.name
        button = document.createElement "button"
        button.type = "button"
        button.className = "recent-item"
        button.textContent = name
        button.title = t "library.openAria", {name}
        button.setAttribute "aria-label", button.title
        button.addEventListener "click", -> openFromLibrary file.id
        list.appendChild button
  .catch ->
    section.classList.add "hidden"

showLibrary = ->
  # Retour à la bibliothèque : la lecture s'arrête et le contexte audio est
  # libéré. La barre du bas s'efface sous le panneau plein écran.
  hideCommandBar()
  hideTransport()
  resetPlayback()
  renderLibrary()
  $("library-overlay").classList.remove "hidden"

hideLibrary = ->
  $("library-overlay").classList.add "hidden"
  showCommandBar() if fileLoaded

openFromLibrary = (id) ->
  hideLibrary()
  showLoading()
  storage.getFile(id).then (file) ->
    return showError(t "library.notFound") unless file
    currentFileId = id
    # ancienne entrée {xml} : une seule source texte
    sources = if file.files?.length
      file.files
    else
      [{ name: "#{file.name}.musicxml", data: file.xml }]
    storage.getPosition(id).then (page) ->
      loadSources sources, page

# Retire la partition affichée sans toucher à la bibliothèque.
resetLoadedScore = ->
  currentFileId = null
  currentSources = null
  sourceCache.clear()
  reinitialiserBascule()
  loadToken++  # stop background conversions of the deleted score
  # Les demandes de lecture en cours appartiennent au chargement supprimé :
  # les rejeter, sinon elles resteraient en attente (aucune réponse ne peut
  # plus satisfaire leur jeton) et une nouvelle demande de même clé serait
  # dédupliquée sur une promesse morte.
  pendingPlayback.forEach (pending) -> pending.reject new Error "Chargement remplacé"
  pendingPlayback.clear()
  movementLoadTokens.clear()
  fileLoaded = false
  # Rien ne reste à charger : retirer l'indicateur et les compteurs
  hideLoadingIndicator()
  hideLoading()
  pageCount = 0
  movements = []
  targetPage = null
  $("page-current").innerHTML = ""
  pageNumberEl = $("page-number")
  pageNumberEl.textContent = "" if pageNumberEl
  pageIndicatorEl = $("page-indicator")
  pageIndicatorEl.textContent = "" if pageIndicatorEl
  showImport()

# Suppression différée : les données restent en base jusqu'à l'expiration (ou
# à la fermeture de la page), ce qui rend « Annuler » immédiat et fidèle.
deleteFromLibrary = (id) ->
  return if pendingDeletes.has id
  # La tombe est posée tout de suite : même si la page se ferme avant la
  # lecture de l'entrée, la suppression sera reprise au chargement suivant.
  addTombstone id
  renderLibrary()
  renderRecentFiles()
  storage.getFile(id).then (file) ->
    unless file
      removeTombstone id
      renderLibrary()
      renderRecentFiles()
      return
    resetLoadedScore() if currentFileId is id
    entry =
      displayName: displayName file.name
      timer: setTimeout (-> commitDelete id), DELETE_UNDO_MS
    pendingDeletes.set id, entry
    renderLibrary()
    renderRecentFiles()

undoDelete = (id) ->
  entry = pendingDeletes.get id
  return unless entry
  clearTimeout entry.timer
  pendingDeletes.delete id
  removeTombstone id
  renderLibrary()
  renderRecentFiles()

commitDelete = (id) ->
  entry = pendingDeletes.get id
  return unless entry
  clearTimeout entry.timer
  pendingDeletes.delete id
  storage.deleteFile(id).then ->
    removeTombstone id
    renderLibrary()
    renderRecentFiles()

# Fermer la page confirme les suppressions encore en attente.
flushPendingDeletes = ->
  pendingDeletes.forEach (entry, id) ->
    clearTimeout entry.timer
    storage.deleteFile id
  pendingDeletes.clear()

window.addEventListener "pagehide", flushPendingDeletes

showClearDialog = ->
  $("clear-overlay").classList.remove "hidden"
  $("clear-cancel").focus()

hideClearDialog = ->
  $("clear-overlay").classList.add "hidden"

clearLibrary = ->
  hideClearDialog()
  pendingDeletes.forEach (entry) -> clearTimeout entry.timer
  pendingDeletes.clear()
  writeTombstones []
  storage.clearAll().then ->
    resetLoadedScore() if fileLoaded or currentFileId?
    renderLibrary()
    renderRecentFiles()

setupClearLibrary = ->
  $("library-clear-btn").addEventListener "click", showClearDialog
  $("clear-cancel").addEventListener "click", hideClearDialog
  $("clear-confirm").addEventListener "click", clearLibrary
  $("clear-overlay").addEventListener "click", (e) ->
    hideClearDialog() if e.target is $("clear-overlay")
  document.addEventListener "keydown", (e) ->
    return unless e.key is "Escape"
    hideClearDialog() unless $("clear-overlay").classList.contains "hidden"

# Start app after Verovio is ready: show library or import
startApp = ->
  # A file was already picked while the worker was starting: keep it
  return if currentSources?.length
  flushStoredDeletes().then ->
    renderHomeTexts()
    renderRecentFiles()
    storage.listFiles().then (files) ->
      if files.length > 0
        showLibrary()
      else
        showImport()

# Navigation by tap
setupNavigation = ->
  $("tap-left").addEventListener "click", (e) ->
    e.preventDefault()
    goPrev()

  $("tap-right").addEventListener "click", (e) ->
    e.preventDefault()
    goNext()

  # Navigation buttons
  for btn in document.querySelectorAll(".nav-btn")
    do (btn) ->
      btn.addEventListener "click", (e) ->
        e.preventDefault()
        action = btn.dataset.action
        switch action
          when "prev-mov" then goToPrevMovement()
          when "next-mov" then goToNextMovement()

  # Keyboard navigation
  document.addEventListener "keydown", (e) ->
    return unless fileLoaded
    return if isFormField e.target
    # Espace activé sur un contrôle de la barre : laisser le bouton faire son
    # action au lieu de tourner la page en plus.
    return if e.key is " " and e.target.closest?("#command-bar, #command-menu, #page-jump")
    switch e.key
      when "ArrowRight", " "
        e.preventDefault()
        goNext()
      when "ArrowLeft"
        e.preventDefault()
        goPrev()

# Ask the worker to convert a scoretk file (MuseScore, LilyPond, ABC, MIDI) to
# MusicXML. `name` permet au worker de déduire `from` de l'extension.
# `includes` (table chemin relatif -> octets) est transmise telle quelle au
# résolveur d'\include de scoretk pour les sources LilyPond d'un dossier.
# `options.from` force le format d'entrée (source convertie en gabc, quel que
# soit son nom) et `options.to` le format de sortie ("musicxml" par défaut).
convertScoretk = (buffer, name, includes, options = {}) ->
  new Promise (resolve, reject) ->
    id = ++scoretkRequestId
    pendingScoretk.set id, {resolve, reject}
    message = { type: "convertScoretk", id, bytes: buffer, name }
    message.includes = includes if includes?
    message.from = options.from if options.from?
    message.to = options.to if options.to?
    worker.postMessage message, [buffer]

convertScoretkToXml = (buffer, name, includes, from) ->
  convertScoretk buffer, name, includes, {from, to: "musicxml"}

# Conversion d'un MEI neumatique / MusicXML issu de gabc vers le texte gabc :
# le chemin gabc (notation carrée) prend ensuite le relais.
convertScoretkToGabc = (buffer, name, from, includes) ->
  convertScoretk buffer, name, includes, {from, to: "gabc"}

# Extensions importables : dérivées de src/formats.coffee, source unique
# partagée avec build.js (attribut `accept`) et le service worker. Sans
# doublon : gabc est à la fois lisible directement et convertible.
IMPORT_EXTENSIONS = Array.from new Set window.__musicaFormats.baseExtensions.concat SCORETK_EXTENSIONS

# Regex unique, construite une fois : test d'extension et retrait de l'extension
IMPORT_EXT_RE = new RegExp "\\.(#{IMPORT_EXTENSIONS.join '|'})$", 'i'

# Texte du message d'erreur, dérivé de la même liste
IMPORT_EXTENSIONS_TEXT = (".#{ext}" for ext in IMPORT_EXTENSIONS).join ', '

# Extensions gardées dans un dossier (les autres, p. ex. .pdf, sont ignorées)
isCompatibleFile = (name) -> IMPORT_EXT_RE.test name

# Auxiliaires typiques d'un dossier LilyPond : .ily, .lyi. Les autres
# extensions sont gardées si un \include les cite (voir includeTargets).
isLilypondAuxiliary = (name) -> /\.(ily|lyi)$/i.test name

# Chemin relatif à la racine du dossier importé (sans son premier segment,
# fourni par webkitRelativePath). En sélection multiple, le nom du fichier
# suffit.
relativePath = (file) ->
  raw = file.webkitRelativePath or file.name or ""
  parts = raw.split "/"
  parts.shift() if parts.length > 1
  parts.join "/"

# Chemins demandés par les \include d'une source. Seule la forme textuelle
# est reconnue, comme dans le sous-ensemble lu par scoretk.
includeTargets = (text) ->
  targets = []
  pattern = /\\include\s+(?:"([^"]+)"|'([^']+)')/g
  while (match = pattern.exec text)
    target = (match[1] or match[2]).replace /^\.\//, ""
    targets.push target
  targets

baseName = (name) -> name.replace IMPORT_EXT_RE, ""

# Lit le contenu brut d'un fichier (aucune conversion à l'import)
readFileBuffer = (file) ->
  new Promise (resolve, reject) ->
    reader = new FileReader()
    reader.onload = (ev) -> resolve ev.target.result
    reader.onerror = -> reject reader.error or new Error "lecture impossible"
    reader.readAsArrayBuffer file

# Nom de l'entrée : nom du dossier importé, sinon préfixe commun des noms,
# sinon nom du premier fichier
entryNameFor = (files) ->
  rel = files[0].webkitRelativePath or ""
  return rel.split("/")[0] if rel.includes "/"
  names = (file.name for file in files)
  prefix = names[0]
  for name in names[1..]
    i = 0
    i++ while i < prefix.length and i < name.length and prefix[i] is name[i]
    prefix = prefix[0...i]
  prefix = prefix.replace /[\s\-_.]+$/, ""
  # « 01- », « 02- »… ne donne qu'un numéro : préférer le premier nom
  if prefix is "" or /^\d+$/.test prefix then baseName names[0] else prefix

# Dossier : une seule entrée, mais seuls les fichiers principaux deviennent
# des partitions. Les fichiers cités par un \include (noaten.ily, ou un .ly
# inclus par un autre .ly) restent dans l'entrée comme sources auxiliaires et
# sont transmis à scoretk avec l'option additive `includes`.
handleFolderImport = (fileList) ->
  files = Array.from(fileList or [])
  if files.length is 0
    return showError t("errors.noCompatibleFile", {extensions: IMPORT_EXTENSIONS_TEXT})
  showLoading()
  hideImport()
  hideLibrary()

  files.sort (a, b) -> a.name.localeCompare b.name, undefined, {numeric: true}

  # Read files one by one: a folder can be large. Their text is needed to
  # know which ones are included by another and must not become pieces.
  entries = []
  readNext = (index) ->
    return Promise.resolve entries if index >= files.length
    readFileBuffer(files[index]).then (data) ->
      entries.push {
        name: files[index].name
        path: relativePath files[index]
        webkitRelativePath: files[index].webkitRelativePath
        data
      }
      readNext index + 1
  readNext(0)
    .then (all) ->
      byPath = {}
      for info in all
        byPath[info.path] = info
      included = new Set()
      decoder = new TextDecoder()
      for info in all
        for target in includeTargets decoder.decode new Uint8Array(info.data)
          exact = byPath[target]
          included.add exact if exact? and exact isnt info
          # LilyPond cherche aussi dans le dossier du fichier incluant : un
          # \include "noaten.ily" depuis sub/ peut viser sub/noaten.ily.
          base = target.split("/").pop()
          for other in all when other isnt info and other.name is base
            included.add other

      # Un fichier compatible non inclus est une pièce ; les .ily et les
      # fichiers inclus restent des sources auxiliaires de la même entrée.
      kept = (info for info in all when isCompatibleFile(info.name) or isLilypondAuxiliary(info.name) or included.has info)
      unless kept.length > 0
        showError t("errors.noCompatibleFile", {extensions: IMPORT_EXTENSIONS_TEXT})
        showImport()
        showLibraryBtn()
        return
      name = entryNameFor kept
      for info in kept
        if isCompatibleFile(info.name) and not included.has info
          info.role = "main"
          # Table complète du dossier, indexée comme dans webkitRelativePath.
          # Seuls les .ly en ont besoin : pas de recopie pour les .mscz.
          if /\.(ly|lilypond)$/i.test info.name
            info.includes = {}
            for other in kept when other isnt info
              info.includes[other.path] = other.data
        else
          info.role = "aux"
      storage.saveEntry(name, kept).then (id) ->
        currentFileId = id
        renderRecentFiles()
        loadSources kept, 1
    .catch (err) ->
      hideLoading()
      showError t("errors.folderRead", {error: err.message or err})
      showImport()
      showLibraryBtn()

# Un fichier seul : une entrée d'une source, comportement inchangé
handleFileImport = (file) ->
  return unless file
  showLoading()
  hideImport()
  hideLibrary()
  name = baseName file.name

  readFileBuffer(file)
    .then (data) ->
      sources = [{name: file.name, data}]
      storage.saveEntry(name, sources).then (id) ->
        currentFileId = id
        renderRecentFiles()
        loadSources sources, 1
    .catch (err) ->
      hideLoading()
      showError t("errors.fileRead", {error: err.message or err})
      showImport()
      showLibraryBtn()

# Un fichier sélectionné : import simple ; plusieurs : un dossier
handleImportFiles = (fileList) ->
  files = Array.from fileList or []
  return unless files.length > 0
  # Un fichier seul est filtré ici aussi (partage Android, sélection directe) :
  # une extension inconnue est refusée proprement au lieu d'échouer au rendu.
  # Plusieurs fichiers forment un dossier : handleFolderImport garde alors les
  # auxiliaires cités par un \include, même avec une extension inhabituelle.
  if files.length is 1
    unless isCompatibleFile files[0].name
      showError t("errors.noCompatibleFile", {extensions: IMPORT_EXTENSIONS_TEXT})
      showImport()
      return
    handleFileImport files[0]
  else
    handleFolderImport files

setupImport = ->
  fileInput = $("file-input")
  $("import-btn").addEventListener "click", ->
    fileInput.click()
  fileInput.addEventListener "change", (e) ->
    handleImportFiles e.target.files
    e.target.value = ""

  folderInput = $("folder-input")
  $("folder-btn").addEventListener "click", ->
    folderInput.click()
  folderInput.addEventListener "change", (e) ->
    handleFolderImport e.target.files
    e.target.value = ""

  setupClearLibrary()
  renderHomeTexts()
  renderRecentFiles()

