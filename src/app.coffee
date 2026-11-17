buildDate = window.__musicaBuildDate ? "(non défini)"

# App — logique principale (worker-based with movement support)

console.log "Musica — Liseuse MusicXML"
console.log "Date de build : #{buildDate}"

# PWA Installation Management - CRITICAL: Must be attached immediately!
deferredPrompt = null
installButton = null

# Handle beforeinstallprompt event - MUST be attached before any other code
window.addEventListener 'beforeinstallprompt', (e) ->
  console.log "PWA: Installation prompt available"
  e.preventDefault()
  deferredPrompt = e
  console.log "PWA: Prompt event stored for later use"

# Check if we missed the event (for debugging)
setTimeout ->
  unless deferredPrompt
    console.log "PWA: No prompt event received yet - may need more visits"
  else
    console.log "PWA: Prompt event available for use"
, 1000

# Show install button when PWA installation is possible
showInstallButton = ->
  installSection = $("install-section")
  installButton = $("btn-install")

  if installSection and installButton
    installSection.classList.remove "hidden"
    installButton.addEventListener "click", installPWA
    console.log "PWA: Install button shown"

# Show install button immediately on first visit
showInstallButtonFirst = ->
  installSection = $("install-section")
  installButton = $("btn-install")

  if installSection and installButton
    installSection.classList.remove "hidden"
    installButton.addEventListener "click", installPWA
    console.log "PWA: Install button shown on first visit"

# Install PWA when button is clicked
installPWA = ->
  if deferredPrompt
    # Use the deferred prompt if available
    console.log "PWA: Showing install prompt"

    deferredPrompt.prompt()
      .then (result) ->
        {outcome} = result
        console.log "PWA: Install outcome - #{outcome}"

        if outcome is 'accepted'
          console.log "PWA: User accepted installation"
          showInstallMessage "Installation en cours...", "success"
        else
          console.log "PWA: User dismissed installation"
          showInstallMessage "Installation annulée", "info"

        # Hide install button regardless of outcome
        hideInstallButton()
        deferredPrompt = null

      .catch (error) ->
        console.error "PWA: Install prompt error:", error
        showInstallMessage "Erreur lors de l'installation", "error"
  else
    # No prompt available yet, show detailed instructions
    console.log "PWA: No install prompt available yet"

    # Check browser and provide specific instructions
    userAgent = navigator.userAgent.toLowerCase()

    if userAgent.includes('chrome') and not userAgent.includes('edg')
      # Chrome/Chromium
      showInstallMessage "Chrome: Revenez après quelques visites pour installer", "info"
      console.log "PWA: Chrome detected - prompt needs multiple visits"

    else if userAgent.includes('firefox')
      # Firefox
      showInstallMessage "Firefox: Appuyez sur l'icône d'installation dans la barre d'adresse", "info"
      console.log "PWA: Firefox detected - manual installation required"

    else if userAgent.includes('safari') and not userAgent.includes('chrome')
      # Safari
      showInstallMessage "Safari: Appuyez sur Partager > Ajouter à l'écran d'accueil", "info"
      console.log "PWA: Safari detected - manual installation required"

    else if userAgent.includes('edg')
      # Edge
      showInstallMessage "Edge: Revenez après quelques visites pour installer", "info"
      console.log "PWA: Edge detected - prompt needs multiple visits"

    else
      # Other browsers
      showInstallMessage "Utilisez le menu du navigateur pour installer", "info"
      console.log "PWA: Unknown browser - generic instructions"

# Hide install button
hideInstallButton = ->
  installSection = $("install-section")
  if installSection
    installSection.classList.add "hidden"

# Show install-related messages
showInstallMessage = (message, type = 'info') ->
  messageEl = document.getElementById 'install-message'
  unless messageEl
    messageEl = document.createElement 'div'
    messageEl.id = 'install-message'
    messageEl.style.cssText = '''
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #2196f3;
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      z-index: 10000;
      font-size: 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    '''
    document.body.appendChild messageEl

  # Set colors based on type
  colors =
    success: '#4caf50'
    error: '#f44336'
    info: '#2196f3'
    warning: '#ff9800'

  messageEl.style.background = colors[type] or colors.info
  messageEl.textContent = message
  messageEl.style.display = 'block'

  # Auto-hide after 3 seconds
  setTimeout ->
    messageEl.style.display = 'none'
  , 3000

# Check if app is already installed
checkIfInstalled = ->
  if window.navigator.standalone
    console.log "PWA: App is already installed (iOS)"
    hideInstallButton()
  else if window.matchMedia('(display-mode: standalone)').matches
    console.log "PWA: App is already installed (PWA)"
    hideInstallButton()
  else
    # Not installed, show install button immediately
    showInstallButtonFirst()

# Display build date in bottom-left corner
document.addEventListener "DOMContentLoaded", ->
  # Check if PWA is already installed and show button if not
  checkIfInstalled()

  buildDateEl = document.getElementById("build-date")
  if buildDateEl
    # Format: "2026-03-23T15:25:45.733Z" -> "Version du 23/03/2026 à 17:25"
    buildDateEl.title = buildDate
    try
      date = new Date(buildDate)
      day = date.toLocaleDateString('fr-FR', {day: '2-digit', month: '2-digit', year: 'numeric'})
      time = date.toLocaleTimeString('fr-FR', {hour: '2-digit', minute: '2-digit'})
      buildDateEl.textContent = "Version du #{day} à #{time}"
    catch
      buildDateEl.textContent = buildDate

# Service Worker management - Local First PWA
setupServiceWorker = ->
  if navigator.serviceWorker?
    navigator.serviceWorker.register('./sw.js')
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

        # Vérifier les mises à jour quand l'application redevient visible
        document.addEventListener 'visibilitychange', ->
          registration.update() if document.visibilityState is 'visible'

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
pendingRequests = new Map()  # Pending page requests for deduplication
fileLoaded = false
indicatorTimeout = null
scrollScheduled = false  # Scroll events are handled once per frame
currentFileId = null
lastWidth = window.innerWidth
resizeTimer = null
positionTimer = null
workerReady = false
currentScale = 40
verticalScrollRatio = 0
currentPageWidth = 0
currentPageHeight = 0
hiddenParts = new Set()  # Ids des parties masquées pour le fichier courant
partSizes = {}  # Id de partie -> taille en % (100 = taille normale)
partsChanged = false  # Réglages de voix modifiés, à appliquer à la fermeture

# Pages pre-rendered around the displayed one
PREFETCH_AHEAD = 6
PREFETCH_BEHIND = 1

# Scroll mode: "horizontal" (1 system) or "vertical" (2+ systems)
scrollMode = null
systemHeight = 0  # Height of a single system in vertical mode

