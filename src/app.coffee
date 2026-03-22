# App — logique principale

console.log "Musica — Liseuse MusicXML"

worker = window.__musicaWorker
storage = window.__musicaStorage
currentPage = 1
pageCount = 0
svgCache = new Map()
fileLoaded = false
indicatorTimeout = null
currentXml = null
currentFileId = null
lastWidth = window.innerWidth
resizeTimer = null
positionTimer = null
verovioReady = false
currentScale = 40

# Settings defaults
defaultSettings = { zoom: 40, theme: "white", tapSize: 30 }

loadSettings = ->
  try
    saved = localStorage.getItem "musica-settings"
    if saved then JSON.parse(saved) else Object.assign({}, defaultSettings)
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

applyAllSettings = ->
  settings = loadSettings()
  applyTheme settings.theme
  applyTapSize settings.tapSize
  applyZoom settings.zoom

# DOM refs
$ = (id) -> document.getElementById id

showLoading = ->
  $("overlay-loading").classList.remove "hidden"

hideLoading = ->
  $("overlay-loading").classList.add "hidden"

showError = (msg) ->
  $("error-message").textContent = msg
  $("overlay-error").classList.add "visible"

hideError = ->
  $("overlay-error").classList.remove "visible"

showImport = ->
  $("import-section").classList.remove "hidden"
  $("btn-library").classList.add "hidden"
  $("btn-settings").classList.add "hidden"

hideImport = ->
  $("import-section").classList.add "hidden"

showLibraryBtn = ->
  $("btn-library").classList.remove "hidden"
  $("btn-settings").classList.remove "hidden"

showIndicator = ->
  el = $("page-indicator")
  el.textContent = "#{currentPage} / #{pageCount}"
  el.classList.add "visible"
  clearTimeout indicatorTimeout if indicatorTimeout
  indicatorTimeout = setTimeout ->
    el.classList.remove "visible"
  , 1500

displayPage = (page) ->
  slot = $("page-current")
  cached = svgCache.get page
  if cached
    slot.innerHTML = cached
  else
    slot.innerHTML = '<div style="padding:40px;color:#999;text-align:center">Rendu en cours…</div>'
    worker.postMessage { type: "render", page }

purgeCacheFarPages = ->
  return if svgCache.size <= 5
  for key from svgCache.keys()
    if Math.abs(key - currentPage) > 2
      svgCache.delete key

prefetch = ->
  for p in [currentPage + 1, currentPage + 2]
    if p <= pageCount and not svgCache.has(p)
      worker.postMessage { type: "render", page: p }
  purgeCacheFarPages()

savePositionDebounced = ->
  return unless currentFileId
  clearTimeout positionTimer if positionTimer
  positionTimer = setTimeout ->
    storage.savePosition currentFileId, currentPage
  , 1000

goToPage = (page) ->
  return if page < 1 or page > pageCount
  currentPage = page
  displayPage currentPage
  showIndicator()
  prefetch()
  savePositionDebounced()

# Preprocess MusicXML: insert system breaks after double barlines
preprocessMusicXML = (xmlString) ->
  parser = new DOMParser()
  doc = parser.parseFromString xmlString, "application/xml"
  measures = Array.from doc.querySelectorAll("measure")
  for measure, i in measures
    barlines = measure.querySelectorAll('barline[location="right"]')
    hasBreak = false
    for barline in Array.from(barlines)
      barStyle = barline.querySelector("bar-style")
      if barStyle
        style = barStyle.textContent.trim()
        if style is "light-heavy" or style is "light-light"
          hasBreak = true
          break
    if hasBreak and i < measures.length - 1
      nextMeasure = measures[i + 1]
      existingPrint = nextMeasure.querySelector("print")
      if existingPrint
        existingPrint.setAttribute "new-system", "yes"
      else
        printEl = doc.createElementNS(
          nextMeasure.namespaceURI or "http://www.w3.org/1999/xhtml",
          "print"
        )
        printEl.setAttribute "new-system", "yes"
        nextMeasure.insertBefore printEl, nextMeasure.firstChild
  serializer = new XMLSerializer()
  serializer.serializeToString doc

# Load a score into the worker
loadXml = (xml, startPage = 1) ->
  currentXml = xml
  processedXml = preprocessMusicXML xml
  currentPage = startPage
  pw = Math.round(window.innerWidth * 100 / currentScale)
  ph = Math.round(window.innerHeight * 100 / currentScale)
  lastWidth = window.innerWidth
  svgCache.clear()
  showLoading()
  worker.postMessage { type: "load", xml: processedXml, pageWidth: pw, pageHeight: ph, scale: currentScale }

# Worker message handler
worker.onmessage = (e) ->
  {type} = e.data
  switch type
    when "ready"
      console.log "Verovio prêt"
      verovioReady = true
      hideLoading()
      startApp()

    when "loaded"
      pageCount = e.data.pageCount
      currentPage = Math.min(currentPage, pageCount) or 1
      fileLoaded = true
      hideLoading()
      hideImport()
      showLibraryBtn()
      console.log "Partition chargée: #{pageCount} pages"
      displayPage currentPage
      showIndicator()
      prefetch()

    when "svg"
      svgCache.set e.data.page, e.data.svg
      if e.data.page is currentPage
        $("page-current").innerHTML = e.data.svg

    when "error"
      console.error "Worker error:", e.data.message
      hideLoading()
      showError e.data.message

