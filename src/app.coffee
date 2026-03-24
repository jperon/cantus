buildDate = window.__musicaBuildDate ? "(non défini)"

# App — logique principale (worker-based with movement support)

console.log "Musica — Liseuse MusicXML"
console.log "Date de build : #{buildDate}"

# Display build date in bottom-left corner
document.addEventListener "DOMContentLoaded", ->
  buildDateEl = document.getElementById("build-date")
  if buildDateEl
    # Format: "2026-03-23T15:25:45.733Z" -> "Build: 23/03 17:25"
    try
      date = new Date(buildDate)
      formatted = "Build: #{date.toLocaleDateString('fr-FR', {day: '2-digit', month: '2-digit'})} #{date.toLocaleTimeString('fr-FR', {hour: '2-digit', minute: '2-digit'})}"
      buildDateEl.textContent = formatted
    catch
      buildDateEl.textContent = buildDate

# Service Worker management - Local First PWA
setupServiceWorker = ->
  if 'serviceWorker' in navigator
    navigator.serviceWorker.register('/sw.js')
      .then (registration) ->
        console.log "Service Worker enregistré:", registration.scope

        # Écouter les mises à jour du service worker
        registration.addEventListener 'updatefound', ->
          newWorker = registration.installing
          console.log "Nouveau Service Worker détecté"

          newWorker.addEventListener 'statechange', ->
            if newWorker.state is 'installed' and navigator.serviceWorker.controller
              # Un nouveau SW est prêt et il y en a déjà un actif
              showUpdateNotification()

        # Écouter les messages du service worker
        navigator.serviceWorker.addEventListener 'message', handleServiceWorkerMessage

      .catch (error) ->
        console.error "Erreur d'enregistrement du Service Worker:", error

# Gérer les messages du service worker
handleServiceWorkerMessage = (event) ->
  {type, data, timestamp} = event.data

  switch type
    when 'update'
      console.log "Mise à jour disponible:", data
      showUpdateMessage(data.message)

    when 'cache-updated'
      console.log "Cache mis à jour:", data

# Afficher une notification de mise à jour
showUpdateNotification = ->
  notification = document.createElement 'div'
  notification.className = 'update-notification'
  notification.innerHTML = '''
    <div class="update-content">
      <span>🔄 Une nouvelle version est disponible</span>
      <button id="update-btn">Mettre à jour</button>
      <button id="dismiss-btn">Plus tard</button>
    </div>
  '''

  # Style de la notification
  notification.style.cssText = '''
    position: fixed;
    top: 20px;
    right: 20px;
    background: #4CAF50;
    color: white;
    padding: 15px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 10000;
    max-width: 300px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  '''

  # Ajouter les styles pour les boutons
  style = document.createElement 'style'
  style.textContent = '''
    .update-content {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .update-content button {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: background-color 0.2s;
    }
    #update-btn {
      background: white;
      color: #4CAF50;
      font-weight: bold;
    }
    #update-btn:hover {
      background: #f0f0f0;
    }
    #dismiss-btn {
      background: transparent;
      color: white;
      border: 1px solid white;
    }
    #dismiss-btn:hover {
      background: rgba(255,255,255,0.1);
    }
  '''

  document.head.appendChild style
  document.body.appendChild notification

  # Gérer les clics
  document.getElementById('update-btn').addEventListener 'click', ->
    # Demander au nouveau service worker de s'activer
    navigator.serviceWorker.getRegistration().then (registration) ->
      if registration.waiting
        registration.waiting.postMessage {type: 'SKIP_WAITING'}
        # Recharger après un court délai
        setTimeout ->
          window.location.reload()
        , 1000

  document.getElementById('dismiss-btn').addEventListener 'click', ->
    notification.remove()

  # Auto-dismiss après 30 secondes
  setTimeout ->
    if notification.parentNode
      notification.remove()
  , 30000

# Afficher un message de mise à jour simple
showUpdateMessage = (message) ->
  messageEl = document.createElement 'div'
  messageEl.className = 'update-message'
  messageEl.textContent = message
  messageEl.style.cssText = '''
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #2196F3;
    color: white;
    padding: 10px 20px;
    border-radius: 20px;
    font-size: 14px;
    z-index: 9999;
    opacity: 0;
    transition: opacity 0.3s;
  '''

  document.body.appendChild messageEl

  # Animation d'apparition
  setTimeout ->
    messageEl.style.opacity = '1'
  , 100

  # Auto-disparition après 5 secondes
  setTimeout ->
    messageEl.style.opacity = '0'
    setTimeout ->
      if messageEl.parentNode
        messageEl.remove()
    , 300
  , 5000