# Movement tracking
movements = []  # [{id, pageCount, pushed, loaded}]
pendingRenders = new Map()  # "movementId:page" -> resolve function
pushedPages = {}  # movementId -> last page of the initial push received (in order)
pendingMovementLoads = new Map()  # movementId -> resolve function
pendingMscz = new Map()  # MuseScore conversion id -> {resolve, reject}
msczRequestId = 0
targetPage = null  # Page to navigate to once all movements are loaded
awaitingLoad = false  # A new load is posted: ignore the previous render's replies
currentSplitInfo = null  # Split info of the first source, for the parts panel
currentSources = null  # [{name, data}] : sources de l'entrée courante (XML ou binaire)
sourceCache = new Map()  # index de source -> {xml, splitInfo}
nextSourceToLoad = 0  # prochaine source à convertir
allSourcesLoaded = false  # toutes les sources sont converties et leurs mouvements connus
loadToken = 0  # incrémenté à chaque chargement : arrête les chaînes de conversion en cours
movementLoadTokens = new Map()  # movementId -> loadToken de la demande en cours

# Worker message handler
worker.onmessage = (e) ->
  {type} = e.data
  # Replies still in flight from the previous render would be mapped onto the
  # movements just reset (page counts at 0) and shown in its place: drop them
  # until the new first movement is loaded.
  if awaitingLoad
    return if type is "svg"
    return if type is "movementLoaded" and e.data.movementId isnt 1
  switch type
    when "ready"
      console.log "Worker Verovio prêt"
      workerReady = true
      hideLoading()
      startApp()

    when "movementLoaded"
      # Réponse d'un chargement abandonné (suppression, rechargement) : ignorer
      return if (movementLoadTokens.get e.data.movementId) isnt loadToken
      awaitingLoad = false
      {movementId, pageCount: mvPages, pushed} = e.data
      mv = movements.find (m) -> m.id is movementId
      if mv
        mv.pageCount = mvPages
        mv.loaded = true
        mv.pushed = pushed
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
      # Hide loading overlay and show the first page as soon as it arrives
      if movementId is 1
        hideLoading()
        if mvPages > 0
          # Page 1 is part of the pushed pages: display it on arrival
          requestPage(1, 1).then (svg) ->
            # Detect scroll mode from first page before displaying
            detectScrollMode(svg)
            displayView()
            prefetch()
            # Now load subsequent movements after first page is displayed
            loadRemainingMovements()
      # Navigate to the remembered page as soon as its movement is loaded
      tryNavigateTarget()

    when "svg"
      {movementId, page, svg} = e.data
      # Convert movement-local page to global page number
      globalPage = page
      for m in movements when m.id < movementId
        globalPage += m.pageCount or 0
      memoryCache.set globalPage, svg
      # Pushes arrive in page order: remember how far the worker got
      pushedPages[movementId] = page if page > (pushedPages[movementId] or 0)
      # Store in persistent cache (async, non-blocking)
      if currentFileId and currentPageWidth and currentPageHeight
        svgStore.set(currentFileId, globalPage, svg, currentPageWidth, currentPageHeight, partsVariant()).catch (err) ->
          console.error "Erreur stockage SVG:", err
      # Resolve pending render if any
      key = "#{movementId}:#{page}"
      if pendingRenders.has(key)
        pendingRenders.get(key)(svg)
        pendingRenders.delete(key)
      # Note: displayView() is now async, so we don't call it here
      # The async displayView will update when pages are loaded

      # Hide loading indicator once the whole score is loaded and cached
      if allSourcesLoaded and memoryCache.size >= pageCount and pageCount > 0
        hideLoadingIndicator()

    when "error"
      {message, movementId} = e.data
      console.error "Worker error:", message
      if movementId
        showError "Erreur mouvement #{movementId}: #{message}"
      else
        showError message

    when "msczConverted", "msczError"
      {id, xml, message} = e.data
      pending = pendingMscz.get id
      return unless pending
      pendingMscz.delete id
      if type is "msczConverted"
        pending.resolve xml
      else
        pending.reject new Error message

# Calculate global page from movementId and localPage
getGlobalPage = (movementId, localPage) ->
  offset = 0
  for m in movements when m.id < movementId
    offset += m.pageCount or 0
  offset + localPage

# Request SVG from worker, returns Promise
# Checks caches first
requestPage = (movementId, localPage) ->
  globalPage = getGlobalPage(movementId, localPage)

  # Check memory cache first
  if memoryCache.has(globalPage)
    return Promise.resolve(memoryCache.get(globalPage))

  # Reuse the pending promise to avoid duplicate work
  pendingKey = "page:#{globalPage}"
  return pendingRequests.get(pendingKey) if pendingRequests.has(pendingKey)

  promise = svgStore.get(currentFileId, globalPage, currentPageWidth, currentPageHeight, partsVariant()).then (svg) ->
    if svg
      memoryCache.set(globalPage, svg)
      return svg
    # The worker may have pushed this page while the lookup was in flight
    return memoryCache.get(globalPage) if memoryCache.has(globalPage)
    requestFromWorker(movementId, localPage)
  pendingRequests.set pendingKey, promise
  promise.then -> pendingRequests.delete pendingKey
  promise

# Actually request from worker
requestFromWorker = (movementId, localPage) ->
  new Promise (resolve) ->
    key = "#{movementId}:#{localPage}"
    pendingRenders.set key, resolve
    # The pages pushed at load arrive in order: wait for the one we are missing
    # instead of asking for a second render. Any other page is rendered here.
    mv = movements.find (m) -> m.id is movementId
    if localPage <= (mv?.pushed or 0) and localPage > (pushedPages[movementId] or 0)
      return
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
defaultSettings = { zoom: 40, theme: "white", tapSize: 30, scrollUnit: "page", overlap: 0 }

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

applyScrollSettings = (unit, overlap) ->
  for btn in document.querySelectorAll ".scroll-unit-btn"
    btn.classList.toggle "active", btn.dataset.unit is unit
  $("overlap-select").value = String overlap
  $("overlap-row").classList.toggle "hidden", unit isnt "page"

applyAllSettings = ->
  settings = loadSettings()
  applyTheme settings.theme
  applyTapSize settings.tapSize
  applyZoom settings.zoom
  applyScrollSettings settings.scrollUnit or "page", settings.overlap or 0

# Parties masquées et leurs tailles, propres à chaque fichier
loadHiddenParts = ->
  hiddenParts = new Set()
  partSizes = {}
  return unless currentFileId
  try
    saved = localStorage.getItem "musica-hidden-parts-#{currentFileId}"
    return unless saved
    data = JSON.parse saved
    if Array.isArray data
      hiddenParts = new Set data  # ancien format : tableau des ids masqués
    else
      hiddenParts = new Set data.hidden or []
      partSizes = data.sizes or {}
  catch
    # localStorage unavailable (file:// on some browsers)

