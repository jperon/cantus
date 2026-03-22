# Web Worker — Verovio rendering
# Verovio UMD is prepended by the build script, exposing globalThis.verovio

tk = null

# Promise that resolves when Verovio WASM is fully initialized
verovioReady = new Promise (resolve) ->
  mod = verovio.module
  if mod.calledRun
    resolve()
  else
    prevCallback = mod.onRuntimeInitialized
    mod.onRuntimeInitialized = ->
      prevCallback?()
      resolve()

loadScore = (xmlString, pageWidth, pageHeight, scale = 40) ->
  tk.setOptions
    breaks: "auto"
    adjustPageHeight: false
    pageWidth: pageWidth
    pageHeight: pageHeight
    scale: scale
  tk.loadData xmlString
  pageCount = tk.getPageCount()
  self.postMessage { type: "loaded", pageCount }

renderPage = (pageNumber) ->
  svg = tk.renderToSVG pageNumber
  self.postMessage { type: "svg", page: pageNumber, svg }

self.onmessage = (e) ->
  {type} = e.data
  try
    switch type
      when "init"
        verovioReady.then ->
          tk = new verovio.toolkit()
          self.postMessage { type: "ready" }
        .catch (err) ->
          self.postMessage { type: "error", message: err.message or String(err) }

      when "load"
        {xml, pageWidth, pageHeight, scale} = e.data
        loadScore xml, pageWidth, pageHeight, scale

      when "render"
        renderPage e.data.page

  catch err
    self.postMessage { type: "error", message: err.message or String(err) }
