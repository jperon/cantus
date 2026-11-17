# Web Worker — Verovio rendering with movement support
# Supports multiple movements loaded sequentially

tk = null
verovioLoaded = false
movements = {}  # movementId -> {pageCount, loaded, xml, options}
currentMovement = null
pending = []  # messages waiting for the toolkit, replayed once Verovio is ready
msczLoad = null  # mscz2xml loading promise, created on first MuseScore conversion
msczInline = null  # SPA: {wasmJs, js, wasm} sources sent by the page
playbackCache = {}  # movementId -> playbackData, invalidated on each loadData

# Clear all movements (call before loading new file)
clearMovements = ->
  movements = {}
  currentMovement = null
  playbackCache = {}

# Les données de lecture sont mises en cache par mouvement ET par mode
# (déroulé / linéaire) : invalider un mouvement doit oublier ses deux entrées.
invalidatePlaybackCache = (movementId) ->
  prefix = "#{movementId}:"
  for own key of playbackCache
    delete playbackCache[key] if key.startsWith prefix

# Load Verovio dynamically and initialize
loadVerovio = (url) ->
  new Promise (resolve, reject) ->
    try
      # Check if Verovio is already loaded in this worker scope
      if verovioLoaded and tk
        console.log "Worker: Verovio already loaded and initialized"
        resolve()
        return

      # Check if it's a blob URL - use fetch+eval instead of importScripts
      if url.startsWith('blob:')
        fetch(url)
          .then (response) -> response.text()
          .then (code) ->
            eval(code)
            verovioLoaded = true
            initVerovio(resolve, reject)
          .catch reject
        return

      # For regular URLs, try to get from cache first (local-first)
      if not verovioLoaded
        console.log "Worker: Loading Verovio from cache/network: #{url}"

        # Try importScripts (will use cache if available via SW)
        try
          importScripts(url)
          verovioLoaded = true
          console.log "Worker: Verovio loaded via importScripts"
        catch importError
          console.error "Worker: importScripts failed, trying fetch:", importError

          # Fallback to fetch+eval
          fetch(url)
            .then (response) ->
              if response.ok
                response.text().then (code) ->
                  eval(code)
                  verovioLoaded = true
                  console.log "Worker: Verovio loaded via fetch+eval"
                  initVerovio(resolve, reject)
              else
                throw new Error "Failed to fetch Verovio: #{response.status}"
            .catch (fetchError) ->
              console.error "Worker: fetch also failed:", fetchError
              reject fetchError
          return

      initVerovio(resolve, reject)
    catch err
      console.error "Worker: Error in loadVerovio:", err
      reject(err)

# Initialize Verovio after loading
initVerovio = (resolve, reject) ->
  mod = verovio.module

  verovioReady = new Promise (resolveInit) ->
    if mod.calledRun
      resolveInit()
    else
      prevCallback = mod.onRuntimeInitialized
      mod.onRuntimeInitialized = ->
        prevCallback?()
        resolveInit()

  verovioReady.then ->
    tk = new verovio.toolkit()
    resolve()
  .catch (err) ->
    reject(err)

# Load the MuseScore converter once: the package in the normal build, the
# inlined wasm module in the SPA. Both resolve an object with convert(bytes).
loadMscz2xml = ->
  return msczLoad if msczLoad
  msczLoad = new Promise (resolve, reject) ->
    try
      if msczInline
        # SPA : évaluer wasm-bindgen (portée globale) puis lui donner le .wasm inliné
        self.eval msczInline.wasmJs + '\nself.wasm_bindgen = wasm_bindgen;'
        bytes = Uint8Array.from atob(msczInline.wasm), (c) -> c.charCodeAt 0
        self.wasm_bindgen { module_or_path: bytes }
          .then -> resolve self.wasm_bindgen
          .catch reject
      else
        self.MSCZ2XML_BASE_URL = new URL('mscz2xml/', self.location.href).href
        importScripts 'mscz2xml/mscz2xml.js'
        self.mscz2xml.ready.then -> resolve self.mscz2xml
    catch err
      reject err
  msczLoad

# Render one page of the currently loaded movement and send it back
postPage = (movementId, pageNumber) ->
  self.postMessage {
    type: "svg"
    movementId
    page: pageNumber
    svg: tk.renderToSVG pageNumber
  }

