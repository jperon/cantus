# Affichage des pages (mode horizontal ou vertical), préchargement, indicateur
# de page et navigation (boutons, tap, clavier, sauts de mouvement).
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
  hideTransport()
  resetPlayback()

hideImport = ->
  $("import-section").classList.add "hidden"

showLibraryBtn = ->
  $("btn-library").classList.remove "hidden"
  $("btn-settings").classList.remove "hidden"

# Page shown in the indicator: in vertical mode, the page containing the top of
# the visible area (at the very end, the last rendered page: it may be shorter
# than the viewport). This is the single notion of "displayed page" shared by
# the indicator, position saving, reloads and movement jumps.
displayedPage = ->
  return Math.floor(scrollPos / 2) + 1 unless scrollMode is "vertical"
  slot = $("page-current")
  pages = slot.querySelectorAll(".scroll-page")
  return 1 if pages.length is 0
  firstPage = parseInt pages[0].dataset.page
  lastPage = parseInt pages[pages.length - 1].dataset.page
  maxScroll = slot.scrollHeight - slot.clientHeight
  # Bottom of the score: the last page stays displayed even if a shorter page
  # leaves the top of the viewport in the previous one
  shown = if maxScroll > 0 and slot.scrollTop >= maxScroll - 1
    lastPage
  else
    slotTop = slot.getBoundingClientRect().top
    page = firstPage
    for div in pages
      if div.getBoundingClientRect().bottom > slotTop
        page = parseInt div.dataset.page
        break
    page
  return shown unless pageCount > 0
  Math.max 1, Math.min shown, pageCount

# Bring a page to the top of the scrolling area in vertical mode
scrollToPageTop = (page) ->
  slot = $("page-current")
  pages = Array.from slot.querySelectorAll ".scroll-page"
  return if pages.length is 0
  firstPage = parseInt pages[0].dataset.page
  target = pages.find (div) -> parseInt(div.dataset.page) is page
  if target? and firstPage isnt page
    slotTop = slot.getBoundingClientRect().top
    slot.scrollTop = target.getBoundingClientRect().top - slotTop + slot.scrollTop
  else
    slot.scrollTop = 0

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
  syncMemoryVariant()
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
  # Un autre mouvement est affiché alors que rien ne joue : les données de
  # lecture en cours ne concernent plus l'écran. Pendant la lecture, ne pas
  # libérer le moteur : le saut de page change de mouvement sans interrompre
  # la lecture (voir seekToDisplayedPage).
  if fileLoaded and playback.movementId? and playback.state isnt "playing"
    current = getMovementForPage displayedPage()
    resetPlayback() if current? and current.movement.id isnt playback.movementId
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
    div.innerHTML = "<div class=\"loading-placeholder\">#{t 'loading'}</div>"
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
    # A jump changed the page list: move the scroll to its target page. If the
    # mode is not known yet (first render of a restored page), keep the target
    # for the next vertical display.
    if pendingPageScroll?
      scrollToPageTop pendingPageScroll
      pendingPageScroll = null
  else
    wrapper.classList.remove "vertical"
    wrapper.style.transform = "translateX(-#{offset}vw)"
    pendingPageScroll = null if scrollMode is "horizontal"

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
    page = displayedPage()
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
  pages = wrapper.querySelectorAll ".scroll-page"
  return if pages.length is 0
  # After a jump, the rendered pages do not start at page 1: the next page is
  # the one following the last rendered page
  lastPage = parseInt pages[pages.length - 1].dataset.page
  # If scrolled past 70% of loaded content, add more pages
  scrollProgress = slot.scrollTop / (slot.scrollHeight - slot.clientHeight)
  if scrollProgress > 0.7 and lastPage < pageCount
    nextPage = lastPage + 1
    div = document.createElement "div"
    div.className = "scroll-page"
    div.dataset.page = nextPage  # Identify page by number
    div.innerHTML = "<div class=\"loading-placeholder\">#{t 'loading'}</div>"
    wrapper.appendChild div
    renderPageAsync(nextPage).then (svg) ->
      if svg and div.isConnected
        div.innerHTML = svg
        requestAnimationFrame -> applyVerticalAlignment()
  prefetch()

# Première page de la fenêtre rendue (1 si le wrapper est vide)
firstRenderedPage = ->
  pages = $("page-current").querySelectorAll ".scroll-page"
  if pages.length > 0 then parseInt(pages[0].dataset.page) else 1

