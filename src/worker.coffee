# Web Worker — Verovio rendering with movement support
# Supports multiple movements loaded sequentially

tk = null
verovioLoaded = false
verovioUrl = null
verovioInline = false  # True when Verovio is inlined in SPA mode
movements = {}  # movementId -> {pageCount, loaded, xml, options}
currentMovement = null

# Clear all movements (call before loading new file)
clearMovements = ->
  movements = {}
  currentMovement = null

# Initialize Verovio from global scope (received from main thread)
initVerovioFromGlobal = (verovioGlobal) ->
  try
    # Make Verovio available in worker scope
    self.verovio = verovioGlobal
    verovioLoaded = true

    # Initialize toolkit
    mod = verovioGlobal.module
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
      tk = new verovioGlobal.toolkit()
      console.log "Worker: Verovio initialized from global scope"
    .catch (err) ->
      console.error "Worker: Verovio initialization failed:", err

  catch err
    console.error "Worker: Failed to initialize Verovio from global:", err

# Load Verovio dynamically and initialize
loadVerovio = (url) ->
  new Promise (resolve, reject) ->
    try
      # Check if Verovio is already loaded in this worker scope
      if verovioLoaded and tk
        console.log "Worker: Verovio already loaded and initialized"
        resolve()
        return

      # Check if it's a blob URL - use fetch+eval instead of importScripts
      if url.startsWith('blob:')
        fetch(url)
          .then (response) -> response.text()
          .then (code) ->
            eval(code)
            verovioLoaded = true
            initVerovio(resolve, reject)
          .catch reject
        return

      # For regular URLs, try to get from cache first (local-first)
      if not verovioLoaded
        console.log "Worker: Loading Verovio from cache/network: #{url}"

        # Try importScripts (will use cache if available via SW)
        try
          importScripts(url)
          verovioLoaded = true
          console.log "Worker: Verovio loaded via importScripts"
        catch importError
          console.error "Worker: importScripts failed, trying fetch:", importError

          # Fallback to fetch+eval
          fetch(url)
            .then (response) ->
              if response.ok
                response.text().then (code) ->
                  eval(code)
                  verovioLoaded = true
                  console.log "Worker: Verovio loaded via fetch+eval"
                  initVerovio(resolve, reject)
              else
                throw new Error "Failed to fetch Verovio: #{response.status}"
            .catch (fetchError) ->
              console.error "Worker: fetch also failed:", fetchError
              reject fetchError
          return

      initVerovio(resolve, reject)
    catch err
      console.error "Worker: Error in loadVerovio:", err
      reject(err)

# Initialize Verovio after loading
initVerovio = (resolve, reject) ->
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

# Initialize inline Verovio (already loaded in worker code)
initInlineVerovio = ->
  return unless typeof verovio != 'undefined' and not verovioLoaded
  verovioLoaded = true
  verovioInline = true
  initVerovio(
    -> console.log 'Inline Verovio initialized'
    (err) -> console.error 'Inline Verovio init failed:', err
  )

loadMovement = (movementId, xmlString, pageWidth, pageHeight, scale = 40) ->
  options = {
    breaks: "auto"
    adjustPageHeight: true
    pageWidth: pageWidth
    pageHeight: pageHeight
    scale: scale
    condense: "none"
    header: "none"
    footer: "none"
  }
  tk.setOptions options
  loaded = tk.loadData xmlString
  unless loaded
    self.postMessage {
      type: "error"
      movementId
      message: "Failed to load movement data"
    }
    return
  pageCount = tk.getPageCount()
  movements[movementId] = {
    pageCount
    loaded: true
    xml: xmlString
    options
  }
  currentMovement = movementId
  self.postMessage {
    type: "movementLoaded"
    movementId
    pageCount
  }

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
    self.postMessage {
      type: "error"
      movementId
      message: "Movement not loaded"
    }
    return

  console.log "Calling tk.renderToSVG for page #{pageNumber}"
  svg = tk.renderToSVG pageNumber
  console.log "SVG generated for page #{pageNumber}, size: #{svg.length}"
  self.postMessage {
    type: "svg"
    movementId
    page: pageNumber
    svg
  }

self.onmessage = (e) ->
  { type } = e.data
  try
    switch type
      when "verovioInline"
        # Verovio is inlined in SPA mode - initialize it
        self.postMessage {
          type: "ready"
        }

      when "setVerovioUrl"
        verovioUrl = e.data.url
        verovioAvailable = e.data.verovioAvailable

        if verovioAvailable
          console.log "Worker: Verovio available in main thread, loading optimized"
          # Verovio is cached by SW, load should be fast
          loadVerovio(verovioUrl)
            .then ->
              self.postMessage {
                type: "ready"
              }
            .catch (err) ->
              self.postMessage {
                type: "error"
                message: "Failed to load Verovio: #{err.message or String(err)}"
              }
        else
          console.log "Worker: Verovio not in main thread, loading normally"
          loadVerovio(verovioUrl)
            .then ->
              self.postMessage {
                type: "ready"
              }
            .catch (err) ->
              self.postMessage {
                type: "error"
                message: "Failed to load Verovio: #{err.message or String(err)}"
              }

      when "init"
        if tk
          self.postMessage {
            type: "ready"
          }

      when "clearMovements"
        clearMovements()

      when "loadMovement"
        return unless tk
        {
          movementId
          xmlString
          pageWidth
          pageHeight
          scale
        } = e.data
        loadMovement movementId, xmlString, pageWidth, pageHeight, scale

      when "renderMovementPage"
        return unless tk
        {
          movementId
          page
        } = e.data
        renderMovementPage movementId, page

  catch err
    self.postMessage {
      type: "error"
      message: err.message or String(err)
    }
