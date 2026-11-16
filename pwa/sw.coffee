# Service Worker for Cantus PWA
# Progressive Web App with offline support and intelligent caching

VERSION = 'dev'
STATIC_CACHE = "musica-static-#{VERSION}"
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

# Installation - cache static assets
# Le nouveau SW reste en attente : app.coffee propose la mise à jour,
# puis envoie SKIP_WAITING quand l'utilisateur l'accepte.
self.addEventListener 'install', (event) ->
  console.log 'SW: Installation started'
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then (cache) ->
        console.log 'SW: Caching static assets'
        cache.addAll STATIC_ASSETS.map((u) -> new Request(u, cache: 'reload'))
  )

# Un cache est ancien s'il appartient à ce service worker mais pas à cette
# version. Les caches de rendus (musica-svg-cache-v1, musica-structure-cache-v1)
# contiennent les documents de l'utilisateur et sont préservés.
isOldCache = (name) ->
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

# Check if it's a static asset (pathname only)
isStaticAsset = (urlOrPath) ->
  path = if urlOrPath.startsWith('/') then urlOrPath else new URL(urlOrPath, 'http://x').pathname
  STATIC_ASSETS.some((asset) -> path is asset or path is asset + '/') or
         path.includes('/verovio') or
         path.includes('/icons/') or
         path.endsWith('.js') or
         path.endsWith('.css') or
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