saveHiddenParts = ->
  return unless currentFileId
  try
    data = {hidden: Array.from(hiddenParts), sizes: partSizes}
    localStorage.setItem "musica-hidden-parts-#{currentFileId}", JSON.stringify(data)
  catch
    # localStorage unavailable (file:// on some browsers)

# Suffixe de clé du cache SVG : une page rendue avec une autre sélection diffère
partsVariant = ->
  hidden = Array.from(hiddenParts).sort().join ","
  sizes = (for id in Object.keys(partSizes).sort() when partSizes[id] isnt 100
    "#{id}=#{partSizes[id]}")
  return hidden if sizes.length is 0  # clé inchangée quand toutes les voix sont à 100 %
  "#{hidden}|#{sizes.join ','}"

# DOM refs
$ = (id) -> document.getElementById id

showLoading = ->
  $("overlay-loading").classList.remove "hidden"

hideLoading = ->
  $("overlay-loading").classList.add "hidden"

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

# Page shown in the indicator: in vertical mode, the page crossing the bottom
# half of the viewport (the first page rendered at the top of the scroll)
displayedPage = ->
  return Math.floor(scrollPos / 2) + 1 unless scrollMode is "vertical"
  slot = $("page-current")
  pages = slot.querySelectorAll(".scroll-page")
  # After a jump, the rendered pages do not start at page 1
  firstPage = if pages.length > 0 then parseInt(pages[0].dataset.page) else 1
  return firstPage if slot.scrollTop <= 0
  clientHeight = slot.clientHeight
  page = firstPage
  for div, i in pages
    rect = div.getBoundingClientRect()
    # The following pages are lower: no need to measure them
    break if rect.top >= clientHeight
    page = firstPage + i if rect.bottom > clientHeight * 0.5
  page

showIndicator = ->
  el = $("page-indicator")
  page = displayedPage()
  el.textContent = "#{page} / #{pageCount}"
  pageNumberEl = $("page-number")
  if pageNumberEl
    pageNumberEl.textContent = "#{page}/#{pageCount}"
  el.classList.add "visible"
  clearTimeout indicatorTimeout if indicatorTimeout
  indicatorTimeout = setTimeout ->
    el.classList.remove "visible"
  , 1500

renderPageAsync = (globalPage) ->
  return Promise.resolve(memoryCache.get(globalPage)) if memoryCache.has(globalPage)
  result = getMovementForPage(globalPage)
  return Promise.resolve("") unless result
  {movement, localPage} = result
  requestPage(movement.id, localPage)

# Detect scroll mode from SVG content
# Count <g class="system"> elements to determine horizontal vs vertical scrolling
detectScrollMode = (svgString) ->
  return if scrollMode?  # Already detected
  return unless svgString
  # Verovio writes systems as <g id="…" class="system">: no need to parse the
  # whole SVG to count them
  systemCount = (svgString.match(/<g\b[^>]*class="system"/g) or []).length
  if systemCount <= 1
    scrollMode = "horizontal"
  else
    scrollMode = "vertical"
    # Calculate average system height from the SVG
    svgTag = svgString.match(/<svg\b[^>]*>/)?[0] or ""
    svgHeight = 0
    # Try viewBox first
    viewBoxStr = svgTag.match(/viewBox="([^"]*)"/)?[1]
    if viewBoxStr
      viewBox = viewBoxStr.split(/\s+/).map(Number)
      if viewBox.length >= 4 and viewBox[3] > 0
        svgHeight = viewBox[3]
    # Fallback: use height attribute (may include "px")
    if svgHeight <= 0
      heightAttr = svgTag.match(/height="([^"]*)"/)?[1]
      if heightAttr
        svgHeight = parseFloat(heightAttr)
    # Calculate system height
    if svgHeight > 0
      systemHeight = svgHeight / systemCount
    else
      systemHeight = 1000  # Default fallback
  scrollMode

displayView = ->
  slot = $("page-current")
  topPage = Math.floor(scrollPos / 2) + 1
  bottomPage = topPage + 1
  offset = (scrollPos % 2) * 50
  vertical = scrollMode is "vertical"

  # Pages to show: the current system (and the next one if any) horizontally,
  # up to 10 pages of systems vertically
  wanted = if vertical
    pagesToLoad = Math.min(pageCount - topPage + 1, 10)
    [topPage .. Math.min(topPage + pagesToLoad - 1, pageCount)]
  else
    if bottomPage <= pageCount then [topPage, bottomPage] else [topPage]

  # Reuse the existing wrapper so its pages keep their parsed SVG
  wrapper = slot.querySelector ".scroll-wrapper"
  unless wrapper
    slot.innerHTML = ""
    wrapper = document.createElement "div"
    wrapper.className = "scroll-wrapper"
    slot.appendChild wrapper

  # Restore the vertical scroll position and alignment once pages are in place
  refreshVerticalLayout = ->
    requestAnimationFrame ->
      if not vertical and slot.scrollHeight > slot.clientHeight and verticalScrollRatio > 0
        slot.scrollTop = verticalScrollRatio * (slot.scrollHeight - slot.clientHeight)
      applyVerticalAlignment()

  # Create a page container, filled asynchronously
  newPage = (page) ->
    div = document.createElement "div"
    div.className = "scroll-page"
    div.dataset.page = page  # Identify page by number
    div.innerHTML = '<div class="loading-placeholder">Chargement...</div>'
    renderPageAsync(page).then (svg) ->
      return unless svg and div.isConnected  # Page was removed meanwhile
      div.innerHTML = svg
      refreshVerticalLayout()
    div

  # Index the pages already displayed, drop those no longer wanted
  existing = {}
  for div in Array.from(wrapper.querySelectorAll ".scroll-page")
    page = parseInt div.dataset.page
    if page in wanted and not existing[page]
      existing[page] = div
    else
      wrapper.removeChild div

  # Create missing pages and put them all in order: appendChild moves an
  # existing node without re-parsing its SVG
  for page in wanted
    div = existing[page] or newPage(page)
    wrapper.appendChild div

  if vertical
    wrapper.classList.add "vertical"
    wrapper.style.transform = ""
  else
    wrapper.classList.remove "vertical"
    wrapper.style.transform = "translateX(-#{offset}vw)"

  refreshVerticalLayout()

prefetch = ->
  page = displayedPage()
  # Reading order: the next pages, nearest first, then the one before
  pages = [page + 1 .. page + PREFETCH_AHEAD]
  pages.push page - PREFETCH_BEHIND if PREFETCH_BEHIND > 0
  for p in pages
    continue unless p >= 1 and p <= pageCount
    continue if memoryCache.has(p)
    result = getMovementForPage(p)
    # Skip pages of a movement that is not loaded yet
    continue unless result and getGlobalPage(result.movement.id, result.localPage) is p
    {movement, localPage} = result
    requestPage(movement.id, localPage)
  purgeCacheFarPages(page)

