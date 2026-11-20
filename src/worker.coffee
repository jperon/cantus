# Web Worker — Verovio rendering with movement support
# Supports multiple movements loaded sequentially

tk = null
verovioLoaded = false
movements = {}  # movementId -> {pageCount, loaded, xml, options}
currentMovement = null
pending = []  # messages waiting for the toolkit, replayed once Verovio is ready
scoretkLoad = null  # scoretk loading promise, created on first MuseScore conversion
scoretkInline = null  # SPA: {glue, wasm} sources sent by the page
timelineApi = self.__musicaTimeline ? null  # src/timeline.coffee, injecté avant ce fichier
playbackCache = {}  # clé mouvement/mode/bornes -> playbackData
sources = {}  # sourceId -> {bytes, xml} : source complète, pour scoretk
sourcePlayback = {}  # "sourceId:mode" -> {midi, timeline, staffLabels, trackMap}
sourcePlaybackPending = {}  # même clé -> promesse en cours

# Clear all movements (call before loading new file). Les sources, leur MIDI et
# leur timeline scoretk ne dépendent ni de la mise en page ni des voix masquées :
# un rechargement à XML inchangé (keepSources) les conserve.
clearMovements = (keepSources = false) ->
  movements = {}
  currentMovement = null
  playbackCache = {}
  unless keepSources
    sources = {}
    sourcePlayback = {}
    sourcePlaybackPending = {}

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

# Load the scoretk converter once: the package in the normal build, the
# inlined glue and wasm module in the SPA. Both resolve an object exposing
# convert(bytes, {from, to}) -> Uint8Array.
loadScoretk = ->
  return scoretkLoad if scoretkLoad
  scoretkLoad = new Promise (resolve, reject) ->
    try
      if scoretkInline
        # SPA : évaluer le glue wasm-bindgen (portée globale) puis lui donner
        # le module compilé depuis le .wasm inliné en base64.
        self.eval scoretkInline.glue + '\nself.wasm_bindgen = wasm_bindgen;'
        bytes = Uint8Array.from atob(scoretkInline.wasm), (c) -> c.charCodeAt 0
        module = new WebAssembly.Module bytes
        self.wasm_bindgen { module_or_path: module }
          .then -> resolve self.wasm_bindgen
          .catch reject
      else
        importScripts 'scoretk/scoretk.js'
        unless self.scoretk?.ready
          reject new Error "paquet scoretk absent : conversion de partitions désactivée"
          return
        self.scoretk.ready
          .then -> resolve self.scoretk
          .catch reject
    catch err
      reject new Error "scoretk indisponible : #{err.message or err}"
  scoretkLoad

# Format d'entrée passé à scoretk, déduit de l'extension du fichier : table
# unique dans src/formats.coffee, injecté avant ce fichier (comme
# timeline.coffee). Une extension inconnue laisse scoretk détecter le format par
# le contenu.
scoretkFrom = self.__musicaFormats?.scoretkFrom

# Render one page of the currently loaded movement and send it back
postPage = (movementId, pageNumber) ->
  self.postMessage {
    type: "svg"
    movementId
    page: pageNumber
    svg: tk.renderToSVG pageNumber
  }

# Nombre de systèmes d'une page SVG : Verovio les écrit <g class="system">.
systemCount = (svgString) ->
  (String(svgString ? "").match(/<g\b[^>]*class="system"/g) or []).length