# Initialiser le service worker
setupServiceWorker()

storage = window.__musicaStorage
worker = window.__musicaWorker
svgStore = window.__svgCache  # Persistent cache with compression
currentPage = 1
scrollPos = 0
pageCount = 0
memoryCache = new Map()  # In-memory cache for current session
fileLoaded = false
indicatorTimeout = null
currentXml = null
currentFileId = null
lastWidth = window.innerWidth
resizeTimer = null
positionTimer = null
workerReady = false
currentScale = 40
verticalScrollRatio = 0
currentPageWidth = 0
currentPageHeight = 0

# Movement tracking
movements = []  # [{id, pageCount, loaded}]
pendingRenders = new Map()  # "movementId:page" -> resolve function
pendingMovementLoads = new Map()  # movementId -> resolve function
targetPage = null  # Page to navigate to once all movements are loaded
currentSplitInfo = null  # Split info for lazy extraction

# Worker message handler
worker.onmessage = (e) ->
  {type} = e.data
  switch type
    when "ready"
      console.log "Worker Verovio prêt"
      workerReady = true
      hideLoading()
      startApp()

    when "movementLoaded"
      {movementId, pageCount: mvPages} = e.data
      console.log "Mouvement #{movementId} chargé: #{mvPages} pages"
      mv = movements.find (m) -> m.id is movementId
      if mv
        mv.pageCount = mvPages
        mv.loaded = true
      # Update total page count
      pageCount = movements.reduce (sum, m) ->
        sum + (m.pageCount or 0)
      , 0
      # Update page indicator
      showIndicator()
      # Resolve pending movement load promise if any
      if pendingMovementLoads?.has(movementId)
        pendingMovementLoads.get(movementId)()
        pendingMovementLoads.delete(movementId)
      # Hide loading overlay and render first pages once first movement is ready
      if movementId is 1
        hideLoading()
        if mvPages > 0
          # Request first pages immediately so displayView can show them
          requestPage(1, 1).then (svg) ->
            displayView()
            # Now load subsequent movements after first page is displayed
            loadRemainingMovements()
          if mvPages > 1
            requestPage(1, 2)
          prefetch()
          # Check if all pages are already cached (from persistent cache)
          if memoryCache.size >= pageCount and pageCount > 0
            hideLoadingIndicator()
      # Navigate to target page if all movements are loaded
      if targetPage and movements.every((m) -> m.loaded)
        goToPage targetPage
        targetPage = null

    when "svg"
      {movementId, page, svg} = e.data
      # Convert movement-local page to global page number
      globalPage = page
      for m in movements when m.id < movementId
        globalPage += m.pageCount or 0
      memoryCache.set globalPage, svg
      # Store in persistent cache (async, non-blocking)
      if currentFileId and currentPageWidth and currentPageHeight
        svgStore.set(currentFileId, globalPage, svg, currentPageWidth, currentPageHeight).catch (err) ->
          console.error "Erreur stockage SVG:", err
      # Resolve pending render if any
      key = "#{movementId}:#{page}"
      if pendingRenders.has(key)
        pendingRenders.get(key)(svg)
        pendingRenders.delete(key)
      # Note: displayView() is now async, so we don't call it here
      # The async displayView will update when pages are loaded

      # Hide loading indicator if all pages are cached
      if memoryCache.size >= pageCount and pageCount > 0
        hideLoadingIndicator()

    when "error"
      {message, movementId} = e.data
      console.error "Worker error:", message
      if movementId
        showError "Erreur mouvement #{movementId}: #{message}"
      else
        showError message

# Calculate global page from movementId and localPage
getGlobalPage = (movementId, localPage) ->
  offset = 0
  for m in movements when m.id < movementId
    offset += m.pageCount or 0
  offset + localPage