purgeCacheFarPages = (page) ->
  first = page - PREFETCH_BEHIND
  last = page + PREFETCH_AHEAD
  # Never drop a page of the prefetch window: it would be requested again
  for key from memoryCache.keys()
    memoryCache.delete key if key < first or key > last

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
# Only used in horizontal mode - in vertical mode, native scroll works
applyVerticalAlignment = ->
  return if scrollMode is "vertical"  # Native scroll handles alignment
  slot = $("page-current")
  scrollTop = slot.scrollTop
  maxScroll = slot.scrollHeight - slot.clientHeight
  return unless maxScroll > 0
  ratio = scrollTop / maxScroll
  viewH = slot.clientHeight
  # Read every height first, then write every transform: interleaving the two
  # would force a layout at each iteration
  svgs = []
  heights = []
  for page in slot.querySelectorAll(".scroll-page")
    svg = page.querySelector("svg")
    continue unless svg
    svgs.push svg
    heights.push svg.getBoundingClientRect().height
  for svg, i in svgs
    idealY = ratio * Math.max(0, heights[i] - viewH)
    svg.style.transform = "translateY(#{scrollTop - idealY}px)"

captureVerticalScroll = ->
  slot = $("page-current")
  maxScroll = slot.scrollHeight - slot.clientHeight
  if maxScroll > 0
    verticalScrollRatio = slot.scrollTop / maxScroll

# Vertical scroll position (in system height units)
verticalPos = 0  # Current position in vertical mode

# Check if we need to load more pages in vertical mode
checkAndLoadMorePages = ->
  return unless scrollMode is "vertical"
  slot = $("page-current")
  wrapper = slot.querySelector(".scroll-wrapper")
  return unless wrapper
  loadedPages = wrapper.querySelectorAll(".scroll-page").length
  # If scrolled past 70% of loaded content, add more pages
  scrollProgress = slot.scrollTop / (slot.scrollHeight - slot.clientHeight)
  if scrollProgress > 0.7 and loadedPages < pageCount
    # Add one more page
    nextPage = loadedPages + 1
    if nextPage <= pageCount
      div = document.createElement "div"
      div.className = "scroll-page"
      div.dataset.page = nextPage  # Identify page by number
      div.innerHTML = '<div class="loading-placeholder">Chargement...</div>'
      wrapper.appendChild div
      renderPageAsync(nextPage).then (svg) ->
        if svg and div.isConnected
          div.innerHTML = svg
          requestAnimationFrame -> applyVerticalAlignment()
  prefetch()

# Find the last completely visible SVG in vertical mode
findLastCompleteSvg = ->
  return null unless scrollMode is "vertical"

  slot = $("page-current")
  wrapper = slot.querySelector(".scroll-wrapper")
  return null unless wrapper

  svgs = wrapper.querySelectorAll("svg")
  return null if svgs.length is 0

  slotRect = slot.getBoundingClientRect()
  viewBottom = slotRect.bottom

  lastCompleteSvg = null
  for svg in svgs
    svgRect = svg.getBoundingClientRect()
    svgBottom = svgRect.bottom

    # Check if SVG is completely visible
    if svgBottom <= viewBottom
      lastCompleteSvg = svg
    else
      break  # Stop as soon as we find a partially visible SVG

  return lastCompleteSvg

# Set horizontal position and refresh the view
setScrollPos = (pos) ->
  scrollPos = pos
  currentPage = Math.floor(scrollPos / 2) + 1
  displayView()
  showIndicator()
  prefetch()
  savePositionDebounced()

# Tolérance (px) : un système plus proche que ça du haut de l'écran y est
# considéré comme déjà amené
SYSTEM_TOLERANCE = 10

# Hauts des systèmes affichés, en coordonnées de défilement du slot. Toutes
# les positions sont lues d'un coup, avant le scrollTo de l'appelant.
systemTops = ->
  slot = $("page-current")
  base = slot.getBoundingClientRect().top - slot.scrollTop
  for system in slot.querySelectorAll ".scroll-page svg g.system"
    system.getBoundingClientRect().top - base

# Haut du système qui croise le haut de l'écran une fois défilé à pos
systemTopBefore = (tops, pos) ->
  found = null
  for top in tops when top <= pos
    found = top
  found

# Cible du défilement vertical selon le réglage « Défilement »
# dir vaut 1 vers l'avant, -1 vers l'arrière
verticalTarget = (dir) ->
  slot = $("page-current")
  current = slot.scrollTop
  {scrollUnit, overlap} = loadSettings()
  tops = systemTops()
  target = null

  if scrollUnit is "system"
    # Premier système sous le haut de l'écran (ou dernier au-dessus)
    for top in tops
      if dir > 0
        if top > current + SYSTEM_TOLERANCE
          target = top
          break
      else if top < current - SYSTEM_TOLERANCE
        target = top
  else if overlap > 0
    # Par page avec recouvrement : (1 - r) écran, puis retour au haut du
    # système qui croise le haut de l'écran, à condition que cela avance
    raw = current + dir * slot.clientHeight * (1 - overlap / 100)
    target = systemTopBefore tops, raw
    target = raw unless target? and (target - current) * dir > 0
  else
    # Par page sans recouvrement : page SVG suivante après la dernière
    # entièrement visible, ou page précédente (comportement historique)
    svgs = slot.querySelectorAll ".scroll-page svg"
    base = slot.getBoundingClientRect().top - slot.scrollTop
    svgTop = (svg) -> svg.getBoundingClientRect().top - base
    if dir > 0
      lastComplete = findLastCompleteSvg()
      if lastComplete
        index = Array.prototype.indexOf.call svgs, lastComplete
        target = svgTop svgs[index + 1] if index + 1 < svgs.length
      target = null unless target? and target > current + SYSTEM_TOLERANCE
    else
      for svg in svgs when svgTop(svg) < current - SYSTEM_TOLERANCE
        target = svgTop svg

  # Repli quand aucun système/page ne donne de cible : une demi-page
  target ?= current + dir * window.innerHeight * 0.5
  Math.max 0, Math.min slot.scrollHeight - slot.clientHeight, target

goNext = ->
  return unless fileLoaded
  if scrollMode is "vertical"
    slot = $("page-current")
    return if slot.scrollTop >= slot.scrollHeight - slot.clientHeight
    slot.scrollTo top: verticalTarget(1), behavior: "instant"
    verticalPos++
    checkAndLoadMorePages()
    showIndicator()
    savePositionDebounced()
  else
    return if scrollPos >= maxScrollPos()
    captureVerticalScroll()
    setScrollPos(scrollPos + 1)