loadMovement = (movementId, xmlString, pageWidth, pageHeight, scale = 40) ->
  options = {
    breaks: "auto"
    adjustPageHeight: true
    pageWidth: pageWidth
    pageHeight: pageHeight
    scale: scale
    condense: "none"
    header: "none"
    footer: "none"
  }
  tk.setOptions options
  loaded = tk.loadData xmlString
  unless loaded
    self.postMessage {
      type: "error"
      movementId
      message: "Failed to load movement data"
    }
    return
  pageCount = tk.getPageCount()
  movements[movementId] = {
    pageCount
    loaded: true
    xml: xmlString
    options
  }
  # Les données de lecture dépendent du contenu chargé : recharger invalide
  invalidatePlaybackCache movementId
  currentMovement = movementId
  # Only the first pages are pushed now; the rest are rendered on demand
  # (renderMovementPage), so a big file is not rendered and cached entirely
  pushed = Math.min pageCount, 2
  self.postMessage {
    type: "movementLoaded"
    movementId
    pageCount
    pushed
  }
  if pushed > 0
    postPage movementId, page for page in [1..pushed]

# Switch to a different movement if needed
switchToMovement = (movementId) ->
  return true if currentMovement is movementId
  mv = movements[movementId]
  unless mv?.loaded
    return false
  # Reload the movement data only if movement changed
  tk.setOptions mv.options
  loaded = tk.loadData mv.xml
  unless loaded
    return false
  currentMovement = movementId
  # loadData remplace les données du toolkit : le cache de lecture est périmé
  invalidatePlaybackCache movementId
  true

# --- Données de lecture (MIDI + synchronisation) -----------------------------

# Décode une chaîne base64 en octets, sans dépendance (atob existe en Worker)
decodeBase64 = (b64) ->
  binary = atob b64
  bytes = new Uint8Array binary.length
  bytes[i] = binary.charCodeAt i for i in [0...binary.length]
  bytes

readU16 = (bytes, offset) ->
  (bytes[offset] << 8) | bytes[offset + 1]

readU32 = (bytes, offset) ->
  ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]

# Lecture d'un entier à longueur variable (VLQ) du standard MIDI
readVlq = (bytes, offset) ->
  value = 0
  loop
    byte = bytes[offset] ? 0
    offset += 1
    value = (value << 7) | (byte & 0x7F)
    break unless byte & 0x80
  [value, offset]

# Cherche l'événement méta « Track Name » (FF 03) d'une piste SMF
findTrackName = (bytes, start, end) ->
  pos = start
  running = 0
  decoder = new TextDecoder()
  while pos < end
    res = readVlq bytes, pos
    pos = res[1]
    break if pos >= end
    status = bytes[pos]
    if status is 0xFF
      break if pos + 1 >= end
      metaType = bytes[pos + 1]
      res = readVlq bytes, pos + 2
      length = res[0]
      pos = res[1]
      if metaType is 0x03 and length > 0
        return decoder.decode bytes.subarray(pos, pos + length)
      break if metaType is 0x2F  # End of Track
      pos += length
    else if status is 0xF0 or status is 0xF7
      res = readVlq bytes, pos + 1
      length = res[0]
      pos = res[1] + length
    else
      if status < 0x80
        # Running status : on réutilise l'octet d'état courant
      else
        running = status
        pos += 1
      high = running & 0xF0
      if high is 0xC0 or high is 0xD0
        pos += 1
      else if high is 0x80 or high is 0x90 or high is 0xA0 or high is 0xB0 or high is 0xE0
        pos += 2
      else
        break
  null

# Liste les pistes d'un SMF : {index, name}. Le nom vient de FF 03 ; il peut
# être absent (certains fichiers MusicXML sans libellé de partie).
parseMidiTracks = (midiBase64) ->
  return [] unless midiBase64
  try
    bytes = decodeBase64 midiBase64
  catch err
    return []
  return [] if bytes.length < 14
  magic = String.fromCharCode bytes[0], bytes[1], bytes[2], bytes[3]
  return [] unless magic is "MThd"
  headerLength = readU32 bytes, 4
  trackCount = readU16 bytes, 10
  offset = 8 + headerLength
  tracks = []
  index = 0
  while index < trackCount and offset + 8 <= bytes.length
    chunkMagic = String.fromCharCode bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]
    chunkLength = readU32 bytes, offset + 4
    start = offset + 8
    end = Math.min start + chunkLength, bytes.length
    name = if chunkMagic is "MTrk" then findTrackName(bytes, start, end) else null
    tracks.push {index, name}
    offset = start + chunkLength
    index += 1
  tracks

