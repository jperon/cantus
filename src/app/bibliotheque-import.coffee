# Bibliothèque des fichiers enregistrés, navigation tactile et import de
# fichiers ou de dossiers depuis le disque.
# Library overlay
formatDate = (ts) ->
  d = new Date ts
  locale = window.__musicaI18n?.language() ? "en"
  d.toLocaleDateString locale, { day: "numeric", month: "short", year: "numeric" }

renderLibrary = ->
  list = $("library-list")
  storage.listFiles().then (files) ->
    if files.length is 0
      list.innerHTML = "<div class=\"library-empty\">#{t 'library.empty'}</div>"
      return
    list.innerHTML = ""
    for file in files
      do (file) ->
        item = document.createElement "div"
        item.className = "library-item"
        count = file.files?.length or 0
        meta = formatDate file.addedAt
        meta += " · #{t 'library.fileCount', {count}}" if count > 1
        item.innerHTML = """
          <div class="library-item-info">
            <div class="library-item-name">#{file.name}</div>
            <div class="library-item-date">#{meta}</div>
          </div>
          <button class="library-item-delete" title="#{t 'library.delete'}">✕</button>
        """
        item.querySelector(".library-item-info").addEventListener "click", ->
          openFromLibrary file.id
        item.querySelector(".library-item-delete").addEventListener "click", (e) ->
          e.stopPropagation()
          deleteFromLibrary file.id
        list.appendChild item

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

deleteFromLibrary = (id) ->
  storage.deleteFile(id).then ->
    if currentFileId is id
      currentFileId = null
      currentSources = null
      sourceCache.clear()
      loadToken++  # stop background conversions of the deleted score
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
    renderLibrary()

# Start app after Verovio is ready: show library or import
startApp = ->
  # A file was already picked while the worker was starting: keep it
  return if currentSources?.length
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
convertScoretkToXml = (buffer, name) ->
  new Promise (resolve, reject) ->
    id = ++scoretkRequestId
    pendingScoretk.set id, {resolve, reject}
    worker.postMessage { type: "convertScoretk", id, bytes: buffer, name }, [buffer]

# Extensions importables : dérivées de src/formats.coffee, source unique
# partagée avec build.js (attribut `accept`) et le service worker.
IMPORT_EXTENSIONS = window.__musicaFormats.baseExtensions.concat SCORETK_EXTENSIONS

# Regex unique, construite une fois : test d'extension et retrait de l'extension
IMPORT_EXT_RE = new RegExp "\\.(#{IMPORT_EXTENSIONS.join '|'})$", 'i'

# Texte du message d'erreur, dérivé de la même liste
IMPORT_EXTENSIONS_TEXT = (".#{ext}" for ext in IMPORT_EXTENSIONS).join ', '

# Extensions gardées dans un dossier (les autres, p. ex. .pdf, sont ignorées)
isCompatibleFile = (name) -> IMPORT_EXT_RE.test name

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

# Dossier : plusieurs fichiers compatibles forment une seule entrée
handleFolderImport = (fileList) ->
  files = Array.from(fileList or []).filter (file) -> isCompatibleFile file.name
  unless files.length > 0
    return showError t("errors.noCompatibleFile", {extensions: IMPORT_EXTENSIONS_TEXT})
  showLoading()
  hideImport()
  hideLibrary()

  files.sort (a, b) -> a.name.localeCompare b.name, undefined, {numeric: true}
  name = entryNameFor files

  # Read files one by one: a folder can be large
  sources = []
  readNext = (index) ->
    return Promise.resolve() if index >= files.length
    readFileBuffer(files[index]).then (data) ->
      sources.push {name: files[index].name, data}
      readNext index + 1
  readNext(0)
    .then ->
      storage.saveEntry(name, sources).then (id) ->
        currentFileId = id
        loadSources sources, 1
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
  files = files.filter (file) -> isCompatibleFile file.name
  unless files.length > 0
    showError t("errors.noCompatibleFile", {extensions: IMPORT_EXTENSIONS_TEXT})
    showImport()
    return
  if files.length is 1
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

