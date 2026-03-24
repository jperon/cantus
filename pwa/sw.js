const CACHE_NAME = 'musica-v3';
const STATIC_CACHE = 'musica-static-v3';
const DYNAMIC_CACHE = 'musica-dynamic-v3';

// Assets essentiels pour le fonctionnement offline
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/worker.js',
  '/manifest.json',
  '/favicon.ico',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/verovio.js',
  '/verovio-toolkit-wasm.js'
];

// Installation - mise en cache des assets statiques
self.addEventListener('install', (event) => {
  console.log('SW: Installation started');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        console.log('SW: Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('SW: Static assets cached successfully');
        return self.skipWaiting();
      })
      .catch((err) => {
        console.error('SW: Install failed', err);
        return Promise.resolve();
      })
  );
});

// Activation - nettoyage des anciens caches
self.addEventListener('activate', (event) => {
  console.log('SW: Activation started');
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== STATIC_CACHE && k !== DYNAMIC_CACHE)
          .map((k) => {
            console.log('SW: Deleting old cache', k);
            return caches.delete(k);
          })
      );
    }).then(() => {
      console.log('SW: Activation complete');
      return self.clients.claim();
    })
  );
});

// Stratégie "Local First" avec mise à jour en arrière-plan
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Ignorer les requêtes avec query params pour les assets statiques
  if (url.search && isStaticAsset(url.pathname)) {
    // Créer une requête sans query params pour le cache
    const cleanUrl = url.origin + url.pathname;
    const cleanRequest = new Request(cleanUrl, request);
    event.respondWith(cacheFirstWithBackgroundUpdate(cleanRequest));
    return;
  }

  // Stratégie différente selon le type de ressource
  if (isStaticAsset(request.url)) {
    // Cache first avec mise à jour en arrière-plan pour les assets statiques
    event.respondWith(cacheFirstWithBackgroundUpdate(request));
  } else if (isNavigationRequest(request)) {
    // Network first pour les navigations (pour avoir les dernières versions)
    event.respondWith(networkFirst(request));
  } else {
    // Stale while revalidate pour les ressources dynamiques
    event.respondWith(staleWhileRevalidate(request));
  }
});

// Vérifier si c'est un asset statique (sur le pathname uniquement)
function isStaticAsset(urlOrPath) {
  const path = urlOrPath.startsWith('/') ? urlOrPath : new URL(urlOrPath, 'http://x').pathname;
  return STATIC_ASSETS.some(asset => path === asset || path === asset + '/') ||
         path.includes('/verovio') ||
         path.includes('/icons/') ||
         path.endsWith('.js') ||
         path.endsWith('.css') ||
         path.endsWith('.png') ||
         path.endsWith('.ico') ||
         path.endsWith('.svg');
}

// Vérifier si c'est une requête de navigation
function isNavigationRequest(request) {
  return request.mode === 'navigate' ||
         (request.method === 'GET' && request.headers.get('accept').includes('text/html'));
}

// Cache First avec mise à jour en arrière-plan
async function cacheFirstWithBackgroundUpdate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    // Servir depuis le cache immédiatement
    console.log('SW: Serving from cache', request.url);

    // Mettre à jour en arrière-plan
    fetchAndUpdateCache(request, cache);

    return cached;
  }

  // Si pas dans le cache, aller sur le réseau
  console.log('SW: Not in cache, fetching from network', request.url);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const responseClone = response.clone();
      await cache.put(request, responseClone);
    }
    return response;
  } catch (error) {
    console.error('SW: Network failed', request.url, error);
    throw error;
  }
}

// Network First pour les navigations
async function networkFirst(request) {
  const cache = await caches.open(DYNAMIC_CACHE);

  try {
    console.log('SW: Trying network first', request.url);
    const response = await fetch(request);

    if (response.ok) {
      const responseClone = response.clone();
      await cache.put(request, responseClone);
      console.log('SW: Network success, cached', request.url);
    }

    return response;
  } catch (error) {
    console.log('SW: Network failed, trying cache', request.url);
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

// Stale While Revalidate pour les ressources dynamiques
async function staleWhileRevalidate(request) {
  const cache = await caches.open(DYNAMIC_CACHE);
  const cached = await cache.match(request);

  // Toujours essayer de mettre à jour
  const fetchPromise = fetch(request).then(async (response) => {
    if (response.ok) {
      const responseClone = response.clone();
      await cache.put(request, responseClone);
      console.log('SW: Updated in cache', request.url);
    }
    return response;
  }).catch((error) => {
    console.error('SW: Background update failed', request.url, error);
  });

  // Retourner le cache si disponible, sinon attendre le réseau
  if (cached) {
    console.log('SW: Serving stale, updating in background', request.url);
    return cached;
  }

  console.log('SW: Not in cache, waiting for network', request.url);
  return fetchPromise;
}

// Mettre à jour le cache en arrière-plan
async function fetchAndUpdateCache(request, cache) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      await cache.put(request, response);
      console.log('SW: Background update successful', request.url);

      // Notifier les clients si c'est une mise à jour importante
      if (shouldNotifyUpdate(request.url)) {
        notifyClients('update', {
          url: request.url,
          message: 'Mise à jour disponible'
        });
      }
    }
  } catch (error) {
    console.error('SW: Background update failed', request.url, error);
  }
}

// Déterminer si on doit notifier le client
function shouldNotifyUpdate(url) {
  // Notifier pour les fichiers principaux
  return url.includes('/index.html') ||
         url.includes('/worker.js') ||
         url.includes('/app.js');
}

// Notifier tous les clients
function notifyClients(type, data) {
  self.clients.matchAll().then(clients => {
    clients.forEach(client => {
      client.postMessage({
        type: type,
        data: data,
        timestamp: Date.now()
      });
    });
  });
}

// Écouter les messages des clients
self.addEventListener('message', (event) => {
  const { type, data } = event.data;

  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      break;

    case 'GET_VERSION':
      event.ports[0].postMessage({
        version: CACHE_NAME,
        timestamp: Date.now()
      });
      break;

    case 'FORCE_UPDATE':
      // Forcer la mise à jour des assets statiques
      caches.open(STATIC_CACHE).then(cache => {
        STATIC_ASSETS.forEach(asset => {
          fetchAndUpdateCache(new Request(asset), cache);
        });
      });
      break;
  }
});