# Décode les entités XML utiles aux libellés (part-name, part-abbreviation)
decodeXmlText = (text) ->
  text.replace /&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity) ->
    switch entity
      when "amp" then "&"
      when "lt" then "<"
      when "gt" then ">"
      when "quot" then "\""
      when "apos" then "'"
      else
        if entity.charAt(0) is "#"
          code = if entity.charAt(1).toLowerCase() is "x"
            parseInt entity.slice(2), 16
          else
            parseInt entity.slice(1), 10
          return String.fromCodePoint code if isFinite code
        match

# Texte du premier élément <tag> d'un fragment XML (DOMParser n'existe pas en
# Web Worker : lecture ciblée par expressions régulières)
xmlTagText = (xml, tag) ->
  pattern = new RegExp "<#{tag}(?:\\s[^>]*)?>([\\s\\S]*?)</#{tag}>", "i"
  match = xml.match pattern
  return null unless match
  decodeXmlText match[1].replace(/<[^>]*>/g, "").trim()

# Libellés de voix et nombre de portées, avec exactement la logique de
# partLabels() / applyPartSizes() côté page. Le XML du mouvement est conservé
# dans movements[id].xml, mais DOMParser n'est pas disponible en Web Worker :
# on extrait uniquement score-part, part-name, part-abbreviation et staves.
readPartInfo = (xmlString) ->
  parts = []
  labels = {}
  staves = {}
  used = new Set()
  return {parts, labels, staves} unless xmlString
  scorePartRe = /<score-part(?:\s[^>]*)?>([\s\S]*?)<\/score-part>/gi
  while match = scorePartRe.exec xmlString
    attrs = match[0].slice 0, match[0].indexOf ">"
    idMatch = attrs.match /\bid\s*=\s*"([^"]*)"/
    continue unless idMatch
    id = idMatch[1]
    name = xmlTagText match[1], "part-name"
    name = xmlTagText match[1], "part-abbreviation" unless name
    base = name or id
    label = base
    n = 1
    while used.has label
      n += 1
      label = "#{base} ##{n}"
    used.add label
    labels[id] = label
    parts.push {id, label}
  # Nombre de portées de chaque <part> (une partie piano en couvre plusieurs)
  partMatches = []
  partRe = /<part(?:\s[^>]*)?>/gi
  while match = partRe.exec xmlString
    partMatches.push {index: match.index, end: partRe.lastIndex, attrs: match[0]}
  for partMatch, index in partMatches
    idMatch = partMatch.attrs.match /\bid\s*=\s*"([^"]*)"/
    continue unless idMatch
    nextIndex = partMatches[index + 1]?.index ? xmlString.length
    body = xmlString.slice partMatch.end, nextIndex
    stavesMatch = body.match /<staves(?:\s[^>]*)?>([\s\S]*?)<\/staves>/i
    count = parseInt(stavesMatch?[1] ? "1")
    count = 1 unless count > 0
    staves[idMatch[1]] = count
  {parts, labels, staves}

# Mapping libellé -> indices de pistes MIDI. Les pistes de portée suivent
# l'ordre du document ; les noms FF 03 servent à confirmer/affiner, puis
# l'ordre du document remplit les portées restantes. Une partie à plusieurs
# portées (piano) donne le même libellé pour plusieurs pistes. La piste 0 du
# format 1, sans nom, est la piste de tempo : elle est exclue.
buildTrackMap = (midiBase64, staffLabels, staffSequence) ->
  trackMap = {}
  trackMap[label] = [] for label in staffLabels
  quota = {}
  quota[label] = (quota[label] or 0) + 1 for label in staffSequence
  tracks = parseMidiTracks midiBase64
  candidates = tracks
  if candidates.length > staffSequence.length and candidates.length > 0 and not candidates[0].name
    candidates = candidates.slice 1
  normalized = (value) -> (value or "").trim().toLowerCase()
  labelBase = (label) -> label.replace /\s+#\d+$/, ""
  used = {}
  # Première passe : appariement par trackName, dans l'ordre des libellés
  for track in candidates
    name = normalized track.name
    continue unless name
    for label in staffLabels
      continue if trackMap[label].length >= (quota[label] or 0)
      if name is normalized(label) or name is normalized(labelBase label)
        trackMap[label].push track.index
        used[track.index] = true
        break
  # Seconde passe : les portées restantes suivent l'ordre du document
  for label in staffSequence
    continue if trackMap[label].length >= (quota[label] or 0)
    track = candidates.find (candidate) -> not used[candidate.index]
    continue unless track
    trackMap[label].push track.index
    used[track.index] = true
  trackMap