goPrev = ->
  return unless fileLoaded
  if scrollMode is "vertical"
    slot = $("page-current")
    return if slot.scrollTop <= 0
    slot.scrollTo top: verticalTarget(-1), behavior: "instant"
    verticalPos = Math.max(0, verticalPos - 1)
    showIndicator()
    savePositionDebounced()
  else
    return if scrollPos <= 0
    captureVerticalScroll()
    setScrollPos(scrollPos - 1)

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
  setScrollPos (page - 1) * 2

goToStart = ->
  return unless fileLoaded
  setScrollPos 0

goToEnd = ->
  return unless fileLoaded
  setScrollPos maxScrollPos()

goToPrevMovement = ->
  return unless fileLoaded
  currentIdx = getCurrentMovementIndex()
  return if currentIdx <= 0
  startPage = getMovementStartPage(currentIdx - 1)
  setScrollPos (startPage - 1) * 2

goToNextMovement = ->
  return unless fileLoaded
  currentIdx = getCurrentMovementIndex()
  return if currentIdx >= movements.length - 1
  startPage = getMovementStartPage(currentIdx + 1)
  setScrollPos (startPage - 1) * 2

jumpVertical = (direction) ->
  slot = $("page-current")
  maxScroll = slot.scrollHeight - slot.clientHeight
  return if direction < 0 and slot.scrollTop <= 0
  return if direction > 0 and slot.scrollTop >= maxScroll

  # Target ~5 half view heights away, then snap to the closest SVG
  targetScroll = slot.scrollTop + direction * window.innerHeight * 2.5
  targetScroll = Math.max(0, Math.min(maxScroll, targetScroll))

  slotRect = slot.getBoundingClientRect()
  wrapper = slot.querySelector(".scroll-wrapper")
  if wrapper
    svgs = wrapper.querySelectorAll("svg")
    closestSvg = null
    closestDistance = Infinity

    for svg in svgs
      svgRect = svg.getBoundingClientRect()
      svgScrollPos = slot.scrollTop + (svgRect.top - slotRect.top)
      distance = Math.abs(svgScrollPos - targetScroll)

      if distance < closestDistance
        closestDistance = distance
        closestSvg = svg

    if closestSvg
      svgRect = closestSvg.getBoundingClientRect()
      targetScroll = slot.scrollTop + (svgRect.top - slotRect.top)

  slot.scrollTo top: targetScroll, behavior: "instant"

  checkAndLoadMorePages() if direction > 0
  showIndicator()
  prefetch()
  savePositionDebounced()

goBack5 = ->
  return unless fileLoaded
  if scrollMode is "vertical"
    jumpVertical -1
  else
    setScrollPos Math.max(0, scrollPos - 10)

goForward5 = ->
  return unless fileLoaded
  if scrollMode is "vertical"
    jumpVertical 1
  else
    setScrollPos Math.min(maxScrollPos(), scrollPos + 10)

# Capture the attributes in effect at each split point, in one pass per part
# Returns {splitIndex: [attributes per part]}
captureSplitAttrs = (parts, splitPoints) ->
  splitAttrs = {}
  for splitIndex in splitPoints
    splitAttrs[splitIndex] = []
  for part in parts
    state =
      staves: null
      clefs: []
      key: null
      time: null
      divisions: null
      transpose: null
    for measure, i in part.querySelectorAll("measure")
      # Snapshot the state before this measure, i.e. as it starts
      splitAttrs[i].push Object.assign({}, state) if splitAttrs[i]?
      attrs = measure.querySelector("attributes")
      if attrs
        staves = attrs.querySelector("staves")
        state.staves = staves if staves
        clefs = attrs.querySelectorAll("clef")
        state.clefs = Array.from(clefs) if clefs.length > 0
        key = attrs.querySelector("key")
        state.key = key if key
        time = attrs.querySelector("time")
        state.time = time if time
        divisions = attrs.querySelector("divisions")
        state.divisions = divisions if divisions
        transpose = attrs.querySelector("transpose")
        state.transpose = transpose if transpose
  splitAttrs

# Detect split points and capture attributes at each point (lazy approach)
# Returns {doc, splitPoints, splitAttrs, totalMeasures}
detectSplitPoints = (xmlString) ->
  doc = new DOMParser().parseFromString xmlString, "application/xml"

  # Insert system breaks once, in place: preprocessMusicXML only adds <print>
  # elements, which neither detection below nor the measure list observe.
  preprocessMusicXML doc

  parts = doc.querySelectorAll("part")
  unless parts.length > 0
    return {doc, splitPoints: [], splitAttrs: {}, totalMeasures: 0}

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
  splitAttrs = captureSplitAttrs parts, splitPoints

  {doc, splitPoints, splitAttrs, totalMeasures}

# Retire d'un document les parties masquées et leur entrée de <part-list>
removeHiddenParts = (doc, hidden) ->
  return doc unless hidden.size > 0
  for el in Array.from doc.querySelectorAll("part, score-part")
    el.parentNode.removeChild el if hidden.has el.getAttribute("id")
  doc

# Taille des voix : <staff-details><staff-size>N</staff-size></staff-details>
# Réutilise (et met à l'échelle) les staff-details existants de la partie :
# Verovio ignore un second staff-details. La taille choisie est relative à
# leur staff-size d'origine (100 s'il est absent).
applyPartSizes = (doc) ->
  return doc if Object.keys(partSizes).length is 0
  for part in Array.from doc.querySelectorAll "part"
    size = partSizes[part.getAttribute "id"]
    continue unless size? and size isnt 100
    measure = part.querySelector "measure"
    continue unless measure
    attrs = measure.querySelector "attributes"
    unless attrs
      attrs = doc.createElement "attributes"
      measure.insertBefore attrs, measure.firstChild
    staves = parseInt attrs.querySelector("staves")?.textContent ? "1"
    staves = 1 unless staves > 1
    # staff-details sans number : toutes les portées ; avec number : une portée
    existing = Array.from part.querySelectorAll "staff-details"
    covers = (details, n) ->
      num = details.getAttribute "number"
      not num? or parseInt(num) is n
    # staff-details se place après les clefs, avant transpose et suivants
    anchor = null
    for child in attrs.children
      if child.tagName in ["transpose", "for-part", "directive", "measure-style"]
        anchor = child
        break
    # Taille relative à la valeur d'origine de chaque staff-details
    setSize = (details) ->
      sizeEl = details.querySelector "staff-size"
      origin = if sizeEl then parseFloat(sizeEl.textContent) else 100
      unless sizeEl
        sizeEl = doc.createElement "staff-size"
      # staff-size est le dernier enfant prévu par le schéma
      details.appendChild sizeEl
      sizeEl.textContent = String Math.round(origin * size) / 100
    # Tous les staff-details de la partie, quelle que soit la mesure
    setSize details for details in existing
    # Portée sans staff-details : en créer un dans la première mesure
    for n in [1..staves]
      continue if existing.some (el) -> covers el, n
      details = doc.createElement "staff-details"
      details.setAttribute "number", String(n) if staves > 1
      attrs.insertBefore details, anchor
      setSize details
  doc

