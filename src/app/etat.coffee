# État global partagé (modules, caches, chargement, transport) et
# répartiteur des messages reçus du worker.
# Bornes et défauts du tempo de lecture, définis une seule fois avec la
# timeline (src/timeline.coffee).
TEMPO_MIN_BPM = window.__musicaTimeline.TEMPO_MIN_BPM
TEMPO_MAX_BPM = window.__musicaTimeline.TEMPO_MAX_BPM
DEFAULT_PLAYBACK_TEMPO_BPM = window.__musicaTimeline.DEFAULT_PLAYBACK_TEMPO_BPM
DEFAULT_FILE_TEMPO_BPM = window.__musicaTimeline.DEFAULT_FILE_TEMPO_BPM
storage = window.__musicaStorage
worker = window.__musicaWorker
svgStore = window.__svgCache  # Persistent cache with compression
playbackStore = window.__playbackCache  # Données de lecture persistantes
scrollPos = 0
pageCount = 0
pendingPageScroll = null  # page à amener en haut après un saut (mode vertical)
memoryCache = new Map()  # In-memory cache for current session
pendingRequests = new Map()  # Pending page requests for deduplication
fileLoaded = false
indicatorTimeout = null
scrollScheduled = false  # Scroll events are handled once per frame
currentFileId = null
lastWidth = window.innerWidth
resizeTimer = null
positionTimer = null
workerReady = false
currentScale = 40
textSize = 100  # Taille du texte chanté en % de la taille de base (réglage global)
verticalScrollRatio = 0
currentPageWidth = 0
currentPageHeight = 0
hiddenParts = new Set()  # Libellés des voix masquées au rendu, pour le fichier courant
mutedParts = new Set()  # Libellés des voix coupées à la lecture (audio seul)
partSizes = {}  # Libellé de voix -> taille en % (100 = taille normale)
partVolumes = {}  # Libellé de voix -> volume en % (100 = volume normal)
partPrograms = {}  # Libellé de voix -> programme GM choisi (absence = partition)
partsChanged = false  # Réglages de voix modifiés, à appliquer à la fermeture
followPlaybackEnabled = true  # Suivi du défilement pendant la lecture
hideEmptyStaves = false  # Masquer les portées vides de chaque système (sauf le premier)
highlightMeasureEnabled = false  # Surligner la mesure jouée pendant la lecture
expandRepeats = true  # Dérouler les reprises (false : lecture linéaire écrite)
pianoOnly = false  # Toutes les voix mélodiques au piano (réglage global)
# Tempo de lecture : réglage propre au fichier (localStorage), prioritaire sur
# le tempo du fichier ; fileTempo garde le tempo initial découvert dans les
# données de lecture ({bpm, explicit, fileId}) pour afficher le défaut.
playbackTempoOverride = null
fileTempo = null
fileTempoRequest = null
fileTempoError = false
# Transpositions propres au fichier (demi-tons, −12..+12, 0 = aucune) :
# visuelle pour le rendu Verovio, auditive pour les hauteurs jouées. Seule la
# visuelle entre dans les variantes de cache ; l'auditive ne touche que le moteur.
visualTranspose = 0
auditoryTranspose = 0
# Cale de la tête de lecture sur la page affichée ---------------------------------
# Un changement de page (défilement, boutons, goto) place la tête de lecture au
# premier marqueur de synchronisation de cette page, après un court debounce le
# temps que le geste se stabilise. Drapeau anti-boucle : vrai pendant que le
# suivi automatique applique lui-même son déplacement ; les changements de page
# qu'il provoque ne doivent pas re-déclencher un seek (oscillation, blocage).
pageSeekTimer = null
pageSeekDebounceMs = 250
lastDisplayedPage = null
followSuppressSeek = false
# Page visée par le dernier déplacement du suivi : les `scroll` différés qu'il
# provoque ne sont pas un geste de l'utilisateur et ne doivent pas se caler.
followTargetPage = null
# Une cale de lecture est en attente après un changement de page manuel : le
# suivi automatique est suspendu jusque-là, sinon il ramènerait le défilement
# sur la page de la position courante avant le debounce et le geste serait
# perdu (la page ne changerait jamais vraiment).
pageSeekPending = false
currentScrollUnit = "page"  # Dernier réglage « Défilement » appliqué