# Durée totale d'un timemap : maximum de TOUS les tstamp, y compris les
# entrées dont les ids ne sont pas résolubles en page (copies de reprises
# « -rend2 »). Ces copies sont écartées des syncMarks, mais elles sont bien
# audibles : les ignorer tronquerait la lecture.
timemapDuration = (timemap) ->
  duration = 0
  for entry in timemap ? []
    t = Number entry.tstamp
    continue unless isFinite t
    duration = t if t > duration
  duration

buildSyncMarks = (timemap) ->
  pageCache = new Map()
  marks = []
  duration = timemapDuration timemap
  # Les copies de reprises « -rendN » n'existent dans aucun SVG. La carte
  # d'expansion de Verovio donne, pour chaque occurrence, l'id de base
  # (occurrences[0]) qui, lui, est présent dans le SVG. On ne construit la
  # table inverse qu'à la première occurrence non résoluble : les fichiers
  # sans reprise n'appellent jamais renderToExpansionMap.
  expansionBase = null
  baseId = (id) ->
    return null unless /-rend\d+$/.test id
    unless expansionBase?
      expansionBase = new Map()
      map = tk.renderToExpansionMap() or {}
      for source, occurrences of map
        continue unless Array.isArray(occurrences) and occurrences.length > 0
        base = occurrences[0]
        for occurrence in occurrences
          expansionBase.set occurrence, base unless expansionBase.has occurrence
    expansionBase.get(id) ? null
  # Construit les marqueurs de synchronisation depuis le timemap Verovio.
  for entry in timemap
    t = Number entry.tstamp
    t = 0 unless isFinite t
    ids = entry.on
    continue unless Array.isArray(ids) and ids.length > 0
    # Les ids simultanés partagent la même date : un seul marqueur suffit
    for id in ids
      page = pageCache.get id
      unless page?
        page = tk.getPageWithElement id
        pageCache.set id, page
      resolvedId = id
      unless page > 0
        base = baseId id
        if base and base isnt id
          resolvedId = base
          page = pageCache.get base
          unless page?
            page = tk.getPageWithElement base
            pageCache.set base, page
      if page > 0
        marks.push {t, page, id: resolvedId}
        break
  marks.sort (a, b) -> a.t - b.t
  # Dédupliquer les marqueurs consécutifs de même page et de même id
  syncMarks = []
  for mark in marks
    prev = syncMarks[syncMarks.length - 1]
    continue if prev and prev.page is mark.page and prev.id is mark.id
    syncMarks.push mark
  {syncMarks, duration}

# --- Lecture linéaire (dérouler les reprises décoché) ----------------------
#
# Le timemap demandé avec {includeMeasures: true} porte un champ `measureOn`
# sur l'entrée qui DÉBUTE chaque mesure, à son tstamp. Les passages suivants
# d'une mesure répétée reçoivent un suffixe « -rend2 », « -rend3 »… Ce sont les
# mêmes entrées que sans l'option, avec seulement ce champ en plus.

# Id de base d'une mesure ou d'un élément : « m12-rend3 » -> « m12 »
normalizeMeasureId = (id) ->
  String(id).replace /-rend\d+$/, ''

# Flux des mesures réellement jouées, dans l'ordre du timemap.
# Renvoie [{id, base, t, entry, timemapIndex, flowIndex}].
buildMeasureFlow = (timemap) ->
  flow = []
  for entry, timemapIndex in (timemap ? [])
    continue unless entry?.measureOn?
    t = Number entry.tstamp
    continue unless isFinite t
    id = String entry.measureOn
    flow.push {
      id
      base: normalizeMeasureId id
      t
      entry
      timemapIndex
      flowIndex: flow.length
    }
  flow

# Ordre écrit des mesures : celui du MEI. C'est la seule source qui contient
# aussi les mesures jamais jouées (volta sautée, D.S. qui repart en arrière).
# Les doublons éventuels sont écartés en conservant la première occurrence.
measureIdsFromMei = (mei) ->
  ids = []
  seen = new Set()
  pattern = /<measure\b[^>]*\b(?:xml:)?id="([^"]+)"/g
  text = mei ? ""
  while match = pattern.exec text
    id = normalizeMeasureId match[1]
    continue if seen.has id
    seen.add id
    ids.push id
  ids

