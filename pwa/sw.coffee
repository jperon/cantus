# Service Worker for Cantus PWA
# Progressive Web App with offline support and intelligent caching

VERSION = 'dev'
# v2 : passage de la banque MIDI.js au SF3 TimGM6mb et à SpessaSynth, avec son
# processeur AudioWorklet. Les anciens caches statiques sont supprimés.
STATIC_CACHE = "musica-static-v2-#{VERSION}"
DYNAMIC_CACHE = "musica-dynamic-#{VERSION}"

# Essential assets for offline functionality
STATIC_ASSETS = [
  './'
  './index.html'
  './worker.js'
  './manifest.json'
  './favicon.ico'
  './icons/icon-192.png'
  './icons/icon-512.png'
  './verovio-toolkit-wasm.js'
]

# Import MuseScore (paquet scoretk facultatif, absent des builds sans scoretk)
SCORETK_ASSETS = [
  './scoretk/scoretk.js'
  './scoretk/scoretk_wasm.js'
  './scoretk/scoretk_wasm_bg.wasm'
]

# Banque General MIDI et processeur AudioWorklet (facultatifs : absents des
# builds sans soundfonts)
SOUNDFONT_ASSETS = [
  './soundfonts/TimGM6mb.sf3'
  './soundfonts/spessasynth_processor.min.js'
]

# Formats importables : injectés par build.js depuis src/formats.coffee, seule
# source des extensions et types MIME (les marqueurs sont remplacés à la
# compilation, comme PRESERVED_CACHES).
#   MIME_EXTENSIONS : type MIME -> extension du nom de repli (partage)
#   SHARE_EXT_RE    : extensions retirées pour nommer une entrée partagée
MIME_EXTENSIONS = {}
SHARE_EXT_RE = null

# Installation - cache static assets
# Le nouveau SW reste en attente : `src/app/demarrage.coffee` propose la mise à jour,
# puis envoie SKIP_WAITING quand l'utilisateur l'accepte.
self.addEventListener 'install', (event) ->
  console.log 'SW: Installation started'
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then (cache) ->
        console.log 'SW: Caching static assets'
        cache.addAll STATIC_ASSETS.map((u) -> new Request(u, cache: 'reload'))
          .then ->
            # Mise en cache séparée : un paquet scoretk absent ne doit pas
            # faire échouer l'installation du service worker
            Promise.all(
              SCORETK_ASSETS.concat(SOUNDFONT_ASSETS).map (u) ->
                cache.add(new Request(u, cache: 'reload')).catch (err) ->
                  console.warn 'SW: asset facultatif non mis en cache', u, err
            )
  )

# Caches de rendus qui contiennent les documents de l'utilisateur : ils ne
# dépendent pas de la version du service worker et sont préservés aux mises à
# jour. Le cache de lecture doit rester ici, sinon MIDI + syncMarks seraient
# recalculés à chaque déploiement.
# Renseigné au build depuis CACHE_NAME de src/svgCache.coffee et
# src/playbackCache.coffee (build.js échoue si une valeur manque).
PRESERVED_CACHES = []

# Un cache est ancien s'il appartient à ce service worker mais pas à cette
# version, et qu'il n'est pas un cache de rendu préservé.
isOldCache = (name) ->
  return false if name in PRESERVED_CACHES
  name is 'musica-v3' or
         (name isnt STATIC_CACHE and name.startsWith('musica-static-')) or
         (name isnt DYNAMIC_CACHE and name.startsWith('musica-dynamic-'))

# Activation - clean up old caches
self.addEventListener 'activate', (event) ->
  console.log 'SW: Activation started'
  event.waitUntil(
    caches.keys().then (keys) ->
      Promise.all(
        keys.filter(isOldCache)
          .map (k) ->
            console.log 'SW: Deleting old cache', k
            caches.delete k
      )
    .then ->
      console.log 'SW: Activation complete'
      self.clients.claim()
  )

# Local First strategy
self.addEventListener 'fetch', (event) ->
  { request } = event
  url = new URL request.url

  # Partage Android : le manifest déclare un share_target POST multipart vers
  # ./share. La requête est traitée ici, les fichiers écrits dans IndexedDB,
  # puis une redirection 303 ramène l'application sur ./?shared=<jeton>.
  if request.method is 'POST' and isShareRequest url
    event.respondWith handleShare request
    return

  # Ignore requests with query params for static assets
  if url.search and isStaticAsset(url.pathname)
    # Create request without query params for cache
    cleanUrl = url.origin + url.pathname
    cleanRequest = new Request cleanUrl, request
    event.respondWith cacheFirst cleanRequest
    return

  # Different strategies based on resource type
  if isStaticAsset request.url
    # Cache first for static assets
    event.respondWith cacheFirst request
  else if isNavigationRequest request
    # Network first for navigation (to get latest versions)
    event.respondWith networkFirst request
  else
    # Stale while revalidate for dynamic resources
    event.respondWith staleWhileRevalidate request

# Partage : l'action déclarée dans le manifest, résolue dans la portée du SW
# (le slash initial peut être absent selon le déploiement).
isShareRequest = (url) ->
  try
    share = new URL './share', self.registration.scope
    url.origin is share.origin and url.pathname.replace(/\/+$/, '') is share.pathname.replace(/\/+$/, '')
  catch then false

# IndexedDB du module de stockage (src/storage.coffee) : même base, même magasin
# « files », même forme d'entrée {id, name, files:[{name, data}], addedAt}. Le
# service worker n'a pas accès aux globals de la page, on écrit donc ici la
# même structure afin que storage.getFile la relise sans adaptation.
SHARE_DB_NAME = 'musica'
SHARE_DB_VERSION = 1

generateShareId = ->
  Date.now().toString(36) + Math.random().toString(36).substr(2, 5)

