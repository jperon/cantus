# Web Worker — Verovio rendering with movement support
# Supports multiple movements loaded sequentially

tk = null
verovioLoaded = false
verovioUrl = null
movements = {}  # movementId -> {pageCount, loaded, xml, options}
currentMovement = null

# Clear all movements (call before loading new file)
clearMovements = ->
  movements = {}
  currentMovement = null

# Load Verovio dynamically and initialize
loadVerovio = (url) ->
  new Promise (resolve, reject) ->
    try
      importScripts(url)
      verovioLoaded = true

      mod = verovio.module
      if mod.INITIAL_MEMORY?
        mod.INITIAL_MEMORY = 8 * 1024 * 1024

      verovioReady = new Promise (resolveInit) ->
        if mod.calledRun
          resolveInit()
        else
          prevCallback = mod.onRuntimeInitialized
          mod.onRuntimeInitialized = ->
            prevCallback?()
            resolveInit()

      verovioReady.then ->
        tk = new verovio.toolkit()
        resolve()
      .catch (err) ->
        reject(err)
    catch err
      reject(err)

loadMovement = (movementId, xmlString, pageWidth, pageHeight, scale = 40) ->
  options =
    breaks: "auto"
    adjustPageHeight: true
    pageWidth: pageWidth
    pageHeight: pageHeight
    scale: scale
    condense: "none"
    header: "none"
    footer: "none"
  tk.setOptions options
  loaded = tk.loadData xmlString
  unless loaded
    self.postMessage { type: "error", movementId, message: "Failed to load movement data" }
    return
  pageCount = tk.getPageCount()
  movements[movementId] = {pageCount, loaded: true, xml: xmlString, options}
  currentMovement = movementId
  self.postMessage { type: "movementLoaded", movementId, pageCount }

# Switch to a different movement if needed
switchToMovement = (movementId) ->
  return true if currentMovement is movementId
  mv = movements[movementId]
  unless mv?.loaded
    return false
  # Reload the movement data only if movement changed
  console.log "Switching to movement #{movementId}"
  tk.setOptions mv.options
  loaded = tk.loadData mv.xml
  unless loaded
    return false
  currentMovement = movementId
  true

renderMovementPage = (movementId, pageNumber) ->
  # Switch to the requested movement
  console.log "Rendering page #{pageNumber} for movement #{movementId}"
  unless switchToMovement(movementId)
    self.postMessage { type: "error", movementId, message: "Movement not loaded" }
    return

  console.log "Calling tk.renderToSVG for page #{pageNumber}"
  svg = tk.renderToSVG pageNumber
  console.log "SVG generated for page #{pageNumber}, size: #{svg.length}"
  self.postMessage { type: "svg", movementId, page: pageNumber, svg }

self.onmessage = (e) ->
  {type} = e.data
  try
    switch type
      when "setVerovioUrl"
        verovioUrl = e.data.url
        loadVerovio(verovioUrl)
          .then ->
            self.postMessage { type: "ready" }
          .catch (err) ->
            self.postMessage { type: "error", message: "Failed to load Verovio: #{err.message or String(err)}" }

      when "init"
        if tk
          self.postMessage { type: "ready" }

      when "clearMovements"
        clearMovements()

      when "loadMovement"
        return unless tk
        {movementId, xmlString, pageWidth, pageHeight, scale} = e.data
        loadMovement movementId, xmlString, pageWidth, pageHeight, scale

      when "renderMovementPage"
        return unless tk
        {movementId, page} = e.data
        renderMovementPage movementId, page

  catch err
    self.postMessage { type: "error", message: err.message or String(err) }