# Request SVG from worker, returns Promise
# Checks persistent cache first if fileId is available
requestPage = (movementId, localPage) ->
  globalPage = getGlobalPage(movementId, localPage)

  # Check memory cache first
  if memoryCache.has(globalPage)
    return Promise.resolve(memoryCache.get(globalPage))

  # Check persistent cache if fileId available
  if currentFileId and currentPageWidth and currentPageHeight
    return svgStore.get(currentFileId, globalPage, currentPageWidth, currentPageHeight).then (svg) ->
      if svg
        memoryCache.set(globalPage, svg)
        return svg
      # Not in cache, request from worker
      return requestFromWorker(movementId, localPage)

  # No fileId, request from worker
  requestFromWorker(movementId, localPage)

# Actually request from worker
requestFromWorker = (movementId, localPage) ->
  new Promise (resolve) ->
    key = "#{movementId}:#{localPage}"
    pendingRenders.set key, resolve
    worker.postMessage
      type: "renderMovementPage"
      movementId: movementId
      page: localPage

# Get movement and local page from global page number
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
  topPage = Math.floor(scrollPos / 2) + 1
  el.textContent = "#{topPage} / #{pageCount}"
  el.classList.add "visible"
  # Update page number in nav buttons
  pageNumberEl = $("page-number")
  if pageNumberEl
    pageNumberEl.textContent = "#{topPage}/#{pageCount}"
  clearTimeout indicatorTimeout if indicatorTimeout
  indicatorTimeout = setTimeout ->
    el.classList.remove "visible"
  , 1500

# Render two pages side by side with horizontal offset (50% scroll)
renderPageSync = (globalPage) ->
  return memoryCache.get(globalPage) if memoryCache.has(globalPage)
  # Request from worker (requestPage checks persistent cache first)
  result = getMovementForPage(globalPage)
  return "" unless result
  {movement, localPage} = result
  requestPage(movement.id, localPage)
  # Return loading placeholder while waiting for worker
  '<div class="loading-placeholder">Chargement...</div>'

renderPageAsync = (globalPage) ->
  return Promise.resolve(memoryCache.get(globalPage)) if memoryCache.has(globalPage)
  result = getMovementForPage(globalPage)
  return Promise.resolve("") unless result
  {movement, localPage} = result
  requestPage(movement.id, localPage)

displayView = ->
  slot = $("page-current")
  topPage = Math.floor(scrollPos / 2) + 1
  bottomPage = topPage + 1
  offset = (scrollPos % 2) * 50

  # Show loading placeholder immediately
  slot.innerHTML = ""
  wrapper = document.createElement "div"
  wrapper.className = "scroll-wrapper"
  wrapper.style.transform = "translateX(-#{offset}vw)"

  leftDiv = document.createElement "div"
  leftDiv.className = "scroll-page"
  leftDiv.innerHTML = '<div class="loading-placeholder">Chargement...</div>'
  wrapper.appendChild leftDiv

  if bottomPage <= pageCount
    rightDiv = document.createElement "div"
    rightDiv.className = "scroll-page"
    rightDiv.innerHTML = '<div class="loading-placeholder">Chargement...</div>'
    wrapper.appendChild rightDiv

  slot.appendChild wrapper

  # Render pages asynchronously and update when ready
  Promise.all([
    renderPageAsync(topPage),
    renderPageAsync(bottomPage) if bottomPage <= pageCount
  ]).then ([leftSvg, rightSvg]) ->
    # Update with actual content
    leftDiv.innerHTML = leftSvg
    if rightSvg
      rightDiv.innerHTML = rightSvg

    requestAnimationFrame ->
      if slot.scrollHeight > slot.clientHeight and verticalScrollRatio > 0
        slot.scrollTop = verticalScrollRatio * (slot.scrollHeight - slot.clientHeight)
      applyVerticalAlignment()

prefetch = ->
  topPage = Math.floor(scrollPos / 2) + 1
  for p in [topPage + 1, topPage + 2, topPage + 3, topPage + 4, topPage + 5]
    if p <= pageCount and not memoryCache.has(p)
      result = getMovementForPage(p)
      if result
        {movement, localPage} = result
        requestPage(movement.id, localPage)
  purgeCacheFarPages()

purgeCacheFarPages = ->
  topPage = Math.floor(scrollPos / 2) + 1
  return if memoryCache.size <= 7
  for key from memoryCache.keys()
    if Math.abs(key - topPage) > 3
      memoryCache.delete key

savePositionDebounced = ->
  return unless currentFileId
  clearTimeout positionTimer if positionTimer
  positionTimer = setTimeout ->
    page = Math.floor(scrollPos / 2) + 1
    storage.savePosition currentFileId, page
  , 1000