writeShareEntry = (name, files) ->
  new Promise (resolve, reject) ->
    req = indexedDB.open SHARE_DB_NAME, SHARE_DB_VERSION
    req.onupgradeneeded = (e) ->
      d = e.target.result
      unless d.objectStoreNames.contains 'files'
        d.createObjectStore 'files', { keyPath: 'id' }
      unless d.objectStoreNames.contains 'positions'
        d.createObjectStore 'positions', { keyPath: 'fileId' }
    req.onerror = -> reject req.error
    req.onsuccess = ->
      d = req.result
      id = generateShareId()
      tx = d.transaction 'files', 'readwrite'
      tx.objectStore('files').put { id, name, files, addedAt: Date.now() }
      tx.oncomplete = ->
        d.close()
        resolve id
      tx.onerror = -> reject tx.error

# Nom du fichier : Chrome transmet normalement File.name ; si le nom est perdu
# (« blob »), on se rabat sur le titre du partage puis sur un nom générique.
shareFileName = (file, fallback) ->
  name = file?.name
  unless name and name isnt 'blob'
    name = fallback or "partage-#{Date.now()}"
    ext = MIME_EXTENSIONS[file?.type]
    name += ext if ext and not /\.\w+$/.test name
  name.replace /[\/\\]/g, '_'

baseShareName = (name) -> name.replace SHARE_EXT_RE, ''

shareEntryName = (files, title) ->
  return baseShareName(files[0].name) if files.length is 1
  return title if title
  prefix = baseShareName files[0].name
  for f in files[1..]
    other = baseShareName f.name
    i = 0
    i++ while i < prefix.length and i < other.length and prefix[i] is other[i]
    prefix = prefix[0...i]
  prefix = prefix.replace /[\s\-_.]+$/, ''
  prefix or 'Partage'

htmlResponse = (status, message) ->
  escaped = String(message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  body = "<!doctype html><meta charset=\"utf-8\"><title>Sharing failed</title>" +
    "<h1>Sharing failed</h1><p>#{escaped}</p><p>Go back to Cantus and use “Open a file”.</p>"
  new Response body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }

# Réception d'un partage : accepte tous les fichiers (l'application décide
# ensuite, via isCompatibleFile / la conversion), les stocke, puis redirige.
handleShare = (request) ->
  try
    form = await request.formData()
    candidates = form.getAll('file').concat form.getAll('files')
    blobs = (item for item in candidates when item and item.arrayBuffer and item.size > 0)
    unless blobs.length
      return htmlResponse 400, "No file was received."

    title = String(form.get('title') or form.get('text') or '').trim()
    files = []
    for blob in blobs
      name = shareFileName blob, (title if blobs.length is 1)
      data = await blob.arrayBuffer()
      files.push { name, data }

    entryName = shareEntryName files, title
    id = await writeShareEntry entryName, files
    console.log "SW: partage stocké '#{entryName}' (#{files.length} fichier(s), id: #{id})"
    # 303 : le navigateur repasse en GET sur l'application ; le jeton est
    # consommé puis retiré de l'URL par `src/app/integration.coffee`.
    new Response null, { status: 303, headers: { Location: "./?shared=#{encodeURIComponent id}" } }
  catch err
    console.error 'SW: échec du partage', err
    htmlResponse 500, "The shared file could not be saved: #{err?.message or err}"

# Check if it's a static asset (pathname only)
isStaticAsset = (urlOrPath) ->
  path = if urlOrPath.startsWith('/') then urlOrPath else new URL(urlOrPath, 'http://x').pathname
  STATIC_ASSETS.some((asset) -> path is asset or path is asset + '/') or
         path.includes('/verovio') or
         path.includes('/scoretk/') or
         path.includes('/icons/') or
         path.endsWith('.js') or
         path.endsWith('.css') or
         path.endsWith('.wasm') or
         path.endsWith('.sf3') or
         path.endsWith('.png') or
         path.endsWith('.ico') or
         path.endsWith('.svg')

# Check if it's a navigation request
isNavigationRequest = (request) ->
  request.mode is 'navigate' or
         (request.method is 'GET' and (request.headers.get('accept') or '').includes('text/html'))

# Cache First : sert le cache, sinon le réseau
cacheFirst = (request) ->
  cache = await caches.open STATIC_CACHE
  cached = await cache.match request
  if cached
    return cached

  response = await fetch request
  if response.ok
    await cache.put request, response.clone()
  response

# Network First for navigation
networkFirst = (request) ->
  cache = await caches.open DYNAMIC_CACHE

  try
    response = await fetch request
    if response.ok
      responseClone = response.clone()
      await cache.put request, responseClone
    return response
  catch error
    # networkFirst ne sert que la navigation : en dernier recours, la page
    # d'accueil précachée dans STATIC_CACHE permet le premier lancement hors ligne.
    cached = (await caches.match request) or (await caches.match './index.html')
    return cached if cached
    throw error

# Stale While Revalidate for dynamic resources
staleWhileRevalidate = (request) ->
  cache = await caches.open DYNAMIC_CACHE
  cached = await cache.match request

  # Always try to update
  fetchPromise = fetch(request).then (response) ->
    if response.ok
      responseClone = response.clone()
      await cache.put request, responseClone
    return response
  .catch (error) ->
    console.error 'SW: Background update failed', request.url, error

  # Return cache if available, otherwise wait for network
  return cached or fetchPromise

# Listen for messages from clients
self.addEventListener 'message', (event) ->
  { type } = event.data

  switch type
    when 'SKIP_WAITING'
      self.skipWaiting()

    when 'GET_VERSION'
      event.ports[0].postMessage {
        version: VERSION
        timestamp: Date.now()
      }
