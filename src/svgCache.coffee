# SVG Cache with compression using Cache API
# Simpler than IndexedDB, works reliably

CACHE_NAME = "musica-svg-cache-v1"
STRUCTURE_CACHE_NAME = "musica-structure-cache-v1"
MAX_STORAGE_BYTES = 100 * 1024 * 1024  # 100 MB limit

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

# Compress string to gzip Blob
compress = (str) ->
  new Response(new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"))).blob()

# Decompress gzip Blob back to string
decompress = (blob) ->
  new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text()

# Generate cache key as full URL (includes dimensions for portrait/landscape)
makeKey = (fileId, page, width, height) ->
  "http://cache.local/svg/#{fileId}/#{page}/#{width}x#{height}"

# Store SVG in cache (includes dimensions)
set = (fileId, page, svg, width, height) ->
  return Promise.resolve() unless svg and fileId
  getCache().then (c) ->
    compress(svg).then (blob) ->
      # Cache API requires a Request object as key
      c.put(new Request(makeKey(fileId, page, width, height), method: "GET"), new Response(blob)).then ->
        console.log "Cache écriture: #{fileId}:#{page} (#{blob.size} bytes compressé)"

# Retrieve SVG from cache (includes dimensions)
get = (fileId, page, width, height) ->
  return Promise.resolve(null) unless fileId
  getCache().then (c) ->
    c.match(new Request(makeKey(fileId, page, width, height))).then (response) ->
      return null unless response
      response.blob().then (blob) ->
        decompress(blob).then (svg) ->
          console.log "Cache lecture: #{fileId}:#{page} (#{blob.size} bytes)"
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
    compress(JSON.stringify(structure)).then (blob) ->
      c.put(new Request(makeStructureKey(fileId), method: "GET"), new Response(blob)).then ->
        console.log "Cache structure: #{fileId} (#{blob.size} bytes)"

# Retrieve structure info from cache
getStructure = (fileId) ->
  return Promise.resolve(null) unless fileId
  getStructureCache().then (c) ->
    c.match(new Request(makeStructureKey(fileId))).then (response) ->
      return null unless response
      response.blob().then(decompress).then (json) ->
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