# Rend un mouvement. `mode` (« horizontal » ou « vertical ») est connu pour
# tous les mouvements d'un fichier sauf le premier d'un chargement : il est
# alors détecté sur la première page de la mise en page naturelle. En mode
# horizontal, une page ne contient qu'un système (systemMaxPerPage) : sans
# cela, une page suivante ou un mouvement moins fourni en afficherait deux,
# superposés dans la vue paginée.
loadMovement = (movementId, xmlString, pageWidth, pageHeight, scale = 40, sourceId = null, measureStart = 0, measureEnd = null, transpose = 0, mode = null) ->
  options = {
    breaks: "auto"
    adjustPageHeight: true
    pageWidth: pageWidth
    pageHeight: pageHeight
    scale: scale
    condense: "none"
    header: "none"
    footer: "none"
    # Toujours posé : le toolkit sert à plusieurs fichiers et une valeur
    # laissée à 1 forcerait la mise en page du fichier suivant.
    systemMaxPerPage: if mode is "horizontal" then 1 else 0
    # Verovio accepte un nombre de demi-tons signé. La valeur vide annule une
    # transposition précédente du toolkit ; 0 laisse donc le rendu inchangé.
    transpose: if transpose then String(transpose) else ""
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
  # Page 1 déjà rendue par la détection : elle est renvoyée telle quelle plutôt
  # que rendue une seconde fois.
  firstPageSvg = null
  unless mode in ["horizontal", "vertical"]
    firstPageSvg = if pageCount > 0 then tk.renderToSVG(1) else null
    mode = if systemCount(firstPageSvg) <= 1 then "horizontal" else "vertical"
    if mode is "horizontal" and pageCount > 0
      options.systemMaxPerPage = 1
      tk.setOptions {systemMaxPerPage: 1}
      tk.redoLayout()
      pageCount = tk.getPageCount()
      firstPageSvg = null
  mv = {
    pageCount
    loaded: true
    xml: xmlString
    options
    sourceId
    measureStart
    measureEnd
  }
  # Pont mesure écrite -> page : le SEUL usage de renderToTimemap. Il est
  # construit ici, sur le mouvement (indices locaux), une fois pour toutes.
  try
    pageIndex = buildPageIndex movementId, mv
    mv.pageByWrittenIndex = pageIndex.pages
    mv.verovioIdByWrittenIndex = pageIndex.ids
  catch err
    mv.pageByWrittenIndex = []
    mv.verovioIdByWrittenIndex = []
    console.warn "Pont mesure→page indisponible (mouvement #{movementId}) : #{err.message or err}"
  movements[movementId] = mv
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
    scrollMode: mode
  }
  if pushed > 0
    for page in [1..pushed]
      if page is 1 and firstPageSvg?
        self.postMessage {type: "svg", movementId, page, svg: firstPageSvg}
      else
        postPage movementId, page

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

# --- Source complète et pont mesure -> page ---------------------------------

# Enregistre la source complète (MusicXML converti), par sourceId. Le MIDI
# scoretk est global au fichier : le mouvement élagué ne suffit pas, sinon les
# voix masquées disparaîtraient du mapping et redeviendraient audibles.
registerSource = (sourceId, xml) ->
  return unless sourceId? and typeof xml is 'string'
  sources[sourceId] ?= {
    xml
    bytes: new TextEncoder().encode xml
  }

# Nombre de mesures écrites d'un fragment MusicXML (première partie : toutes
# les parties ont le même nombre de mesures).
countWrittenMeasures = (xml) ->
  match = String(xml ? "").match /<part(?:\s[^>]*)?>([\s\S]*?)<\/part>/i
  return 0 unless match
  (match[1].match(/<measure(?=[\s>])/g) ? []).length

# Liste [index écrit local -> page] pour un mouvement. `measureOn` donne
# l'ordre d'exécution ; les copies « -rendN » sont ramenées à leur première
# occurrence. Verovio ne rend PAS les mesures repliées dans un multi-repos :
# `ids` contient donc leurs xmlId dans l'ordre du XML, mais pas une entrée par
# mesure écrite. La correspondance avec la timeline se fait par xmlId, jamais
# par position. En cas d'écart avec le XML du mouvement, on journalise.
buildPageIndex = (movementId, mv) ->
  timemap = tk.renderToTimemap({includeMeasures: true})
  unless Array.isArray timemap
    throw new Error "Verovio n'a produit aucun timemap pour le mouvement #{movementId}"
  pages = []
  ids = []
  seen = new Set()
  for entry in timemap
    continue unless entry?.measureOn?
    id = String entry.measureOn
    base = id.replace /-rend\d+$/, ''
    continue if seen.has base
    seen.add base
    ids.push id
    page = tk.getPageWithElement id
    pages.push if page > 0 then page else null
  written = countWrittenMeasures mv.xml
  if written > 0 and pages.length isnt written
    console.warn "Pont mesure→page incohérent (mouvement #{movementId}) : " +
      "#{pages.length} mesure(s) au timemap, #{written} mesure(s) écrite(s)"
  {pages, ids}