# Extract a single movement by index (lazy extraction)
# movementIndex: 0-based, where 0 is first movement
extractMovement = (splitInfo, movementIndex) ->
  {doc, splitPoints, splitAttrs, totalMeasures} = splitInfo
  serializer = new XMLSerializer()

  # No splits: the whole document is movement 0
  if splitPoints.length is 0
    return null unless movementIndex is 0
    clone = doc.cloneNode true
    removeHiddenParts clone, hiddenParts
    applyPartSizes clone
    return serializer.serializeToString clone

  # Calculate start and end measure indices for this movement
  allPoints = [0, ...splitPoints, totalMeasures]
  startMeasure = allPoints[movementIndex]
  endMeasure = allPoints[movementIndex + 1]

  unless startMeasure? and endMeasure?
    return null

  # Work on a copy: the split document stays intact for the other movements
  clone = doc.cloneNode true

  for part, pIdx in clone.querySelectorAll("part")
    # Remove measures outside this movement
    for measure, i in Array.from(part.querySelectorAll("measure")) when i < startMeasure or i >= endMeasure
      measure.parentNode.removeChild measure

    # Insert attributes at start if not first movement
    if startMeasure > 0 and splitAttrs[startMeasure]?[pIdx]
      attrs = splitAttrs[startMeasure][pIdx]
      firstMeasure = part.querySelector("measure")
      if firstMeasure
        existingAttrs = firstMeasure.querySelector("attributes")

        newAttrsEl = clone.createElement("attributes")
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

  removeHiddenParts clone, hiddenParts
  applyPartSizes clone
  serializer.serializeToString clone

# Preprocess MusicXML: insert system breaks after double barlines (in place)
preprocessMusicXML = (doc) ->
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
  doc

# Convertit une source en MusicXML. Aucune conversion n'a lieu à l'import :
# le contenu brut est converti à la demande.
convertSource = (source) ->
  name = source.name or ""
  data = source.data
  if typeof data is "string"
    # ancienne entrée {xml}, ou texte déjà décodé
    Promise.resolve data
  else if /\.mxl$/i.test name
    Promise.resolve().then -> window.__musicaMxl.extractMxl data
  else if /\.msc[zx]$/i.test name
    unless window.__musicaMsczAvailable
      Promise.reject new Error "import MuseScore non disponible dans cette version"
    else
      # le worker détache le tampon qu'il reçoit : lui donner une copie
      convertMsczToXml data.slice 0
  else
    Promise.resolve new TextDecoder().decode new Uint8Array(data)

# XML converti et découpage en mouvements d'une source, gardés pour la
# partition courante (le zoom, le redimensionnement et les voix rechargent
# sans reconvertir)
ensureSource = (index) ->
  cached = sourceCache.get index
  return Promise.resolve cached if cached
  source = currentSources?[index]
  return Promise.reject new Error "source inconnue" unless source
  convertSource(source).then (xml) ->
    info = {xml, splitInfo: detectSplitPoints xml}
    sourceCache.set index, info
    info

# Ajoute les mouvements d'une source à la fin de la liste globale
appendSourceMovements = (index, info) ->
  count = info.splitInfo.splitPoints.length + 1
  for localIndex in [0...count]
    movements.push
      id: movements.length + 1
      pageCount: 0
      pushed: 0
      loaded: false
      sourceIndex: index
      localIndex: localIndex
  console.log "Source #{index + 1}/#{currentSources.length} : #{count} mouvement(s), #{movements.length} au total"

# Charge une entrée : un fichier seul est une source, un dossier en a plusieurs.
# La première source est convertie et affichée tout de suite, les suivantes
# sont ajoutées en tâche de fond.
loadSources = (sources, startPage = 1) ->
  currentSources = sources
  sourceCache.clear()
  startLoad startPage

# Recharge la partition courante (redimensionnement, zoom, voix) : les XML
# convertis et les découpages restent en cache
reloadScore = (startPage) ->
  return unless currentSources?.length
  startLoad startPage

# Reset the render state and start converting the first source
startLoad = (startPage = 1) ->
  token = ++loadToken
  partsChanged = false
  loadHiddenParts()
  currentPage = 1  # Always start at page 1 for immediate display
  scrollPos = 0
  lastWidth = window.innerWidth
  # Drop the displayed pages: they belong to the previous render
  $("page-current").innerHTML = ""
  memoryCache.clear()
  pendingRequests.clear()
  pendingRenders.clear()
  pendingMovementLoads.clear()
  pushedPages = {}
  movements = []
  awaitingLoad = true
  currentSplitInfo = null
  nextSourceToLoad = 0
  allSourcesLoaded = false
  fileLoaded = false
  targetPage = if startPage > 1 then startPage else null  # Navigate later if needed
  showLoading()
  hideLoadingIndicator()

  # Reset scroll mode for new file
  scrollMode = null
  systemHeight = 0
  verticalPos = 0

  currentPageWidth = Math.round(window.innerWidth * 100 / currentScale)
  currentPageHeight = Math.round(window.innerHeight * 100 / currentScale)

  # Clear previous movements before loading new file
  worker.postMessage { type: "clearMovements" }

  loadFirstSource token

# Convertit les sources dans l'ordre jusqu'à la première qui donne un
# mouvement, et charge son premier mouvement
loadFirstSource = (token) ->
  return unless token is loadToken
  return finishLoad(token) if nextSourceToLoad >= currentSources.length

  index = nextSourceToLoad++
  ensureSource(index)
    .then (info) ->
      return unless token is loadToken
      appendSourceMovements index, info
      currentSplitInfo = info.splitInfo unless currentSplitInfo
      mvXml = extractMovement info.splitInfo, 0
      unless mvXml
        return loadFirstSource token
      loadMovementAndWait(1, mvXml, currentPageWidth, currentPageHeight)
      # Subsequent movements and sources are loaded once this one is displayed
      # (see movementLoaded handler)
      fileLoaded = true
      hideImport()
      showLibraryBtn()
    .catch (err) ->
      return unless token is loadToken
      reportSourceError index, err
      loadFirstSource token

# Report a source that could not be converted, without stopping the others
reportSourceError = (index, err) ->
  console.log "Conversion impossible pour la source #{index + 1}:", err
  name = currentSources?[index]?.name or "source #{index + 1}"
  showError "Fichier ignoré (#{name}) : #{err?.message or err}"

# Load remaining movements (and sources) sequentially after the first page is
# displayed. A source is converted only when the previous one is fully loaded.
loadRemainingMovements = ->
  return unless currentSources?.length
  token = loadToken
  # Show loading indicator while loading remaining movements
  showLoadingIndicator()
  stepLoad token

