# Requêtes de pages SVG au worker (avec caches) et données de lecture
# (MIDI, marqueurs de synchronisation, pauses).
getGlobalPage = (movementId, localPage) ->
  offset = 0
  for m in movements when m.id < movementId
    offset += m.pageCount or 0
  offset + localPage

# Request SVG from worker, returns Promise
# Checks caches first
requestPage = (movementId, localPage) ->
  # Mouvement grégorien : les SVG sont déjà en mémoire sur le mouvement, sans
  # svgStore ni worker.
  gregorien = movements.find (m) -> m.id is movementId
  if gregorien?.gregorien
    return Promise.resolve (gregorien.gregorienSvgs?[localPage - 1] ? "")
  globalPage = getGlobalPage(movementId, localPage)
  syncMemoryVariant()

  # Check memory cache first
  if memoryCache.has(globalPage)
    return Promise.resolve(memoryCache.get(globalPage))

  # Reuse the pending promise to avoid duplicate work
  pendingKey = "page:#{globalPage}"
  return pendingRequests.get(pendingKey) if pendingRequests.has(pendingKey)

  # La page sera rendue à partir du XML chargé pour ce mouvement : sa clé de
  # cache est la variante de ce XML, pas les réglages courants. La mise en page
  # (un système par page ou naturelle) en fait partie : elle change la
  # pagination à dimensions et voix égales.
  variant = loadedVariant movementId
  promise = svgStore.get(currentFileId, globalPage, currentPageWidth, currentPageHeight, layoutLabel(), variant).then (svg) ->
    if svg
      memoryCache.set(globalPage, svg)
      return svg
    # The worker may have pushed this page while the lookup was in flight
    return memoryCache.get(globalPage) if memoryCache.has(globalPage)
    requestFromWorker(movementId, localPage)
  pendingRequests.set pendingKey, promise
  promise.then -> pendingRequests.delete pendingKey
  promise

# Actually request from worker
requestFromWorker = (movementId, localPage) ->
  new Promise (resolve) ->
    key = "#{movementId}:#{localPage}"
    pendingRenders.set key, resolve
    # The pages pushed at load arrive in order: wait for the one we are missing
    # instead of asking for a second render. Any other page is rendered here.
    mv = movements.find (m) -> m.id is movementId
    if localPage <= (mv?.pushed or 0) and localPage > (pushedPages[movementId] or 0)
      return
    worker.postMessage
      type: "renderMovementPage"
      movementId: movementId
      page: localPage

# Clé du cache de lecture : une sélection de voix différente (masquage ou
# taille) produit un autre rendu Verovio, donc d'autres données de lecture.
# Les données sont calculées à partir du XML chargé dans le worker : c'est sa
# variante qui compte, pas l'état courant des réglages. Le mode et les bornes
# du mouvement en font partie : les données des deux modes ne se mélangent pas.
playbackKey = (movementId, linear = not expandRepeats) ->
  movement = movements.find (m) -> m.id is movementId
  mode = if linear then "linear" else "expanded"
  bounds = "#{movement?.measureStart ? 0}:#{movement?.measureEnd ? ''}"
  "#{movementId}:#{loadedVariant movementId}:#{mode}:#{bounds}"