maxScrollPos = -> (pageCount * 2) - 2

# Proportional vertical alignment: each page's SVG gets independent translateY
# so pages with different heights stay aligned based on scroll ratio
applyVerticalAlignment = ->
  slot = $("page-current")
  maxScroll = slot.scrollHeight - slot.clientHeight
  return unless maxScroll > 0
  ratio = slot.scrollTop / maxScroll
  viewH = slot.clientHeight
  pages = slot.querySelectorAll(".scroll-page")
  for page in pages
    svg = page.querySelector("svg")
    continue unless svg
    svgH = svg.getBoundingClientRect().height
    idealY = ratio * Math.max(0, svgH - viewH)
    actualY = slot.scrollTop
    compensation = actualY - idealY
    svg.style.transform = "translateY(#{compensation}px)"

captureVerticalScroll = ->
  slot = $("page-current")
  maxScroll = slot.scrollHeight - slot.clientHeight
  if maxScroll > 0
    verticalScrollRatio = slot.scrollTop / maxScroll

goNext = ->
  return unless fileLoaded
  return if scrollPos >= maxScrollPos()
  captureVerticalScroll()
  scrollPos++
  currentPage = Math.floor(scrollPos / 2) + 1
  displayView()
  showIndicator()
  prefetch()
  savePositionDebounced()

goPrev = ->
  return unless fileLoaded
  return if scrollPos <= 0
  captureVerticalScroll()
  scrollPos--
  currentPage = Math.floor(scrollPos / 2) + 1
  displayView()
  showIndicator()
  prefetch()
  savePositionDebounced()

# Get current movement index from page
getCurrentMovementIndex = ->
  topPage = Math.floor(scrollPos / 2) + 1
  offset = 0
  for m, i in movements
    offset += m.pageCount or 0
    if offset >= topPage
      return i
  movements.length - 1

# Get first page of a movement (1-indexed)
getMovementStartPage = (movIndex) ->
  page = 1
  for m, i in movements when i < movIndex
    page += m.pageCount or 0
  page

# Navigation functions
goToPage = (page) ->
  return unless fileLoaded and page >= 1 and page <= pageCount
  scrollPos = (page - 1) * 2
  currentPage = page
  displayView()
  showIndicator()
  prefetch()
  savePositionDebounced()

goToStart = ->
  return unless fileLoaded
  scrollPos = 0
  currentPage = 1
  displayView()
  showIndicator()
  prefetch()
  savePositionDebounced()

goToEnd = ->
  return unless fileLoaded
  scrollPos = maxScrollPos()
  currentPage = Math.floor(scrollPos / 2) + 1
  displayView()
  showIndicator()
  prefetch()
  savePositionDebounced()

goToPrevMovement = ->
  return unless fileLoaded
  currentIdx = getCurrentMovementIndex()
  return if currentIdx <= 0
  targetPage = getMovementStartPage(currentIdx - 1)
  scrollPos = (targetPage - 1) * 2
  currentPage = targetPage
  displayView()
  showIndicator()
  prefetch()
  savePositionDebounced()

goToNextMovement = ->
  return unless fileLoaded
  currentIdx = getCurrentMovementIndex()
  return if currentIdx >= movements.length - 1
  targetPage = getMovementStartPage(currentIdx + 1)
  scrollPos = (targetPage - 1) * 2
  currentPage = targetPage
  displayView()
  showIndicator()
  prefetch()
  savePositionDebounced()

goBack5 = ->
  return unless fileLoaded
  scrollPos = Math.max(0, scrollPos - 10)
  currentPage = Math.floor(scrollPos / 2) + 1
  displayView()
  showIndicator()
  prefetch()
  savePositionDebounced()

goForward5 = ->
  return unless fileLoaded
  scrollPos = Math.min(maxScrollPos(), scrollPos + 10)
  currentPage = Math.floor(scrollPos / 2) + 1
  displayView()
  showIndicator()
  prefetch()
  savePositionDebounced()