# Pages pre-rendered around the displayed one
PREFETCH_AHEAD = 6
PREFETCH_BEHIND = 1

# Mode de mise en page effectif : "horizontal" (un système par page) ou
# "vertical" (mise en page naturelle). Redécidé à chaque chargement sur la
# première page du premier mouvement, ou imposé par le réglage « Disposition »,
# puis transmis à tous les mouvements de ce chargement.
scrollMode = null
# Vrai quand scrollMode vient du mode vertical imposé par la mise en page d'un
# gabc (et non d'une détection du worker ni du réglage « Disposition »). Un
# MusicXML suivant doit alors pouvoir le remplacer par son propre mode.
scrollModeVientDeGregorien = false
# Nature du dernier mouvement dont le transport a été synchronisé ("gregorien"
# ou "xml") : le transport ne réagit qu'à un changement de nature, jamais à un
# simple changement de page d'un même MusicXML.
natureTransportAffichee = null
# Réglage « Disposition » : "auto" (décision sur la page naturelle),
# "horizontal" ou "vertical" (imposé). Réglage global, appliqué au chargement.
layoutPreference = "auto"

# Étiquette de mise en page des caches (SVG et lecture) : à mêmes dimensions et
# mêmes voix, la pagination du mode horizontal (un système par page) diffère de
# la mise en page naturelle. Un même fichier peut passer d'un mode à l'autre
# d'une session à l'autre (voix masquées) : les entrées ne doivent pas être
# mélangées. Le mode est connu avant toute lecture ou écriture de cache.
layoutLabel = ->
  if scrollMode is "horizontal" then "h1" else "v"

# Movement tracking
movements = []  # [{id, pageCount, pushed, loaded}]
pendingRenders = new Map()  # "movementId:page" -> resolve function
pushedPages = {}  # movementId -> last page of the initial push received (in order)
# Variante de voix du XML chargé dans le worker, par mouvement. Un rendu (SVG
# ou données de lecture) dépend du XML chargé, pas de l'état courant des
# réglages : c'est cette variante qui doit servir de clé de cache. Quand une
# taille change dans les réglages, partSizes est mis à jour tout de suite mais
# le XML du worker ne l'est qu'au rechargement.
movementVariants = {}  # movementId -> variante du XML chargé
memoryVariant = null  # variante des entrées de memoryCache
pendingMovementLoads = new Map()  # movementId -> resolve function
pendingScoretk = new Map()  # scoretk conversion id -> {resolve, reject}
scoretkRequestId = 0
pendingFormats = new Map()  # demande de formats d'écriture -> {resolve, reject}
formatsRequestId = 0
pendingExports = new Map()  # export en cours -> {resolve, reject}
exportRequestId = 0
exportFormats = null  # formats d'écriture proposés par scoretk (api.formats())
transcriptionNoticeTimer = null  # minuterie du message « transcription MIDI »
targetPage = null  # Page to navigate to once all movements are loaded
awaitingLoad = false  # A new load is posted: ignore the previous render's replies
currentSources = null  # [{name, data}] : sources de l'entrée courante (XML ou binaire)
sourceCache = new Map()  # index de source -> {xml, splitInfo}
nextSourceToLoad = 0  # prochaine source à convertir
allSourcesLoaded = false  # toutes les sources sont converties et leurs mouvements connus
loadToken = 0  # incrémenté à chaque chargement : arrête les chaînes de conversion en cours
movementLoadTokens = new Map()  # movementId -> loadToken de la demande en cours
playbackCache = new Map()  # "movementId:variante de voix" -> données de lecture
pendingPlayback = new Map()  # même clé -> {resolve, reject}
workerSources = new Set()  # sources déjà enregistrées dans le worker (XML complet)