# Demande les données de lecture (MIDI, synchronisation) : cache mémoire,
# cache persistant (compressé, clé géométrique) puis worker. La clé persistante
# inclut fichier, mouvement, dimensions, échelle et variante de voix, donc un
# zoom, une rotation ou un masquage ne réutilise jamais des marqueurs périmés.
requestPlaybackData = (movementId, linear = not expandRepeats) ->
  key = playbackKey movementId, linear
  return Promise.resolve(playbackCache.get key) if playbackCache.has key
  return pendingPlayback.get(key).promise if pendingPlayback.has key
  # Jeton du chargement au moment de la demande : si un rechargement survient
  # pendant la lecture du cache persistant, le mouvement peut ne plus exister
  # côté worker. Ne pas lui envoyer la demande (il répondrait par une erreur
  # visible alors que le nouveau chargement est en cours).
  requestToken = loadToken
  fileId = currentFileId
  width = currentPageWidth
  height = currentPageHeight
  scale = currentScale
  movement = movements.find (m) -> m.id is movementId
  measureStart = movement?.measureStart ? 0
  measureEnd = movement?.measureEnd ? null
  # Le mode de reprise et les bornes font partie de la clé persistante : les
  # données des deux modes ne se servent jamais l'une pour l'autre. La mise en
  # page aussi : les numéros de page des marqueurs diffèrent entre un système
  # par page (horizontal) et la mise en page naturelle.
  variant = "#{loadedVariant movementId}|#{layoutLabel()}|#{if linear then 'linear' else 'expanded'}|#{measureStart}:#{measureEnd ? ''}"
  promise = new Promise (resolve, reject) ->
    pendingPlayback.set key, {resolve, reject}
    cached = if playbackStore?.get? and fileId
      playbackStore.get(fileId, movementId, width, height, scale, variant).catch ->
        null
    else
      Promise.resolve null
    cached.then (data) ->
      # Contrôle du jeton en premier : un chargement a pu remplacer la demande
      # pendant la lecture du cache persistant. Ne pas toucher à
      # pendingPlayback ni à playbackCache : le nouveau chargement a pu y
      # inscrire une demande sous la même clé, qu'il ne faut pas écraser.
      # Seule cette promesse est rejetée.
      return reject new Error "Chargement remplacé" if loadToken isnt requestToken
      if data and playbackCache.has(key)
        # Une autre demande a déjà rempli le cache mémoire entre-temps
        pendingPlayback.delete key
        resolve playbackCache.get key
      else if data
        pendingPlayback.delete key
        playbackCache.set key, data
        resolve data
      else
        worker.postMessage
          type: "getPlaybackData"
          movementId: movementId
          linearRepeats: linear
          measureStart: measureStart
          measureEnd: measureEnd
          # Jeton du chargement : une réponse calculée avant un rechargement
          # (pagination différente) est ignorée par la page, même si elle
          # arrive après que le nouveau mouvement a été installé.
          loadToken: requestToken
  # Écrire le résultat dans le cache persistant, sans retarder la lecture
  promise.then (data) ->
    if data and playbackStore?.set? and fileId
      playbackStore.set(fileId, movementId, data, width, height, scale, variant).catch (err) ->
        console.warn "Cache de lecture non enregistré : #{err?.message or err}"
  .catch ->
    # L'échec est traité par startPlayback ; cette branche ne doit pas créer
    # de rejet non géré.
    null
  # Conserver la promesse pour dédupliquer une seconde demande identique
  pendingPlayback.get(key)?.promise = promise
  promise

# Longueur estimée du base64 décodé (sans dépendance)
base64Bytes = (b64) ->
  return 0 unless b64
  padding = 0
  padding += 1 if b64.endsWith "="
  padding += 1 if b64.endsWith "=="
  Math.floor(b64.length * 3 / 4) - padding

# Sonde de debug pour les tests : données de lecture du mouvement affiché.
window.__musicaPlaybackProbe = ->
  result = getMovementForPage displayedPage()
  unless result
    return {
      hasData: false
      syncMarksCount: 0
      firstMarks: []
      marks: []
      duration: 0
      segmentsCount: 0
      linearRepeats: false
      staffLabels: []
      trackMap: {}
      midiBytes: 0
      error: "aucun mouvement affiché"
    }
  requestPlaybackData result.movement.id
    .then (data) ->
      {
        hasData: true
        movementId: result.movement.id
        syncMarksCount: data.syncMarks?.length ? 0
        firstMarks: (data.syncMarks ? []).slice 0, 5
        marks: data.syncMarks ? []
        duration: data.duration ? 0
        segmentsCount: data.segments?.length ? 0
        linearRepeats: !!data.linearRepeats
        staffLabels: data.staffLabels ? []
        trackMap: data.trackMap ? {}
        midiBytes: base64Bytes data.midi
      }
    .catch (err) ->
      {
        hasData: false
        movementId: result.movement.id
        syncMarksCount: 0
        firstMarks: []
        marks: []
        duration: 0
        segmentsCount: 0
        linearRepeats: false
        staffLabels: []
        trackMap: {}
        midiBytes: 0
        error: err?.message or String(err)
      }