# Detect split points and capture attributes at each point (lazy approach)
# Returns {splitPoints, splitAttrs, totalMeasures, parts}
detectSplitPoints = (xmlString) ->
  parser = new DOMParser()
  doc = parser.parseFromString xmlString, "application/xml"

  parts = doc.querySelectorAll("part")
  unless parts.length > 0
    return {splitPoints: [], splitAttrs: {}, totalMeasures: 0, parts: null}

  firstPartMeasures = parts[0].querySelectorAll("measure")
  totalMeasures = firstPartMeasures.length
  MAX_MEASURES_PER_MOVEMENT = 50

  splitPoints = []

  # PHASE 1: Movement metadata
  for measure, i in firstPartMeasures
    mn = measure.querySelector("movement-number")
    if mn and i > 0
      splitPoints.push i
      console.log "Mouvement déclaré à la mesure #{i}"

  # PHASE 2: Split at double barlines if needed
  if splitPoints.length is 0 and totalMeasures > MAX_MEASURES_PER_MOVEMENT
    allDoubleBarlines = []
    for measure, i in firstPartMeasures
      continue if i is 0 or i >= totalMeasures - 2
      barlines = measure.querySelectorAll('barline[location="right"]')
      for barline in Array.from(barlines)
        barStyle = barline.querySelector("bar-style")
        if barStyle
          style = barStyle.textContent.trim()
          if style is "light-heavy"
            hasDS = measure.querySelector('sound[dalsegno]')
            hasDC = measure.querySelector('sound[dacapo]')
            unless hasDS or hasDC
              nextMeasure = firstPartMeasures[i + 1]
              if nextMeasure and nextMeasure.querySelector("note")
                allDoubleBarlines.push i + 1

    prevSplit = 0
    for sp in allDoubleBarlines
      segmentSize = sp - prevSplit
      if segmentSize >= MAX_MEASURES_PER_MOVEMENT
        splitPoints.push sp
        prevSplit = sp

    lastSplit = if splitPoints.length > 0 then splitPoints[splitPoints.length - 1] else 0
    remainingMeasures = totalMeasures - lastSplit

    while remainingMeasures > MAX_MEASURES_PER_MOVEMENT
      foundSplit = false
      for sp in allDoubleBarlines
        if sp > lastSplit and sp - lastSplit >= MAX_MEASURES_PER_MOVEMENT
          splitPoints.push sp
          lastSplit = sp
          remainingMeasures = totalMeasures - lastSplit
          foundSplit = true
          break
      break unless foundSplit

    console.log "Double barres trouvées: #{allDoubleBarlines.join(', ')}" if allDoubleBarlines.length > 0

  splitPoints = [...new Set(splitPoints)].sort((a, b) -> a - b)
  console.log "Points de découpage: #{splitPoints.join(', ')}" if splitPoints.length > 0

  # Capture attributes at each split point
  splitAttrs = {}
  for splitIndex in splitPoints
    splitAttrs[splitIndex] = []
    for part in parts
      measures = part.querySelectorAll("measure")
      currentStaves = null
      currentClefs = []
      currentKey = null
      currentTime = null
      currentDivisions = null
      currentTranspose = null
      for m, i in measures when i < splitIndex
        attrs = m.querySelector("attributes")
        if attrs
          staves = attrs.querySelector("staves")
          currentStaves = staves if staves
          clefs = attrs.querySelectorAll("clef")
          currentClefs = Array.from(clefs) if clefs.length > 0
          key = attrs.querySelector("key")
          currentKey = key if key
          time = attrs.querySelector("time")
          currentTime = time if time
          divisions = attrs.querySelector("divisions")
          currentDivisions = divisions if divisions
          transpose = attrs.querySelector("transpose")
          currentTranspose = transpose if transpose
      splitAttrs[splitIndex].push
        staves: currentStaves
        clefs: currentClefs
        key: currentKey
        time: currentTime
        divisions: currentDivisions
        transpose: currentTranspose

  {splitPoints, splitAttrs, totalMeasures, parts: Array.from(parts)}