# Segments de lecture linéaire : un segment par mesure ÉCRITE, dans l'ordre
# écrit, avec un offset cumulé. La durée d'une mesure est l'écart entre son
# occurrence retenue et l'entrée suivante du flux (ou la fin du timemap pour
# la dernière). Un segment ne se chevauche jamais avec le suivant.
#
# Une mesure écrite absente du flux n'a jamais été jouée : elle est signalée
# dans `missing` et simplement omise, sans décaler les autres. L'appelant
# journalise un avertissement explicite.
buildLinearSegments = (flow, totalDuration, writtenIds) ->
  byBase = new Map()
  for item in flow
    byBase.set item.base, item unless byBase.has item.base
  total = Number totalDuration
  total = 0 unless isFinite(total) and total >= 0
  segments = []
  entries = []
  missing = []
  offset = 0
  for id in writtenIds ? []
    item = byBase.get id
    unless item
      missing.push id
      continue
    next = flow[item.flowIndex + 1]
    to = if next? then next.t else total
    duration = to - item.t
    duration = 0 unless duration > 0
    to = item.t + duration
    segments.push {measureId: id, from: item.t, to, offset}
    entries.push {
      id
      from: item.t
      to
      offset
      occurrenceId: item.id
      entry: item.entry
      timemapIndex: item.timemapIndex
    }
    offset += duration
  {segments, entries, missing, duration: offset}

# Marqueurs de synchronisation du mode linéaire : un par mesure écrite, à
# l'offset cumulé. L'id choisi est le premier élément de l'occurrence retenue
# qui existe dans le SVG (les copies « -rendN » sont ramenées à l'id de base) ;
# à défaut, l'id de la mesure elle-même, qui est aussi un élément du SVG.
buildLinearSyncMarks = (timemap, entries) ->
  pageCache = new Map()
  pageOf = (id) ->
    return pageCache.get(id) if pageCache.has id
    page = tk.getPageWithElement id
    pageCache.set id, page
    page
  syncMarks = []
  for item in entries
    candidates = []
    addEntry = (entry) ->
      return unless entry?
      candidates.push id for id in (entry.on ? []) when id?
      candidates.push id for id in (entry.off ? []) when id?
    addEntry item.entry
    # Une mesure silencieuse peut n'avoir aucun on/off sur son entrée de
    # début : on cherche aussi les événements qui tombent dans son intervalle.
    index = item.timemapIndex + 1
    while index < timemap.length and (Number(timemap[index].tstamp) or 0) < item.to
      addEntry timemap[index]
      index += 1
    mark = null
    for raw in candidates
      candidate = String raw
      page = pageOf candidate
      resolved = candidate
      unless page > 0
        base = normalizeMeasureId candidate
        if base isnt candidate
          resolved = base
          page = pageOf base
      if page > 0
        mark = {t: item.offset, page, id: resolved}
        break
    unless mark
      base = normalizeMeasureId item.id
      page = pageOf base
      mark = {t: item.offset, page, id: base} if page > 0
    syncMarks.push mark if mark
  syncMarks.sort (a, b) -> a.t - b.t
  syncMarks

# Clé du cache de lecture : le mode (déroulé / linéaire) change le contenu.
playbackCacheKey = (movementId, linearRepeats) ->
  "#{movementId}:#{if linearRepeats then 'linear' else 'expanded'}"

