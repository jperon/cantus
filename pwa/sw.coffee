# Service Worker for Cantus PWA
# Progressive Web App with offline support and intelligent caching

CACHE_NAME = 'musica-v3'
STATIC_CACHE = 'musica-static-v3'
DYNAMIC_CACHE = 'musica-dynamic-v3'

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
self.addEventListener 'install', (event) ->
  console.log 'SW: Installation started'
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then (cache) ->
        console.log 'SW: Caching static assets'
        cache.addAll STATIC_ASSETS
      .then ->
        console.log 'SW: Static assets cached successfully'
        self.skipWaiting()
      .catch (err) ->
        console.error 'SW: Install failed', err
        Promise.resolve()
  )

# Activation - clean up old caches
self.addEventListener 'activate', (event) ->
  console.log 'SW: Activation started'
  event.waitUntil(
    caches.keys().then (keys) ->
      Promise.all(
        keys.filter((k) -> k isnt STATIC_CACHE and k isnt DYNAMIC_CACHE)
          .map (k) ->
            console.log 'SW: Deleting old cache', k
            caches.delete k
      )
    .then ->
      console.log 'SW: Activation complete'
      self.clients.claim()
  )

# Local First strategy with background updates
self.addEventListener 'fetch', (event) ->
  { request } = event
  url = new URL request.url

  # Ignore requests with query params for static assets
  if url.search and isStaticAsset(url.pathname)
    # Create request without query params for cache
    cleanUrl = url.origin + url.pathname
    cleanRequest = new Request cleanUrl, request
    event.respondWith cacheFirstWithBackgroundUpdate cleanRequest
    return

  # Different strategies based on resource type
  if isStaticAsset request.url
    # Cache first with background update for static assets
    event.respondWith cacheFirstWithBackgroundUpdate request
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
         (request.method is 'GET' and request.headers.get('accept').includes('text/html'))

# Cache First with background update
cacheFirstWithBackgroundUpdate = (request) ->
  cache = await caches.open STATIC_CACHE
  cached = await cache.match request

  if cached
    # Serve from cache immediately
    console.log 'SW: Serving from cache', request.url

    # Update in background
    fetchAndUpdateCache request, cache

    return cached

  # If not in cache, fetch from network
  console.log 'SW: Not in cache, fetching from network', request.url
  try
    response = await fetch request
    if response.ok
      responseClone = response.clone()
      await cache.put request, responseClone
    return response
  catch error
    console.error 'SW: Network failed', request.url, error
    throw error

# Network First for navigation
networkFirst = (request) ->
  cache = await caches.open DYNAMIC_CACHE

  try
    console.log 'SW: Trying network first', request.url
    response = await fetch request

    if response.ok
      responseClone = response.clone()
      await cache.put request, responseClone
      console.log 'SW: Network success, cached', request.url

    return response
  catch error
    console.log 'SW: Network failed, trying cache', request.url
    cached = await cache.match request
    if cached
      return cached
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
      console.log 'SW: Updated in cache', request.url
    return response
  .catch (error) ->
    console.error 'SW: Background update failed', request.url, error

  # Return cache if available, otherwise wait for network
  if cached
    console.log 'SW: Serving stale, updating in background', request.url
    return cached

  console.log 'SW: Not in cache, waiting for network', request.url
  return fetchPromise

# Update cache in background
fetchAndUpdateCache = (request, cache) ->
  try
    response = await fetch request
    if response.ok
      await cache.put request, response
      console.log 'SW: Background update successful', request.url

      # Notify clients if it's an important update
      if shouldNotifyUpdate request.url
        notifyClients 'update', {
          url: request.url
          message: 'Mise à jour disponible'
        }
  catch error
    console.error 'SW: Background update failed', request.url, error

# Determine if we should notify the client
shouldNotifyUpdate = (url) ->
  # Notify for main files
  url.includes('/index.html') or
         url.includes('/worker.js') or
         url.includes('/app.js')

# Notify all clients
notifyClients = (type, data) ->
  self.clients.matchAll().then (clients) ->
    clients.forEach (client) ->
      client.postMessage {
        type: type
        data: data
        timestamp: Date.now()
      }

# Listen for messages from clients
self.addEventListener 'message', (event) ->
  { type, data } = event.data

  switch type
    when 'SKIP_WAITING'
      self.skipWaiting()

    when 'GET_VERSION'
      event.ports[0].postMessage {
        version: CACHE_NAME
        timestamp: Date.now()
      }

    when 'FORCE_UPDATE'
      # Force update of static assets
      caches.open(STATIC_CACHE).then (cache) ->
        STATIC_ASSETS.forEach (asset) ->
          fetchAndUpdateCache new Request(asset), cache