stepLoad = (token) ->
  return unless token is loadToken and currentSources?.length

  # 1. A movement is known but not rendered yet
  pending = movements.find (m) -> not m.loaded
  if pending
    info = sourceCache.get pending.sourceIndex
    return finishLoad token unless info
    mvXml = extractMovement info.splitInfo, pending.localIndex
    unless mvXml
      pending.loaded = true
      return stepLoad token
    pageWidth = Math.round(window.innerWidth * 100 / currentScale)
    pageHeight = Math.round(window.innerHeight * 100 / currentScale)
    loadMovementAndWait(pending.id, mvXml, pageWidth, pageHeight).then ->
      stepLoad token
    return

  # 2. Convert the next source, then append its movements
  if nextSourceToLoad < currentSources.length
    index = nextSourceToLoad++
    ensureSource(index)
      .then (info) ->
        return unless token is loadToken
        appendSourceMovements index, info
        stepLoad token
      .catch (err) ->
        return unless token is loadToken
        reportSourceError index, err
        stepLoad token
    return

  finishLoad token

finishLoad = (token) ->
  return unless token is loadToken
  allSourcesLoaded = true
  hideLoading()
  hideLoadingIndicator()
  unless fileLoaded
    # Nothing could be displayed: back to the import screen, with access to the
    # library (the entry is saved even if its files cannot be read)
    showImport()
    showLibraryBtn()
  tryNavigateTarget()

# Go to the remembered page as soon as its movement is loaded, without waiting
# for the remaining sources
tryNavigateTarget = ->
  return unless targetPage
  offset = 0
  for m in movements
    count = m.pageCount or 0
    if offset + count >= targetPage
      break unless m.loaded
      page = targetPage
      targetPage = null
      goToPage page
      return
    break unless m.loaded
    offset += count
  return unless allSourcesLoaded
  # The page no longer exists (fewer pages than when it was saved)
  page = Math.min targetPage, pageCount
  targetPage = null
  goToPage page

