# SVG Cache with compression using Cache API
# Simpler than IndexedDB, works reliably

# v2 : les versions précédentes pouvaient enregistrer sous la clé courante une
# page rendue avec une autre variante de voix (un SVG en vol au moment d'un
# changement de tailles). Ces entrées ne sont pas fiables : le cache change de
# nom et l'ancien est supprimé.
# v3 : le masquage d'une voix retire désormais les part-group devenus vides,
# ce qui peut changer la pagination ; une page v2 ne correspondrait plus au
# pont mesure→page reconstruit (suivi sur la mauvaise page).
CACHE_NAME = "musica-svg-cache-v3"
LEGACY_CACHE_NAMES = ["musica-svg-cache-v1", "musica-svg-cache-v2"]
MAX_STORAGE_BYTES = 100 * 1024 * 1024  # 100 MB limit

# Un put sur ce nombre déclenche la vérification du plafond de stockage :
# parcourir toutes les entrées à chaque page coûterait trop cher.
TRIM_EVERY = 10

cache = null
putsSinceTrim = 0

# Get or create cache
getCache = ->
  return Promise.resolve(cache) if cache
  # Purge unique des caches de rendu d'anciennes versions
  Promise.all(LEGACY_CACHE_NAMES.map (name) -> caches.delete name).catch ->
    null
  .then ->
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

# Variante contenue dans une clé (« fichier/page/largeurxhauteur/variante »)
variantOf = (url) ->
  parts = url.split "/"
  geometry = parts[parts.length - 2]
  return "" unless /^\d+x\d+$/.test geometry
  decodeURIComponent parts[parts.length - 1]

fileOf = (url) ->
  marker = "/svg/"
  index = url.indexOf marker
  return "" if index < 0
  rest = url.slice(index + marker.length)
  rest.slice 0, rest.indexOf "/"

# Vide les plus anciennes entrées (ordre d'insertion de Cache.keys) tant que
# le total compressé dépasse le plafond.
trim = (c) ->
  c.keys().then (requests) ->
    Promise.all requests.map (request) ->
      c.match(request).then (response) ->
        return null unless response
        response.blob().then (blob) -> {request, size: blob.size}
    .then (entries) ->
      list = (entry for entry in entries when entry?)
      total = list.reduce ((sum, entry) -> sum + entry.size), 0
      return if total <= MAX_STORAGE_BYTES
      for entry in list
        break if total <= MAX_STORAGE_BYTES
        total -= entry.size
        c.delete entry.request
      return

# Store SVG in cache (includes dimensions and parts variant)
set = (fileId, page, svg, width, height, variant) ->
  return Promise.resolve() unless svg and fileId
  getCache().then (c) ->
    compress(svg).then (blob) ->
      # Cache API requires a Request object as key
      c.put(new Request(makeKey(fileId, page, width, height, variant), method: "GET"), new Response(blob))
    .then ->
      putsSinceTrim += 1
      return unless putsSinceTrim >= TRIM_EVERY
      putsSinceTrim = 0
      trim c

# Retrieve SVG from cache (includes dimensions and parts variant)
get = (fileId, page, width, height, variant) ->
  return Promise.resolve(null) unless fileId
  getCache().then (c) ->
    c.match(new Request(makeKey(fileId, page, width, height, variant))).then (response) ->
      return null unless response
      response.blob().then decompress

# Supprime les pages d'un fichier dont la variante de voix n'est plus la
# variante courante : changer de tailles rend les anciennes inutiles (elles
# s'accumuleraient sinon à chaque essai de réglage). Les entrées des autres
# géométries (zoom, rotation) sont conservées.
pruneVariants = (fileId, keepVariant) ->
  return Promise.resolve() unless fileId
  getCache().then (c) ->
    c.keys().then (requests) ->
      stale = requests.filter (request) ->
        url = request.url
        fileOf(url) is String(fileId) and variantOf(url) isnt (keepVariant or "")
      Promise.all stale.map (request) -> c.delete request

# Clear all cached SVGs
clearAll = ->
  caches.delete(CACHE_NAME).then ->
    cache = null

# Clés présentes (tests et mise au point)
keys = ->
  getCache().then (c) -> c.keys().then (requests) -> (request.url for request in requests)

window.__svgCache =
  get: get
  set: set
  pruneVariants: pruneVariants
  keys: keys
  clearAll: clearAll
  makeKey: makeKey
  CACHE_NAME: CACHE_NAME
