# Cache persistant des données de lecture (MIDI + syncMarks), compressé.
# Même modèle que svgCache.coffee : Cache API + gzip, mais dans un cache
# DISTINCT pour pouvoir le purger et le préserver indépendamment des SVG.
#
# La clé inclut tout ce qui change la géométrie du rendu Verovio : fichier,
# mouvement, largeur, hauteur, échelle et variante de voix (masquage/tailles).
# Un zoom, une rotation, un redimensionnement ou un masquage produit donc une
# autre clé et ne sert jamais des marqueurs désalignés.

# IIFE : les modules inline partagent la portée globale. Sans cela, `cache`,
# `get`, `set`… écraseraient ceux de svgCache.coffee (même page, scripts inline).
do ->
  CACHE_NAME = "musica-playback-cache-v1"
  MAX_STORAGE_BYTES = 50 * 1024 * 1024  # 50 MB

  cache = null

  getCache = ->
    return Promise.resolve(cache) if cache
    caches.open(CACHE_NAME).then (c) ->
      cache = c
      c

  compress = (str) ->
    new Response(new Blob([str]).stream().pipeThrough(new CompressionStream("gzip"))).blob()

  decompress = (blob) ->
    new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text()

  makeKey = (fileId, movementId, width, height, scale, variant) ->
    file = encodeURIComponent(String(fileId ? ""))
    move = encodeURIComponent(String(movementId ? ""))
    geo = "#{Math.round(width ? 0)}x#{Math.round(height ? 0)}@#{Number(scale ? 0)}"
    "http://cache.local/playback/#{file}/#{move}/#{geo}/#{encodeURIComponent(variant or '')}"

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

  set = (fileId, movementId, data, width, height, scale, variant) ->
    return Promise.resolve() unless fileId? and movementId? and data?.midi
    try
      json = JSON.stringify data
    catch
      return Promise.resolve()
    getCache().then (c) ->
      compress(json).then (blob) ->
        return if blob.size > MAX_STORAGE_BYTES
        c.put(new Request(makeKey(fileId, movementId, width, height, scale, variant), method: "GET"), new Response(blob))
        .then -> trim c

  get = (fileId, movementId, width, height, scale, variant) ->
    return Promise.resolve(null) unless fileId? and movementId?
    getCache().then (c) ->
      c.match(new Request(makeKey(fileId, movementId, width, height, scale, variant))).then (response) ->
        return null unless response
        response.blob().then(decompress).then (text) ->
          try
            data = JSON.parse text
            return null unless data? and typeof data is "object" and data.midi
            data
          catch
            null

  clearAll = ->
    caches.delete(CACHE_NAME).then ->
      cache = null

  api =
    get: get
    set: set
    clearAll: clearAll
    makeKey: makeKey
    CACHE_NAME: CACHE_NAME
    MAX_STORAGE_BYTES: MAX_STORAGE_BYTES

  window.__playbackCache = api if typeof window isnt 'undefined'
  module.exports = api if typeof module isnt 'undefined' and module.exports?