# Extract a single movement by index (lazy extraction)
# movementIndex: 0-based, where 0 is first movement
extractMovement = (xmlString, splitInfo, movementIndex) ->
  {splitPoints, splitAttrs, totalMeasures} = splitInfo

  # No splits: return whole document
  if splitPoints.length is 0
    return preprocessMusicXML(xmlString) if movementIndex is 0
    return null

  # Calculate start and end measure indices for this movement
  allPoints = [0, ...splitPoints, totalMeasures]
  startMeasure = allPoints[movementIndex]
  endMeasure = allPoints[movementIndex + 1]

  unless startMeasure? and endMeasure?
    return null

  parser = new DOMParser()
  doc = parser.parseFromString xmlString, "application/xml"
  partsPart = doc.querySelectorAll("part")
  serializer = new XMLSerializer()

  for part, pIdx in partsPart
    measures = Array.from part.querySelectorAll("measure")

    # Remove measures after this movement
    for m, i in measures when i >= endMeasure
      m.parentNode.removeChild(m)

    # Remove measures before this movement
    for m, i in measures when i < startMeasure
      m.parentNode.removeChild(m) if m.parentNode

    # Insert attributes at start if not first movement
    if startMeasure > 0 and splitAttrs[startMeasure]?[pIdx]
      attrs = splitAttrs[startMeasure][pIdx]
      remainingMeasures = Array.from part.querySelectorAll("measure")
      if remainingMeasures.length > 0
        firstMeasure = remainingMeasures[0]
        existingAttrs = firstMeasure.querySelector("attributes")

        newAttrsEl = doc.createElement("attributes")
        if attrs.divisions
          newAttrsEl.appendChild attrs.divisions.cloneNode(true)
        if attrs.key
          newAttrsEl.appendChild attrs.key.cloneNode(true)
        if attrs.time
          newAttrsEl.appendChild attrs.time.cloneNode(true)
        if attrs.staves
          newAttrsEl.appendChild attrs.staves.cloneNode(true)
        for clef in attrs.clefs or []
          newAttrsEl.appendChild clef.cloneNode(true)
        if attrs.transpose
          newAttrsEl.appendChild attrs.transpose.cloneNode(true)

        if existingAttrs
          for child in Array.from(newAttrsEl.children)
            # Pour les clefs, vérifier par numéro de portée
            if child.tagName is "clef"
              staffNum = child.getAttribute("number")
              existingClef = existingAttrs.querySelector("clef[number=\"#{staffNum}\"]")
              unless existingClef
                existingAttrs.insertBefore child.cloneNode(true), existingAttrs.firstChild
            else if child.tagName is "staves"
              unless existingAttrs.querySelector("staves")
                existingAttrs.insertBefore child.cloneNode(true), existingAttrs.firstChild
            else
              unless existingAttrs.querySelector(child.tagName)
                existingAttrs.insertBefore child.cloneNode(true), existingAttrs.firstChild
        else if newAttrsEl.children.length > 0
          firstMeasure.insertBefore newAttrsEl, firstMeasure.firstChild

  preprocessMusicXML(serializer.serializeToString(doc))

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

# Load a score using the worker with lazy movement extraction
loadXml = (xml, startPage = 1) ->
  currentXml = xml
  currentPage = 1  # Always start at page 1 for immediate display
  scrollPos = 0
  lastWidth = window.innerWidth
  memoryCache.clear()
  pendingRenders.clear()
  pendingMovementLoads.clear()
  movements = []
  targetPage = if startPage > 1 then startPage else null  # Navigate later if needed
  showLoading()

  # Try to get structure from cache first
  loadStructure = ->
    if currentFileId
      svgStore.getStructure(currentFileId).then (cached) ->
        if cached and cached.splitPoints
          console.log "Structure en cache: #{cached.splitPoints.length} points de découpage"
          # Use cached splitPoints but recalculate splitAttrs for those exact points
          splitInfo = detectSplitPoints xml
          # Restore cached splitPoints
          splitInfo.splitPoints = cached.splitPoints
          splitInfo.totalMeasures = cached.totalMeasures
          # Recalculate splitAttrs for the cached splitPoints
          parts = splitInfo.parts
          splitAttrs = {}
          for splitIndex in cached.splitPoints
            splitAttrs[splitIndex] = []
            for part in parts
              measures = part.querySelectorAll("measure")
              currentStaves = null
              currentClefs = []
              currentKey = null
              currentTime = null
              currentDivisions = null
              currentTranspose = null
              for m, i in measures when i < splitIndex
                attrs = m.querySelector("attributes")
                if attrs
                  staves = attrs.querySelector("staves")
                  currentStaves = staves if staves
                  clefs = attrs.querySelectorAll("clef")
                  currentClefs = Array.from(clefs) if clefs.length > 0
                  key = attrs.querySelector("key")
                  currentKey = key if key
                  time = attrs.querySelector("time")
                  currentTime = time if time
                  divisions = attrs.querySelector("divisions")
                  currentDivisions = divisions if divisions
                  transpose = attrs.querySelector("transpose")
                  currentTranspose = transpose if transpose
              splitAttrs[splitIndex].push
                staves: currentStaves
                clefs: currentClefs
                key: currentKey
                time: currentTime
                divisions: currentDivisions
                transpose: currentTranspose
          splitInfo.splitAttrs = splitAttrs
          return splitInfo
        # Not in cache, detect and store (only splitPoints and totalMeasures)
        splitInfo = detectSplitPoints xml
        svgStore.setStructure(currentFileId, {
          splitPoints: splitInfo.splitPoints
          totalMeasures: splitInfo.totalMeasures
        })
        splitInfo
    else
      Promise.resolve(detectSplitPoints xml)

  loadStructure().then (splitInfo) ->
    currentSplitInfo = splitInfo
    movementCount = currentSplitInfo.splitPoints.length + 1
    console.log "Partition divisée en #{movementCount} mouvement(s)"

    # Initialize movement tracking
    for i in [0...movementCount]
      movements.push {id: i + 1, pageCount: 0, loaded: false}

    # Calculate and store dimensions
    currentPageWidth = Math.round(window.innerWidth * 100 / currentScale)
    currentPageHeight = Math.round(window.innerHeight * 100 / currentScale)
    pageWidth = currentPageWidth
    pageHeight = currentPageHeight

    # Clear previous movements before loading new file
    worker.postMessage { type: "clearMovements" }

    # Extract and load first movement immediately
    firstXml = extractMovement xml, currentSplitInfo, 0
    worker.postMessage
      type: "loadMovement"
      movementId: 1
      xmlString: firstXml
      pageWidth: pageWidth
      pageHeight: pageHeight
      scale: currentScale

    # Subsequent movements will be loaded after first movement is displayed
    # (see movementLoaded handler)

    fileLoaded = true
    hideImport()
    showLibraryBtn()

