# Web Worker — Verovio rendering with movement support
# Supports multiple movements loaded sequentially

tk = null
verovioLoaded = false
movements = {}  # movementId -> {pageCount, loaded, xml, options}
currentMovement = null
pending = []  # messages waiting for the toolkit, replayed once Verovio is ready
msczLoad = null  # mscz2xml loading promise, created on first MuseScore conversion
msczInline = null  # SPA: {wasmJs, js, wasm} sources sent by the page

# Clear all movements (call before loading new file)
clearMovements = ->
  movements = {}
  currentMovement = null

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

# Load the MuseScore converter once: the package in the normal build, the
# inlined wasm module in the SPA. Both resolve an object with convert(bytes).
loadMscz2xml = ->
  return msczLoad if msczLoad
  msczLoad = new Promise (resolve, reject) ->
    try
      if msczInline
        # SPA : évaluer wasm-bindgen (portée globale) puis lui donner le .wasm inliné
        self.eval msczInline.wasmJs + '\nself.wasm_bindgen = wasm_bindgen;'
        bytes = Uint8Array.from atob(msczInline.wasm), (c) -> c.charCodeAt 0
        self.wasm_bindgen { module_or_path: bytes }
          .then -> resolve self.wasm_bindgen
          .catch reject
      else
        self.MSCZ2XML_BASE_URL = new URL('mscz2xml/', self.location.href).href
        importScripts 'mscz2xml/mscz2xml.js'
        self.mscz2xml.ready.then -> resolve self.mscz2xml
    catch err
      reject err
  msczLoad

# Render one page of the currently loaded movement and send it back
postPage = (movementId, pageNumber) ->
  self.postMessage {
    type: "svg"
    movementId
    page: pageNumber
    svg: tk.renderToSVG pageNumber
  }

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
  # Only the first pages are pushed now; the rest are rendered on demand
  # (renderMovementPage), so a big file is not rendered and cached entirely
  pushed = Math.min pageCount, 2
  self.postMessage {
    type: "movementLoaded"
    movementId
    pageCount
    pushed
  }
  if pushed > 0
    postPage movementId, page for page in [1..pushed]

# Switch to a different movement if needed
switchToMovement = (movementId) ->
  return true if currentMovement is movementId
  mv = movements[movementId]
  unless mv?.loaded
    return false
  # Reload the movement data only if movement changed
  tk.setOptions mv.options
  loaded = tk.loadData mv.xml
  unless loaded
    return false
  currentMovement = movementId
  true

renderMovementPage = (movementId, pageNumber) ->
  # Switch to the requested movement
  unless switchToMovement(movementId)
    self.postMessage {
      type: "error"
      movementId
      message: "Movement not loaded"
    }
    return

  postPage movementId, pageNumber

handleMessage = (e) ->
  { type } = e.data
  # These need the toolkit: keep them instead of dropping them before initialization
  if not tk and type in ["loadMovement", "renderMovementPage", "clearMovements"]
    pending.push e.data
    return
  try
    switch type
      when "verovioInline"
        # Verovio is inlined in SPA mode - initialize it
        verovioLoaded = true
        initVerovio(
          -> notifyReady()
          (err) ->
            self.postMessage {
              type: "error"
              message: "Failed to initialize Verovio: #{err.message or String(err)}"
            }
        )

      when "setVerovioUrl"
        loadVerovio(e.data.url)
          .then ->
            notifyReady()
          .catch (err) ->
            self.postMessage {
              type: "error"
              message: "Failed to load Verovio: #{err.message or String(err)}"
            }

      when "init"
        notifyReady() if tk

      when "msczInline"
        msczInline = e.data

      when "convertMscz"
        { id, bytes } = e.data
        loadMscz2xml()
          .then (api) -> api.convert new Uint8Array(bytes)
          .then (xml) ->
            self.postMessage { type: "msczConverted", id, xml }
          .catch (err) ->
            self.postMessage {
              type: "msczError"
              id
              message: err.message or String(err)
            }

      when "clearMovements"
        clearMovements()

      when "loadMovement"
        {
          movementId
          xmlString
          pageWidth
          pageHeight
          scale
        } = e.data
        loadMovement movementId, xmlString, pageWidth, pageHeight, scale

      when "renderMovementPage"
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

# Replay the messages received before Verovio was ready, in arrival order
flushPending = ->
  queued = pending
  pending = []
  handleMessage {data} for data in queued

# Tell the app Verovio is ready, then process the messages that arrived too early
notifyReady = ->
  self.postMessage {type: "ready"}
  flushPending()

self.onmessage = handleMessage