# Transport audio (lot 1) : état de la lecture du mouvement affiché.
# position et duration sont en millisecondes ; loadToken invalide une demande
# de données de lecture devenue obsolète (arrêt, changement de mouvement).
playback =
  movementId: null
  hasData: false
  state: "stopped"  # "stopped" | "playing" | "paused" | "loading"
  position: 0
  duration: 0
  offset: 0  # position du mouvement dans la source (temps de lecture, ms)
  sourceDuration: 0  # durée totale de la source (temps de lecture, ms)
  loading: false
  loadToken: 0
  rafId: null
  marks: []  # syncMarks du mouvement chargé (t en ms, page locale)
  pauses: []  # pauses du mouvement (timeUs/endTimeUs), pour geler le suivi
  followKey: null  # dernière cible de suivi appliquée
  highlightKey: null  # mesure surlignée (id Verovio) : rectangle de fond
  rawData: null  # données du worker, à l'échelle du fichier (sans facteur)
  tempoFactor: 1  # facteur tempo choisi / tempo initial du fichier
  tempoBpm: null  # tempo effectif utilisé pour la lecture chargée
  tempoUnit: "quarter"  # unité de battue du tempo (affichage et réglage)

# Installe un mouvement chargé : même traitement pour la réponse `movementLoaded`
# du worker et pour un mouvement grégorien mis en page dans la page. Le jeton du
# chargement est vérifié par l'appelant (réponse d'un rendu remplacé ignorée).
applyMovementLoaded = (movementId, mvPages, pushed, detectedMode) ->
  awaitingLoad = false
  # Le mode est décidé par le worker sur la première page de ce chargement, ou
  # imposé par la disposition grégorienne (verticale) ; les mouvements suivants
  # le reçoivent en conséquence. Il n'est jamais redécidé par une page rendue,
  # qui pourrait en contenir plusieurs systèmes alors que le mode horizontal en
  # impose un seul.
  mv = movements.find (m) -> m.id is movementId
  if detectedMode? and (scrollMode is null or (scrollModeVientDeGregorien and not mv?.gregorien))
    # Un gabc en tête d'un dossier mixte ne doit pas imposer son mode vertical
    # au MusicXML suivant : quand le worker détecte enfin le mode du MusicXML,
    # il remplace celui du gabc. Un mode explicite ou déjà détecté pour un
    # MusicXML reste prioritaire.
    scrollMode = detectedMode
    scrollModeVientDeGregorien = !!mv?.gregorien
  if mv
    mv.pageCount = mvPages
    mv.loaded = true
    mv.pushed = pushed
  # Update total page count
  pageCount = movements.reduce (sum, m) ->
    sum + (m.pageCount or 0)
  , 0
  # Update page indicator
  showIndicator()
  # Resolve pending movement load promise if any
  if pendingMovementLoads?.has(movementId)
    pendingMovementLoads.get(movementId)()
    pendingMovementLoads.delete(movementId)
  # Hide loading overlay and show the first page as soon as it arrives
  if movementId is 1
    hideLoading()
    if mvPages > 0
      # Page 1 is part of the pushed pages: display it on arrival
      requestPage(1, 1).then ->
        displayView()
        prefetch()
        # Now load subsequent movements after first page is displayed
        loadRemainingMovements()
  # Navigate to the remembered page as soon as its movement is loaded
  tryNavigateTarget()
  # Le mouvement affiché est chargé : précharger ses données de lecture pour
  # activer la barre de position avant la première lecture. La demande est
  # asynchrone, le premier affichage n'est pas retardé.
  preloadPlayback()