# Insère une page avant la fenêtre rendue sans déplacer le contenu visible :
# la page rendue qui suit sert de repère, sa position à l'écran est conservée
# dans scrollTop. Le placeholder réserve une hauteur d'écran ; quand le SVG
# arrive avec une autre hauteur, le repère est réaligné de la même façon.
prependPage = (page) ->
  slot = $("page-current")
  wrapper = slot.querySelector ".scroll-wrapper"
  return Promise.resolve() unless wrapper
  return Promise.resolve() if wrapper.querySelector ".scroll-page[data-page=\"#{page}\"]"
  div = document.createElement "div"
  div.className = "scroll-page"
  div.dataset.page = page
  div.innerHTML = "<div class=\"loading-placeholder\">#{t 'loading'}</div>"
  # Repère : la première page déjà rendue (celle que l'insertion repousse)
  anchor = wrapper.querySelector ".scroll-page"
  before = anchor?.getBoundingClientRect().top
  wrapper.insertBefore div, wrapper.firstChild
  slot.scrollTop += anchor.getBoundingClientRect().top - before if anchor?
  renderPageAsync(page).then (svg) ->
    return unless svg and div.isConnected
    before = anchor?.getBoundingClientRect().top if anchor?.isConnected
    div.innerHTML = svg
    if anchor?.isConnected and before?
      slot.scrollTop += anchor.getBoundingClientRect().top - before
    requestAnimationFrame -> applyVerticalAlignment()

# Symétrique de checkAndLoadMorePages vers le haut : près du haut de la
# fenêtre rendue, la page précédente est insérée au-dessus (repère conservé,
# donc le contenu visible reste immobile). Seul un défilement manuel récent
# peut le déclencher : les sauts programmés de la navigation ne doivent pas
# ajouter une page que l'utilisateur n'a pas demandée.
manualScrollAt = 0

checkAndLoadPreviousPage = ->
  return unless scrollMode is "vertical"
  return unless Date.now() - manualScrollAt < 300
  slot = $("page-current")
  first = firstRenderedPage()
  return if first <= 1
  return unless slot.scrollTop < slot.clientHeight * 0.3
  prependPage first - 1

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
  # In vertical mode the jump must also move the scroll to the target page
  pendingPageScroll = Math.floor(scrollPos / 2) + 1
  displayView()
  showIndicator()
  prefetch()
  savePositionDebounced()
  # Saut explicite (boutons de page, ±5, goto) : cale la lecture sur la page
  noteDisplayedPage()

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
    # goNext vertical ne passe pas par setScrollPos : signaler le saut explicite
    schedulePageSeek displayedPage()
  else
    return if scrollPos >= maxScrollPos()
    captureVerticalScroll()
    setScrollPos(scrollPos + 1)

# Recul vertical. Un appui peut devoir attendre le rendu de la page
# précédente : les appuis successifs sont sérialisés pour ne pas viser une
# cible calculée sur une fenêtre encore incomplète.
verticalBack = null

verticalStepBack = ->
  slot = $("page-current")
  return unless slot
  # En haut de la fenêtre rendue alors que des pages précèdent : les rendre
  # au-dessus (hauteur compensée), sinon scrollTop resterait à 0 et le recul
  # serait impossible hors saut de 5 pages.
  prepare = if slot.scrollTop <= SYSTEM_TOLERANCE and firstRenderedPage() > 1
    prependPage firstRenderedPage() - 1
  else
    Promise.resolve()
  prepare.then ->
    return unless fileLoaded and scrollMode is "vertical"
    slot = $("page-current")
    return if slot.scrollTop <= 0
    slot.scrollTo top: verticalTarget(-1), behavior: "instant"
    verticalPos = Math.max(0, verticalPos - 1)
    showIndicator()
    savePositionDebounced()
    schedulePageSeek displayedPage()

enqueueVerticalBack = ->
  done = (verticalBack ? Promise.resolve())
    .then -> verticalStepBack()
    .catch (err) -> console.error "Recul vertical impossible : #{err?.message or err}"
  verticalBack = done
  done.then -> verticalBack = null if verticalBack is done

goPrev = ->
  return unless fileLoaded
  if scrollMode is "vertical"
    enqueueVerticalBack()
  else
    return if scrollPos <= 0
    captureVerticalScroll()
    setScrollPos(scrollPos - 1)

# Get current movement index from the displayed page
getCurrentMovementIndex = ->
  topPage = displayedPage()
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

goBack5 = ->
  return unless fileLoaded
  if scrollMode is "vertical"
    goToPage Math.max(1, displayedPage() - 5)
  else
    setScrollPos Math.max(0, scrollPos - 10)

goForward5 = ->
  return unless fileLoaded
  if scrollMode is "vertical"
    goToPage Math.min(pageCount, displayedPage() + 5)
  else
    setScrollPos Math.min(maxScrollPos(), scrollPos + 10)