# Données de lecture d'un mouvement déjà chargé (cache invalidé par loadData)
buildPlaybackData = (movementId, linearRepeats = false) ->
  cacheKey = playbackCacheKey movementId, linearRepeats
  cached = playbackCache[cacheKey]
  return cached if cached
  mv = movements[movementId]
  throw new Error "Mouvement #{movementId} non chargé" unless mv?.loaded
  unless switchToMovement movementId
    throw new Error "Impossible de charger le mouvement #{movementId}"
  midi = tk.renderToMIDI()
  unless midi
    throw new Error "Verovio n'a produit aucune donnée MIDI pour le mouvement #{movementId}"
  # Toujours demander les mesures : le coût est nul et `measureOn` ne gêne pas
  # le mode déroulé, qui ignore simplement ce champ.
  timemap = tk.renderToTimemap({includeMeasures: true})
  unless Array.isArray timemap
    throw new Error "Verovio n'a produit aucun timemap pour le mouvement #{movementId}"
  segments = []
  if linearRepeats
    flow = buildMeasureFlow timemap
    writtenIds = measureIdsFromMei tk.getMEI({})
    layout = buildLinearSegments flow, (timemapDuration timemap), writtenIds
    for missingId in layout.missing
      console.warn "Mesure écrite jamais jouée, ignorée en lecture linéaire : #{missingId} (mouvement #{movementId})"
    segments = layout.segments
    duration = layout.duration
    syncMarks = buildLinearSyncMarks timemap, layout.entries
  else
    {syncMarks, duration} = buildSyncMarks timemap
  {parts, staves} = readPartInfo mv.xml
  staffLabels = (part.label for part in parts)
  staffSequence = []
  for part in parts
    count = staves[part.id] ? 1
    count = 1 unless count > 0
    staffSequence.push part.label for n in [1..count]
  trackMap = buildTrackMap midi, staffLabels, staffSequence
  data = {midi, syncMarks, staffLabels, trackMap, duration, segments, linearRepeats: !!linearRepeats}
  playbackCache[cacheKey] = data
  data

renderMovementPage = (movementId, pageNumber) ->
  # Switch to the requested movement
  unless switchToMovement(movementId)
    self.postMessage {
      type: "error"
      movementId
      message: "Movement not loaded"
    }
    return

  postPage movementId, pageNumber

handleMessage = (e) ->
  { type } = e.data
  # These need the toolkit: keep them instead of dropping them before initialization
  if not tk and type in ["loadMovement", "renderMovementPage", "clearMovements", "getPlaybackData"]
    pending.push e.data
    return
  try
    switch type
      when "verovioInline"
        # Verovio is inlined in SPA mode - initialize it
        verovioLoaded = true
        initVerovio(
          -> notifyReady()
          (err) ->
            self.postMessage {
              type: "error"
              message: "Failed to initialize Verovio: #{err.message or String(err)}"
            }
        )

      when "setVerovioUrl"
        loadVerovio(e.data.url)
          .then ->
            notifyReady()
          .catch (err) ->
            self.postMessage {
              type: "error"
              message: "Failed to load Verovio: #{err.message or String(err)}"
            }

      when "init"
        notifyReady() if tk

      when "msczInline"
        msczInline = e.data

      when "convertMscz"
        { id, bytes } = e.data
        loadMscz2xml()
          .then (api) -> api.convert new Uint8Array(bytes)
          .then (xml) ->
            self.postMessage { type: "msczConverted", id, xml }
          .catch (err) ->
            self.postMessage {
              type: "msczError"
              id
              message: err.message or String(err)
            }

      when "clearMovements"
        clearMovements()

      when "loadMovement"
        {
          movementId
          xmlString
          pageWidth
          pageHeight
          scale
        } = e.data
        loadMovement movementId, xmlString, pageWidth, pageHeight, scale

      when "renderMovementPage"
        {
          movementId
          page
        } = e.data
        renderMovementPage movementId, page

      when "getPlaybackData"
        {movementId, linearRepeats} = e.data
        # Une erreur de lecture ne doit jamais bloquer le rendu des pages
        try
          data = buildPlaybackData movementId, !!linearRepeats
          self.postMessage {
            type: "playbackData"
            movementId
            midi: data.midi
            syncMarks: data.syncMarks
            staffLabels: data.staffLabels
            trackMap: data.trackMap
            duration: data.duration
            segments: data.segments ? []
            linearRepeats: !!data.linearRepeats
          }
        catch playbackErr
          self.postMessage {
            type: "playbackError"
            movementId
            message: playbackErr.message or String(playbackErr)
          }

  catch err
    self.postMessage {
      type: "error"
      message: err.message or String(err)
    }

# Replay the messages received before Verovio was ready, in arrival order
flushPending = ->
  queued = pending
  pending = []
  handleMessage {data} for data in queued

# Tell the app Verovio is ready, then process the messages that arrived too early
notifyReady = ->
  self.postMessage {type: "ready"}
  flushPending()

self.onmessage = handleMessage

# Tests unitaires Node : le worker n'est pas un module, on expose seulement les
# fonctions pures de construction des segments. En Worker, `module` n'existe
# pas et cette branche est ignorée.
if typeof module isnt 'undefined' and module?.exports?
  module.exports = {
    normalizeMeasureId
    buildMeasureFlow
    measureIdsFromMei
    buildLinearSegments
    playbackCacheKey
  }
