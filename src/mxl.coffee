# mxl.coffee — Extract MusicXML from .mxl (ZIP) files
# fflate is injected by build.js as window.__fflate

extractMxl = (arrayBuffer) ->
  fflate = window.__fflate
  data = new Uint8Array arrayBuffer
  files = fflate.unzipSync data

  # Try to find the rootfile from META-INF/container.xml
  containerPath = null
  for path of files
    if path is "META-INF/container.xml"
      containerPath = path
      break

  rootFile = null
  if containerPath
    containerXml = new TextDecoder().decode files[containerPath]
    parser = new DOMParser()
    doc = parser.parseFromString containerXml, "application/xml"
    rootfileEl = doc.querySelector("rootfile")
    if rootfileEl
      rootFile = rootfileEl.getAttribute("full-path")

  # If container.xml didn't work, find the first .xml file that isn't in META-INF
  unless rootFile and files[rootFile]
    for path of files
      if path.match(/\.xml$/i) and not path.match(/^META-INF/i)
        rootFile = path
        break

  unless rootFile and files[rootFile]
    throw new Error "Aucun fichier MusicXML trouvé dans l'archive MXL"

  new TextDecoder().decode files[rootFile]

# Detect if a file is MXL based on name or content
isMxlFile = (file) ->
  file.name?.match(/\.mxl$/i)

window.__musicaMxl = { extractMxl, isMxlFile }