# Library overlay
formatDate = (ts) ->
  d = new Date ts
  d.toLocaleDateString "fr-FR", { day: "numeric", month: "short", year: "numeric" }

renderLibrary = ->
  list = $("library-list")
  storage.listFiles().then (files) ->
    if files.length is 0
      list.innerHTML = '<div class="library-empty">Aucun fichier enregistré</div>'
      return
    list.innerHTML = ""
    for file in files
      do (file) ->
        item = document.createElement "div"
        item.className = "library-item"
        item.innerHTML = """
          <div class="library-item-info">
            <div class="library-item-name">#{file.name}</div>
            <div class="library-item-date">#{formatDate file.addedAt}</div>
          </div>
          <button class="library-item-delete" title="Supprimer">✕</button>
        """
        item.querySelector(".library-item-info").addEventListener "click", ->
          openFromLibrary file.id
        item.querySelector(".library-item-delete").addEventListener "click", (e) ->
          e.stopPropagation()
          deleteFromLibrary file.id
        list.appendChild item

showLibrary = ->
  renderLibrary()
  $("library-overlay").classList.remove "hidden"

hideLibrary = ->
  $("library-overlay").classList.add "hidden"

openFromLibrary = (id) ->
  hideLibrary()
  showLoading()
  storage.getFile(id).then (file) ->
    return showError("Fichier introuvable") unless file
    currentFileId = id
    storage.getPosition(id).then (page) ->
      loadXml file.xml, page

deleteFromLibrary = (id) ->
  storage.deleteFile(id).then ->
    if currentFileId is id
      currentFileId = null
      currentXml = null
      fileLoaded = false
      $("page-current").innerHTML = ""
      showImport()
    renderLibrary()

# Start app after Verovio is ready: show library or import
startApp = ->
  storage.listFiles().then (files) ->
    if files.length > 0
      showLibrary()
    else
      showImport()

# Navigation by tap
setupNavigation = ->
  $("tap-left").addEventListener "click", (e) ->
    e.preventDefault()
    goToPage currentPage - 1 if fileLoaded

  $("tap-right").addEventListener "click", (e) ->
    e.preventDefault()
    goToPage currentPage + 1 if fileLoaded

  # Keyboard navigation
  document.addEventListener "keydown", (e) ->
    return unless fileLoaded
    switch e.key
      when "ArrowRight", " "
        e.preventDefault()
        goToPage currentPage + 1
      when "ArrowLeft"
        e.preventDefault()
        goToPage currentPage - 1

# File import (both from import-section and library overlay)
handleFileImport = (file) ->
  return unless file
  showLoading()
  hideImport()
  hideLibrary()
  name = file.name.replace(/\.(xml|musicxml|mxl)$/i, "")
  mxl = window.__musicaMxl

  if mxl.isMxlFile(file)
    # MXL: read as ArrayBuffer, unzip, extract XML
    reader = new FileReader()
    reader.onload = (ev) ->
      try
        xml = mxl.extractMxl ev.target.result
        storage.saveFile(name, xml).then (id) ->
          currentFileId = id
          loadXml xml, 1
      catch err
        hideLoading()
        showError "Erreur MXL : #{err.message}"
    reader.onerror = ->
      hideLoading()
      showError "Impossible de lire le fichier."
    reader.readAsArrayBuffer file
  else
    # Plain XML/MusicXML: read as text
    reader = new FileReader()
    reader.onload = (ev) ->
      xml = ev.target.result
      storage.saveFile(name, xml).then (id) ->
        currentFileId = id
        loadXml xml, 1
    reader.onerror = ->
      hideLoading()
      showError "Impossible de lire le fichier."
    reader.readAsText file

setupImport = ->
  fileInput = $("file-input")
  $("import-btn").addEventListener "click", ->
    fileInput.click()
  fileInput.addEventListener "change", (e) ->
    handleFileImport e.target.files[0]
    e.target.value = ""

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
    handleFileImport e.target.files[0]
    e.target.value = ""

# Resize handler with debounce
setupResize = ->
  window.addEventListener "resize", ->
    clearTimeout resizeTimer if resizeTimer
    resizeTimer = setTimeout ->
      return unless fileLoaded and currentXml
      newWidth = window.innerWidth
      change = Math.abs(newWidth - lastWidth) / lastWidth
      return if change < 0.05
      lastWidth = newWidth
      loadXml currentXml, currentPage
    , 300

# Settings overlay controls
setupSettings = ->
  $("btn-settings").addEventListener "click", ->
    $("settings-overlay").classList.remove "hidden"

  $("settings-close").addEventListener "click", ->
    $("settings-overlay").classList.add "hidden"

  # Zoom slider
  $("zoom-range").addEventListener "input", (e) ->
    val = parseInt e.target.value
    $("zoom-value").textContent = val
    currentScale = val
    settings = loadSettings()
    settings.zoom = val
    saveSettings settings
    # Re-render current score with new zoom
    if fileLoaded and currentXml
      loadXml currentXml, currentPage

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

# Init
document.addEventListener "DOMContentLoaded", ->
  applyAllSettings()
  setupNavigation()
  setupImport()
  setupLibrary()
  setupSettings()
  setupResize()
  # Init the Verovio worker
  worker.postMessage { type: "init" }
  console.log "Initialisation Verovio…"