# --- Données de lecture (MIDI + timeline scoretk) ---------------------------

# Encode les octets MIDI en base64, par tranches pour ne pas saturer la pile.
encodeBase64 = (bytes) ->
  parts = []
  chunk = 0x8000
  for offset in [0...bytes.length] by chunk
    parts.push String.fromCharCode.apply null, bytes.subarray(offset, offset + chunk)
  btoa parts.join ''

# Clé du cache de lecture : mode (déroulé / linéaire) et bornes du mouvement.
playbackCacheKey = (movementId, linearRepeats, measureStart = 0, measureEnd = null) ->
  bounds = "#{measureStart}:#{measureEnd ? ''}"
  "#{movementId}:#{if linearRepeats then 'linear' else 'expanded'}:#{bounds}"

sourcePlaybackKey = (sourceId, linearRepeats) ->
  "#{sourceId}:#{if linearRepeats then 'linear' else 'expanded'}"

# MIDI + timeline scoretk pour une source et un mode, calculés une seule fois.
# Le MusicXML n'est pas joint : il est identique dans les deux modes.
loadSourcePlayback = (sourceId, linearRepeats) ->
  key = sourcePlaybackKey sourceId, linearRepeats
  return Promise.resolve sourcePlayback[key] if sourcePlayback[key]
  return sourcePlaybackPending[key] if sourcePlaybackPending[key]
  source = sources[sourceId]
  unless source
    return Promise.reject new Error "Source #{sourceId} inconnue dans le worker"
  promise = loadScoretk()
    .then (api) ->
      result = api.convertWithTimeline source.bytes,
        from: 'musicxml'
        expandRepeats: not linearRepeats
      unless result?.midi and result?.timeline
        throw new Error "scoretk n'a produit ni MIDI ni timeline pour la source #{sourceId}"
      midi = encodeBase64 result.midi
      {parts, staves} = readPartInfo source.xml
      staffLabels = (part.label for part in parts)
      staffSequence = []
      for part in parts
        count = staves[part.id] ? 1
        count = 1 unless count > 0
        staffSequence.push part.label for n in [1..count]
      data = {
        midi
        timeline: result.timeline
        # Tempo initial du FICHIER (la timeline scoretk est globale à la
        # source) : sa carte de tempo commence toujours au tick 0. `explicit`
        # distingue une indication réelle du défaut implicite de 120 BPM.
        fileTempo: timelineApi.fileTempoInfo result.timeline, source.xml
        staffLabels
        trackMap: buildTrackMap midi, staffLabels, staffSequence
      }
      sourcePlayback[key] = data
      data
  promise.then ((-> delete sourcePlaybackPending[key])), ((-> delete sourcePlaybackPending[key]))
  sourcePlaybackPending[key] = promise
  promise