# Load remaining movements sequentially after first page is displayed
loadRemainingMovements = ->
  return unless currentSplitInfo and movements.length > 1

  # Show loading indicator while loading remaining movements
  showLoadingIndicator()

  # Process movements one by one sequentially
  processNextMovement = (index) ->
    if index >= movements.length
      # All movements loaded, hide indicator
      hideLoadingIndicator()
      return
    return unless currentXml and currentSplitInfo

    movementId = index + 1
    currentPageWidth = Math.round(window.innerWidth * 100 / currentScale)
    currentPageHeight = Math.round(window.innerHeight * 100 / currentScale)
    pageWidth = currentPageWidth
    pageHeight = currentPageHeight

    mvXml = extractMovement currentXml, currentSplitInfo, index
    return processNextMovement(index + 1) unless mvXml

    # Load movement and wait for it to be ready
    loadMovementAndWait(movementId, mvXml, pageWidth, pageHeight).then ->
      # Process first page (cache check, render if needed, store if needed)
      requestPage(movementId, 1).then (svg) ->
        console.log "Mouvement #{movementId} traité"
        # Move to next movement
        processNextMovement(index + 1)

  # Start with movement 2 (index 1)
  processNextMovement(1)

# Load a movement in worker and return Promise that resolves when loaded
loadMovementAndWait = (movementId, xmlString, pageWidth, pageHeight) ->
  new Promise (resolve) ->
    # Store resolver to be called when movementLoaded message arrives
    pendingMovementLoads.set movementId, resolve

    worker.postMessage
      type: "loadMovement"
      movementId: movementId
      xmlString: xmlString
      pageWidth: pageWidth
      pageHeight: pageHeight
      scale: currentScale

# Loading indicator for background movement loading
showLoadingIndicator = ->
  el = $("loading-indicator")
  el?.classList.remove "hidden"

hideLoadingIndicator = ->
  el = $("loading-indicator")
  el?.classList.add "hidden"

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
          when "start" then goToStart()
          when "end" then goToEnd()
          when "prev-mov" then goToPrevMovement()
          when "next-mov" then goToNextMovement()
          when "prev-5" then goBack5()
          when "next-5" then goForward5()

  # Keyboard navigation
  document.addEventListener "keydown", (e) ->
    return unless fileLoaded
    switch e.key
      when "ArrowRight", " "
        e.preventDefault()
        goNext()
      when "ArrowLeft"
        e.preventDefault()
        goPrev()

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
  # Vertical scroll alignment listener
  $("page-current").addEventListener "scroll", applyVerticalAlignment
  # Worker will send "ready" when initialized
  worker.postMessage {type: "init"}
