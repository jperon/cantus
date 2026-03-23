# SVG Cache with compression using Cache API
# Simpler than IndexedDB, works reliably

CACHE_NAME = "musica-svg-cache-v1"
STRUCTURE_CACHE_NAME = "musica-structure-cache-v1"
MAX_STORAGE_BYTES = 100 * 1024 * 1024  # 100 MB limit

fflate = window.__fflate
cache = null
structureCache = null

# Get or create cache
getCache = ->
  return Promise.resolve(cache) if cache
  caches.open(CACHE_NAME).then (c) ->
    cache = c
    c

# Get or create structure cache
getStructureCache = ->
  return Promise.resolve(structureCache) if structureCache
  caches.open(STRUCTURE_CACHE_NAME).then (c) ->
    structureCache = c
    c

# Compress SVG string to Uint8Array using gzip
compress = (svgString) ->
  return null unless fflate
  encoder = new TextEncoder()
  data = encoder.encode(svgString)
  fflate.gzipSync(data)

# Decompress Uint8Array back to SVG string
decompress = (compressed) ->
  return null unless fflate
  decompressed = fflate.gunzipSync(compressed)
  decoder = new TextDecoder()
  decoder.decode(decompressed)

# Generate cache key as full URL
makeKey = (fileId, page) ->
  "http://cache.local/svg/#{fileId}/#{page}"

# Store SVG in cache
set = (fileId, page, svg) ->
  return Promise.resolve() unless svg and fileId
  getCache().then (c) ->
    compressed = compress(svg)
    return unless compressed

    key = makeKey(fileId, page)
    # Cache API requires a Request object as key
    request = new Request(key, method: "GET")
    blob = new Blob([compressed], type: "application/octet-stream")
    response = new Response(blob)
    c.put(request, response).then ->
      console.log "Cache écriture: #{fileId}:#{page} (#{compressed.byteLength} bytes compressé)"

# Retrieve SVG from cache
get = (fileId, page) ->
  return Promise.resolve(null) unless fileId
  getCache().then (c) ->
    key = makeKey(fileId, page)
    request = new Request(key)
    c.match(request).then (response) ->
      return null unless response
      response.arrayBuffer().then (buffer) ->
        svg = decompress(new Uint8Array(buffer))
        console.log "Cache lecture: #{fileId}:#{page} (#{buffer.byteLength} bytes)"
        svg

# Get total storage size
getStorageSize = ->
  getCache().then (c) ->
    c.keys().then (keys) ->
      total = 0
      promises = keys.map (req) ->
        c.match(req).then (res) ->
          res.arrayBuffer().then (buf) ->
            total += buf.byteLength
      Promise.all(promises).then -> total

# Clear all cached SVGs
clearAll = ->
  caches.delete(CACHE_NAME).then ->
    cache = null

# Structure cache key
makeStructureKey = (fileId) ->
  "http://cache.local/structure/#{fileId}"

# Store structure info (split points, movement data)
setStructure = (fileId, structure) ->
  return Promise.resolve() unless structure and fileId
  getStructureCache().then (c) ->
    json = JSON.stringify(structure)
    compressed = compress(json)
    return unless compressed

    key = makeStructureKey(fileId)
    request = new Request(key, method: "GET")
    blob = new Blob([compressed], type: "application/octet-stream")
    response = new Response(blob)
    c.put(request, response).then ->
      console.log "Cache structure: #{fileId} (#{compressed.byteLength} bytes)"

# Retrieve structure info from cache
getStructure = (fileId) ->
  return Promise.resolve(null) unless fileId
  getStructureCache().then (c) ->
    key = makeStructureKey(fileId)
    request = new Request(key)
    c.match(request).then (response) ->
      return null unless response
      response.arrayBuffer().then (buffer) ->
        json = decompress(new Uint8Array(buffer))
        try
          JSON.parse(json)
        catch
          null

window.__svgCache =
  get: get
  set: set
  getStructure: getStructure
  setStructure: setStructure
  getStorageSize: getStorageSize
  clearAll: clearAll