# Worker message handler
worker.onmessage = (e) ->
  {type} = e.data
  # Réponse d'un chargement remplacé (rechargement, condensation, masquage) :
  # sa pagination ne vaut plus rien, même si elle arrive après le nouveau
  # mouvement. Les messages de l'application portent le jeton courant.
  return if e.data.loadToken? and e.data.loadToken isnt loadToken
  # Replies still in flight from the previous render would be mapped onto the
  # movements just reset (page counts at 0) and shown in its place: drop them
  # until the new first movement is loaded.
  if awaitingLoad
    return if type is "svg"
    return if type is "movementLoaded" and e.data.movementId isnt 1
  switch type
    when "ready"
      console.log "Worker Verovio prêt"
      workerReady = true
      hideLoading()
      startApp()

    when "movementLoaded"
      # Réponse d'un chargement abandonné (suppression, rechargement) : ignorer
      return if (movementLoadTokens.get e.data.movementId) isnt loadToken
      {movementId, pageCount: mvPages, pushed, scrollMode: detectedMode} = e.data
      applyMovementLoaded movementId, mvPages, pushed, detectedMode

    when "svg"
      {movementId, page, svg} = e.data
      # Convert movement-local page to global page number
      globalPage = page
      for m in movements when m.id < movementId
        globalPage += m.pageCount or 0
      # Pushes arrive in page order: remember how far the worker got
      pushedPages[movementId] = page if page > (pushedPages[movementId] or 0)
      # Le SVG a été rendu à partir du XML chargé dans le worker : il vaut
      # pour la variante de ce XML, pas pour les réglages courants. Après un
      # changement de tailles non encore appliqué, une page en vol ne doit ni
      # entrer dans les caches sous la nouvelle variante (elle y resterait
      # périmée et serait resservie), ni être affichée.
      variant = loadedVariant movementId
      stale = variant isnt partsVariant()
      unless stale
        memoryCache.set globalPage, svg
        # Store in persistent cache (async, non-blocking)
        if currentFileId and currentPageWidth and currentPageHeight
          svgStore.set(currentFileId, globalPage, svg, currentPageWidth, currentPageHeight, layoutLabel(), variant).catch (err) ->
            console.error "Erreur stockage SVG:", err
      # Resolve pending render if any
      key = "#{movementId}:#{page}"
      if pendingRenders.has(key)
        pendingRenders.get(key)(if stale then "" else svg)
        pendingRenders.delete(key)
      # Note: displayView() is now async, so we don't call it here
      # The async displayView will update when pages are loaded

      # Hide loading indicator once the whole score is loaded and cached
      if not stale and allSourcesLoaded and memoryCache.size >= pageCount and pageCount > 0
        hideLoadingIndicator()

    when "error"
      {message, movementId} = e.data
      console.error "Worker error:", message
      if movementId
        showError t("errors.movement", {id: movementId, message})
      else
        showError message

    when "scoretkConverted", "scoretkError"
      {id, xml, gabc, message} = e.data
      pending = pendingScoretk.get id
      return unless pending
      pendingScoretk.delete id
      if type is "scoretkConverted"
        pending.resolve if gabc? then gabc else xml
      else
        pending.reject new Error message

    when "formatsResult", "formatsError"
      {id, formats, message} = e.data
      pending = pendingFormats.get id
      return unless pending
      pendingFormats.delete id
      if type is "formatsResult"
        pending.resolve formats ? []
      else
        pending.reject new Error message

    when "exportResult", "exportError"
      {id, bytes, message} = e.data
      pending = pendingExports.get id
      return unless pending
      pendingExports.delete id
      if type is "exportResult"
        pending.resolve bytes
      else
        pending.reject new Error message

    when "playbackData"
      {movementId, midi, syncMarks, staffLabels, trackMap, duration, offsetMs, sourceDurationMs, segments, pauses, linearRepeats, fileTempoBpm, fileTempoExplicit, fileTempoUnit, loadToken: replyToken} = e.data
      # Réponse d'un chargement remplacé : sa pagination ne vaut plus rien.
      return if replyToken? and replyToken isnt loadToken
      key = playbackKey movementId, !!linearRepeats
      data = {midi, syncMarks, staffLabels, trackMap, duration, offsetMs, sourceDurationMs, segments: segments ? [], pauses: pauses ? [], linearRepeats: !!linearRepeats, fileTempoBpm, fileTempoExplicit, fileTempoUnit}
      playbackCache.set key, data
      pending = pendingPlayback.get key
      if pending
        pendingPlayback.delete key
        pending.resolve data

    when "playbackError"
      {movementId, message, linearRepeats, loadToken: replyToken} = e.data
      # Réponse d'un chargement remplacé : ne pas rejeter la demande courante.
      return if replyToken? and replyToken isnt loadToken
      # PR 1 : aucune UI de lecture, une erreur ici ne doit rien casser
      console.warn "Données de lecture indisponibles pour le mouvement #{movementId}: #{message}"
      key = playbackKey movementId, !!linearRepeats
      pending = pendingPlayback.get key
      if pending
        pendingPlayback.delete key
        pending.reject new Error message

# Calculate global page from movementId and localPage
