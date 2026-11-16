# SVG Cache with compression using Cache API
# Simpler than IndexedDB, works reliably

CACHE_NAME = "musica-svg-cache-v1"
MAX_STORAGE_BYTES = 100 * 1024 * 1024  # 100 MB limit

cache = null

# Get or create cache
getCache = ->
  return Promise.resolve(cache) if cache
  caches.open(CACHE_NAME).then (c) ->
    cache = c
    c

# Compress string to gzip Blob
compress = (str) ->
  new Response(new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"))).blob()

# Decompress gzip Blob back to string
decompress = (blob) ->
  new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text()

# Generate cache key as full URL (includes dimensions for portrait/landscape
# and the visible-parts variant)
makeKey = (fileId, page, width, height, variant) ->
  "http://cache.local/svg/#{fileId}/#{page}/#{width}x#{height}/#{variant or ''}"

# Store SVG in cache (includes dimensions and parts variant)
set = (fileId, page, svg, width, height, variant) ->
  return Promise.resolve() unless svg and fileId
  getCache().then (c) ->
    compress(svg).then (blob) ->
      # Cache API requires a Request object as key
      c.put(new Request(makeKey(fileId, page, width, height, variant), method: "GET"), new Response(blob))

# Retrieve SVG from cache (includes dimensions and parts variant)
get = (fileId, page, width, height, variant) ->
  return Promise.resolve(null) unless fileId
  getCache().then (c) ->
    c.match(new Request(makeKey(fileId, page, width, height, variant))).then (response) ->
      return null unless response
      response.blob().then decompress

# Clear all cached SVGs
clearAll = ->
  caches.delete(CACHE_NAME).then ->
    cache = null

window.__svgCache =
  get: get
  set: set
  clearAll: clearAll
