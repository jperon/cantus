# Web Worker — Verovio rendering
# Verovio UMD is prepended by the build script, exposing globalThis.verovio

tk = null

preprocessMusicXML = (xmlString) ->
  parser = new DOMParser()
  doc = parser.parseFromString xmlString, "application/xml"

  measures = Array.from doc.querySelectorAll("measure")
  for measure, i in measures
    barlines = measure.querySelectorAll('barline[location="right"]')
    hasBreak = false
    for barline in barlines
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

loadScore = (xmlString, pageWidth) ->
  processedXml = preprocessMusicXML xmlString
  tk.setOptions
    breaks: "encoded"
    adjustPageHeight: true
    pageWidth: pageWidth
    scale: 40
  tk.loadData processedXml
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
        tk = new verovio.toolkit()
        self.postMessage { type: "ready" }

      when "load"
        {xml, pageWidth} = e.data
        loadScore xml, pageWidth

      when "render"
        renderPage e.data.page

  catch err
    self.postMessage { type: "error", message: err.message or String(err) }