# Load a movement in worker and return Promise that resolves when loaded
loadMovementAndWait = (movementId, xmlString, pageWidth, pageHeight) ->
  new Promise (resolve) ->
    # Store resolver to be called when movementLoaded message arrives
    pendingMovementLoads.set movementId, resolve
    # Retain the load this reply belongs to, so a superseded one is ignored
    movementLoadTokens.set movementId, loadToken

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
        count = file.files?.length or 0
        meta = formatDate file.addedAt
        meta += " · #{count} fichiers" if count > 1
        item.innerHTML = """
          <div class="library-item-info">
            <div class="library-item-name">#{file.name}</div>
            <div class="library-item-date">#{meta}</div>
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

# Ask the worker to convert a MuseScore file (.mscz/.mscx) to MusicXML
convertMsczToXml = (buffer) ->
  new Promise (resolve, reject) ->
    id = ++msczRequestId
    pendingMscz.set id, {resolve, reject}
    worker.postMessage { type: "convertMscz", id, bytes: buffer }, [buffer]

# Extensions gardées dans un dossier (les autres, p. ex. .pdf, sont ignorées)
isCompatibleFile = (name) -> /\.(xml|musicxml|mxl|mscz|mscx)$/i.test name

baseName = (name) -> name.replace /\.(xml|musicxml|mxl|mscz|mscx)$/i, ""

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
    return showError "Aucun fichier compatible (.xml, .musicxml, .mxl, .mscz, .mscx)"
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
      showError "Impossible de lire le dossier : #{err.message or err}"
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
      showError "Impossible de lire le fichier : #{err.message or err}"
      showImport()
      showLibraryBtn()

# Un fichier sélectionné : import simple ; plusieurs : un dossier
handleImportFiles = (fileList) ->
  files = Array.from fileList or []
  return unless files.length > 0
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
      reloadScore currentPage
    , 300

# Remplit la liste des voix depuis le document déjà analysé (pas de re-parse)
renderPartsList = ->
  group = $("parts-group")
  list = $("parts-list")
  return unless group and list
  doc = currentSplitInfo?.doc if fileLoaded
  parts = if doc then Array.from(doc.querySelectorAll "score-part") else []
  group.classList.toggle "hidden", parts.length < 2
  list.innerHTML = ""
  for part in parts
    do (part) ->
      id = part.getAttribute "id"
      name = part.querySelector("part-name")?.textContent.trim()
      name = part.querySelector("part-abbreviation")?.textContent.trim() if not name
      label = document.createElement "label"
      box = document.createElement "input"
      box.type = "checkbox"
      box.checked = not hiddenParts.has id
      nameEl = document.createElement "span"
      nameEl.textContent = name or id
      sizeSel = document.createElement "select"
      sizeSel.className = "part-size"
      for pct in [50..150] by 10
        opt = document.createElement "option"
        opt.value = pct
        opt.textContent = "#{pct} %"
        sizeSel.appendChild opt
      sizeSel.value = partSizes[id] or 100
      sizeSel.disabled = hiddenParts.has id
      label.appendChild box
      label.appendChild nameEl
      label.appendChild sizeSel
      box.addEventListener "change", ->
        if box.checked then hiddenParts.delete id else hiddenParts.add id
        sizeSel.disabled = not box.checked
        saveHiddenParts()
        updatePartsDisabled()
        # Recalcul différé à la fermeture des réglages
        partsChanged = true
      sizeSel.addEventListener "change", ->
        pct = parseInt sizeSel.value
        if pct is 100 then delete partSizes[id] else partSizes[id] = pct
        saveHiddenParts()
        updatePartsSizesReset()
        partsChanged = true
      list.appendChild label
  updatePartsDisabled()
  updatePartsSizesReset()

# Au moins une partie reste affichée : on désactive la dernière cochée
updatePartsDisabled = ->
  list = $("parts-list")
  return unless list
  boxes = Array.from list.querySelectorAll "input"
  checked = boxes.filter (box) -> box.checked
  for box in boxes
    box.disabled = checked.length is 1 and box.checked

# Bouton « Toutes les voix à 100 % » : actif dès qu'une taille diffère de 100
updatePartsSizesReset = ->
  btn = $("parts-sizes-reset")
  return unless btn
  btn.disabled = Object.keys(partSizes).every (id) -> partSizes[id] is 100

# Fermer les réglages : applique en une seule fois les changements de voix
closeSettings = ->
  $("settings-overlay").classList.add "hidden"
  if partsChanged
    partsChanged = false
    reloadScore currentPage if fileLoaded and currentSources?.length

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
    updateStorageInfo()

  $("settings-close").addEventListener "click", closeSettings

  # Remet toutes les tailles de voix à 100 % (les voix masquées sont conservées)
  $("parts-sizes-reset").addEventListener "click", ->
    changed = Object.keys(partSizes).some (id) -> partSizes[id] isnt 100
    partSizes = {}
    saveHiddenParts()
    renderPartsList()
    partsChanged = true if changed

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
      reloadScore currentPage

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

  # Storage management button
  storageBtn = $("btn-storage")
  if storageBtn
    storageBtn.addEventListener "click", ->
      requestStorageQuota()

# Request increased storage quota for MusicXML files
requestStorageQuota = ->
  if navigator.storage?.estimate?
    # Check current usage
    navigator.storage.estimate().then (estimate) ->
      console.log "Storage usage: #{(estimate.usage / 1024 / 1024).toFixed(2)}MB / #{(estimate.quota / 1024 / 1024).toFixed(2)}MB"

      # Request more storage if needed (limit to 200MB)
      if estimate.quota < 200 * 1024 * 1024 # 200MB
        if navigator.storage.persist?
          navigator.storage.persist().then (persistent) ->
            if persistent
              console.log "✅ Storage persistence granted - extended quota available"
              showStorageMessage "Stockage étendu à 200MB activé", "success"
            else
              console.log "⚠️ Storage persistence denied"
              currentQuotaMB = (estimate.quota / 1024 / 1024).toFixed(0)
              showStorageMessage "Stockage limité à #{currentQuotaMB}MB", "warning"
        else
          console.log "Storage persistence not supported"
      else
        console.log "✅ Sufficient storage quota available (200MB or more)"

# Show storage-related messages
showStorageMessage = (message, type = 'info') ->
  messageEl = document.getElementById 'storage-message'
  unless messageEl
    messageEl = document.createElement 'div'
    messageEl.id = 'storage-message'
    messageEl.style.cssText = '''
      position: fixed;
      bottom: 60px;
      right: 20px;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      z-index: 1000;
      max-width: 300px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    '''
    document.body.appendChild messageEl

  # Set colors based on type
  colors =
    success: '#4caf50'
    warning: '#ff9800'
    error: '#f44336'
    info: '#2196f3'

  messageEl.style.background = colors[type] or colors.info
  messageEl.style.color = 'white'
  messageEl.textContent = message
  messageEl.style.display = 'block'

  # Auto-hide after 4 seconds
  setTimeout ->
    messageEl.style.display = 'none'
  , 4000

# Handle protocol handlers and URL parameters
handleProtocolParameters = ->
  urlParams = new URLSearchParams window.location.search

  # Handle file parameter from protocol handlers or share target
  fileParam = urlParams.get('file')
  if fileParam
    console.log "Protocol handler: Opening file #{fileParam}"

    # Handle different URL schemes
    if fileParam.startsWith('http://') or fileParam.startsWith('https://')
      # Remote file - fetch and load
      fetchFileFromUrl fileParam
    else if fileParam.startsWith('file://')
      # Local file (limited browser support)
      console.warn "Local file protocol not supported in browsers"
    else
      # Direct file path or base64 data
      loadFileFromParameter fileParam

  # Handle shared files via Web Share API
  sharedFile = urlParams.get('shared')
  if sharedFile
    console.log "Shared file detected"
    loadFileFromParameter sharedFile

# Fetch file from remote URL
fetchFileFromUrl = (url) ->
  console.log "Fetching remote file: #{url}"
  fetch url
    .then (response) ->
      if response.ok
        response.text()
      else
        throw new Error "HTTP #{response.status}: #{response.statusText}"
    .then (xmlContent) ->
      # Load the fetched MusicXML content
      loadMusicXMLContent xmlContent, url
    .catch (error) ->
      console.error "Failed to fetch remote file:", error
      showError "Impossible de charger le fichier distant: #{error.message}"

# Load file from URL parameter
loadFileFromParameter = (fileData) ->
  try
    if fileData.startsWith('data:') or fileData.startsWith('blob:')
      # Data URL or Blob URL
      loadFileFromDataUrl fileData
    else if fileData.includes('<') and fileData.includes('musicxml')
      # Direct XML content
      loadMusicXMLContent fileData, 'protocol-handler'
    else
      # Assume it's a filename that needs to be resolved
      console.warn "Unsupported file format in protocol handler"
  catch error
    console.error "Error loading file from parameter:", error
    showError "Erreur lors du chargement du fichier: #{error.message}"

# Load file from Data URL
loadFileFromDataUrl = (dataUrl) ->
  try
    # Extract base64 content from data URL
    matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if matches and matches[2]
      decodedContent = atob matches[2]
      loadMusicXMLContent decodedContent, 'data-url'
    else
      throw new Error "Invalid data URL format"
  catch error
    console.error "Error parsing data URL:", error
    showError "Format de fichier invalide"

# Load MusicXML content into the app
loadMusicXMLContent = (xmlContent, source = 'unknown') ->
  console.log "Loading MusicXML content from #{source}"

  # Create a temporary File object for the import system
  try
    # Parse XML to validate it's MusicXML
    parser = new DOMParser()
    xmlDoc = parser.parseFromString xmlContent, 'text/xml'

    if xmlDoc.getElementsByTagName('parsererror').length > 0
      throw new Error "Invalid XML format"

    # Check if it's MusicXML
    rootElement = xmlDoc.documentElement
    unless rootElement.tagName in ['score-partwise', 'score-timewise']
      throw new Error "Not a valid MusicXML file"

    # Create a File-like object
    filename = if source.includes('url') then 'remote.musicxml' else 'protocol-handler.musicxml'
    file = new File [xmlContent], filename, { type: 'application/vnd.recordare.musicxml+xml' }

    # Use existing import system
    handleFileImport file

  catch error
    console.error "Error processing MusicXML:", error
    showError "Fichier MusicXML invalide: #{error.message}"

# Show error message to user
showError = (message) ->
  # Create or update error notification
  errorEl = document.getElementById 'protocol-error'
  unless errorEl
    errorEl = document.createElement 'div'
    errorEl.id = 'protocol-error'
    errorEl.style.cssText = '''
      position: fixed;
      top: 20px;
      right: 20px;
      background: #f44336;
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      z-index: 10000;
      max-width: 300px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    '''
    document.body.appendChild errorEl

  errorEl.textContent = message
  errorEl.style.display = 'block'

  # Auto-hide after 5 seconds
  setTimeout ->
    errorEl.style.display = 'none'
  , 5000

# Init
document.addEventListener "DOMContentLoaded", ->
  applyAllSettings()
  setupNavigation()
  setupImport()
  setupLibrary()
  setupSettings()
  setupResize()

  # Request increased storage quota for MusicXML files
  requestStorageQuota()

  # Handle protocol handlers and file parameters
  handleProtocolParameters()

  # Vertical scroll listener: one alignment/indicator pass per frame
  $("page-current").addEventListener "scroll", ->
    return if scrollScheduled
    scrollScheduled = true
    requestAnimationFrame ->
      scrollScheduled = false
      applyVerticalAlignment()
      if scrollMode is "vertical"
        showIndicator()
        prefetch()
  # Worker will send "ready" when initialized
  worker.postMessage {type: "init"}