# Données de lecture d'un mouvement déjà chargé. La timeline scoretk est
# globale au fichier : on en découpe les mesures du mouvement, puis on en
# dérive segments et marqueurs avec le module timeline.
buildPlaybackData = (movementId, linearRepeats = false, measureStart, measureEnd) ->
  mv = movements[movementId]
  throw new Error "Mouvement #{movementId} non chargé" unless mv?.loaded
  unless timelineApi?.movementSlice?
    throw new Error "Module timeline absent du worker"
  start = if measureStart? then measureStart else (mv.measureStart ? 0)
  stop = if measureEnd? then measureEnd else (mv.measureEnd ? null)
  cacheKey = playbackCacheKey movementId, linearRepeats, start, stop
  cached = playbackCache[cacheKey]
  return Promise.resolve cached if cached
  loadSourcePlayback(mv.sourceId, linearRepeats).then (source) ->
    slice = timelineApi.movementSlice source.timeline, start, stop
    # Le MIDI scoretk est global à la source : les segments visent ses notes
    # aux temps absolus du flux (`baseUs`), tout en gardant `offsetMs` cumulé
    # depuis le début du mouvement pour la sortie audio.
    segments = timelineApi.buildSegments slice, null, slice.offsetUs
    # Durée totale du fichier : la position affichée peut ainsi être cumulée
    # sur toute la partition, pas seulement sur le mouvement courant.
    fileSlice = timelineApi.movementSlice source.timeline, 0, null
    # Pont mesure écrite -> page par xmlId (et non par position) : Verovio
    # n'émet pas de measureOn pour les mesures repliées d'un multi-repos, donc
    # l'index Verovio et l'ordinal scoretk divergent dès la première mesure
    # repliée. On associe les ids de measureOn aux xmlId de la timeline, puis
    # on remplit les mesures absentes (repliées) avec la page précédente.
    verovioIds = mv.verovioIdByWrittenIndex ? []
    verovioPages = mv.pageByWrittenIndex ? []
    pageByVerovioId = {}
    for id, i in verovioIds
      vid = String id
      pageByVerovioId[vid] = verovioPages[i]
    writtenIds = {}
    for entry in (slice.measures ? [])
      writtenIds[String entry.xmlId] = true if entry.xmlId?
    idMode = false
    for vid of pageByVerovioId
      if writtenIds[vid]
        idMode = true
        break
    pageByWrittenIndex = verovioPages
    idUnresolved = 0
    if idMode
      resolved = {}
      entryLocals = {}
      maxLocal = 0
      for entry in (slice.measures ? [])
        local = Number(entry.measure) - start
        continue unless local >= 0
        entryLocals[local] = true
        maxLocal = local if local > maxLocal
        page = if entry.xmlId? then pageByVerovioId[String entry.xmlId] else null
        page = Number page
        resolved[local] = page if isFinite(page) and page > 0
      pageByWrittenIndex = []
      previous = null
      # Mesures repliées (multi-repos) : page de la mesure résolue précédente.
      # Les entrées sans page sont comptées ; celles d'avant toute page
      # résolue restent non résolues dans buildSyncMarks (comptées là aussi).
      for i in [0..maxLocal]
        if resolved[i]?
          previous = resolved[i]
        else if previous? and entryLocals[i]
          idUnresolved += 1
        pageByWrittenIndex[i] = previous
    {marks, unresolved} = timelineApi.buildSyncMarks slice, pageByWrittenIndex, start
    unresolved += idUnresolved
    if unresolved > 0
      console.warn "Marqueurs non résolus en page (mouvement #{movementId}) : #{unresolved}"
    # Le suivi vertical et getElementById utilisent les ids de Verovio. En mode
    # xmlId ils sont égaux (Verovio conserve xml:id) ; sinon on retombe sur
    # l'ancien pont positionnel, qui n'est valable que sans multi-repos.
    if idMode
      previousVid = null
      for mark in marks
        key = String mark.id
        if pageByVerovioId[key]?
          previousVid = key
          mark.id = key
        else if previousVid?
          mark.id = previousVid
    else
      verovioByXmlId = new Map()
      for entry in (source.timeline.measures ? [])
        xmlId = String entry.xmlId ? "m#{entry.measure}"
        continue if verovioByXmlId.has xmlId
        bridged = mv.verovioIdByWrittenIndex?[entry.measure - start]
        verovioByXmlId.set xmlId, bridged if bridged?
      for mark in marks
        bridged = verovioByXmlId.get String(mark.id)
        mark.id = bridged if bridged?
    data = {
      midi: source.midi
      syncMarks: marks
      staffLabels: source.staffLabels
      trackMap: source.trackMap
      duration: slice.durationMs
      # Position absolue du mouvement dans la source et durée de la source :
      # le transport affiche et cumule sur toute la partition.
      offsetMs: slice.offsetMs
      sourceDurationMs: fileSlice.durationMs
      segments
      pauses: slice.pauses
      linearRepeats: !!linearRepeats
      # Tempo initial du fichier, dans son unité de battue : le réglage
      # « Tempo » en dérive son défaut et son symbole.
      fileTempoBpm: source.fileTempo?.bpm ? 120
      fileTempoExplicit: source.fileTempo?.explicit is true
      fileTempoUnit: source.fileTempo?.unit ? 'quarter'
    }
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
  # These need the toolkit: keep them instead of dropping them before initialization.
  # registerSource doit rester dans la file pour préserver son ordre relatif avec
  # clearMovements : sinon un clearMovements rejoué efface la source déjà enregistrée.
  if not tk and type in ["loadMovement", "renderMovementPage", "clearMovements", "getPlaybackData", "registerSource"]
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

      when "scoretkInline"
        scoretkInline = e.data

      when "registerSource"
        registerSource e.data.sourceId, e.data.xml

      when "convertScoretk"
        { id, bytes, name } = e.data
        from = scoretkFrom name
        loadScoretk()
          .then (api) -> api.convert new Uint8Array(bytes), { from }
          .then (result) ->
            xml = new TextDecoder().decode result
            self.postMessage { type: "scoretkConverted", id, xml }
          .catch (err) ->
            self.postMessage {
              type: "scoretkError"
              id
              message: err.message or String(err)
            }

      when "clearMovements"
        clearMovements e.data.keepSources

      when "loadMovement"
        {
          movementId
          xmlString
          pageWidth
          pageHeight
          scale
          transpose
          sourceId
          measureStart
          measureEnd
          scrollMode
        } = e.data
        loadMovement movementId, xmlString, pageWidth, pageHeight, scale, sourceId, measureStart, measureEnd, transpose, scrollMode

      when "renderMovementPage"
        {
          movementId
          page
        } = e.data
        renderMovementPage movementId, page

      when "getPlaybackData"
        {movementId, linearRepeats, measureStart, measureEnd} = e.data
        # Une erreur de lecture ne doit jamais bloquer le rendu des pages
        buildPlaybackData movementId, !!linearRepeats, measureStart, measureEnd
          .then (data) ->
            self.postMessage {
              type: "playbackData"
              movementId
              midi: data.midi
              syncMarks: data.syncMarks
              staffLabels: data.staffLabels
              trackMap: data.trackMap
              duration: data.duration
              offsetMs: data.offsetMs
              sourceDurationMs: data.sourceDurationMs
              segments: data.segments ? []
              pauses: data.pauses ? []
              linearRepeats: !!data.linearRepeats
              fileTempoBpm: data.fileTempoBpm
              fileTempoExplicit: data.fileTempoExplicit
              fileTempoUnit: data.fileTempoUnit
            }
          .catch (playbackErr) ->
            self.postMessage {
              type: "playbackError"
              movementId
              linearRepeats: !!linearRepeats
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
    countWrittenMeasures
    playbackCacheKey
    # Crochets de test : injecter un toolkit factice, déclencher le flush des
    # messages en attente et lire l'état interne des sources.
    __test: {
      setToolkit: (value) -> tk = value
      notifyReady
      getSources: -> sources
      getSourcePlayback: -> sourcePlayback
      setSourcePlayback: (key, value) -> sourcePlayback[key] = value
      getPending: -> pending
    }
  }
