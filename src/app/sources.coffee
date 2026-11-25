# Sources d’une entrée : conversion scoretk, chargement séquentiel des
# mouvements dans le worker et suivi de la progression.
# Extensions lues par scoretk et `from` associés : décrits une seule fois dans
# src/formats.coffee (injecté avant l'application). .mid et .midi sont des
# transcriptions, sans notation d'origine.
SCORETK_EXTENSIONS = window.__musicaFormats.scoretkExtensions
SCORETK_EXT_RE = new RegExp "\\.(#{SCORETK_EXTENSIONS.join '|'})$", 'i'

# Convertit une source en MusicXML. Aucune conversion n'a lieu à l'import :
# le contenu brut est converti à la demande.
convertSource = (source) ->
  name = source.name or ""
  data = source.data
  if typeof data is "string"
    # ancienne entrée {xml}, ou texte déjà décodé
    Promise.resolve data
  else if /\.mxl$/i.test name
    Promise.resolve().then -> window.__musicaMxl.extractMxl data
  else if SCORETK_EXT_RE.test name
    unless window.__musicaScoretkAvailable
      Promise.reject new Error "import de ce format indisponible : paquet scoretk absent de cette version"
    else
      # Un .mid ne porte pas de notation : la partition sera une transcription.
      showTranscriptionNotice() if /\.midi?$/i.test name
      # le worker détache le tampon qu'il reçoit : lui donner une copie. Les
      # .ly et .abc sont du texte : scoretk attend leurs octets UTF-8 bruts.
      # `includes` vient de l'import d'un dossier : table des autres fichiers
      # par chemin relatif, pour résoudre les \include LilyPond.
      convertScoretkToXml data.slice(0), name, source.includes
  else
    Promise.resolve new TextDecoder().decode new Uint8Array(data)

# XML converti et découpage en mouvements d'une source, gardés pour la
# partition courante (le zoom, le redimensionnement et les voix rechargent
# sans reconvertir)
ensureSource = (index) ->
  cached = sourceCache.get index
  return Promise.resolve cached if cached
  source = currentSources?[index]
  return Promise.reject new Error "source inconnue" unless source
  if estGabc source
    # Le gabc n'est pas converti : il est décodé puis mis en page par exsurge.
    return Promise.resolve().then ->
      info = preparerSourceGabc source
      sourceCache.set index, info
      info
  convertSource(source).then (xml) ->
    info = {xml, splitInfo: detectSplitPoints xml}
    sourceCache.set index, info
    info

# Ajoute les mouvements d'une source à la fin de la liste globale
appendSourceMovements = (index, info) ->
  if info.gregorien
    # Une source gabc est un seul mouvement, sans découpage en mouvements.
    movements.push
      id: movements.length + 1
      pageCount: 0
      pushed: 0
      loaded: false
      sourceIndex: index
      localIndex: 0
      gregorien: true
    console.log "Source #{index + 1}/#{currentSources.length} : 1 mouvement(s), #{movements.length} au total"
    return
  splitPoints = info.splitInfo.splitPoints ? []
  totalMeasures = info.splitInfo.totalMeasures ? 0
  bounds = [0, ...splitPoints, totalMeasures]
  count = splitPoints.length + 1
  for localIndex in [0...count]
    movements.push
      id: movements.length + 1
      pageCount: 0
      pushed: 0
      loaded: false
      sourceIndex: index
      localIndex: localIndex
      # Bornes globales au fichier (indices de mesures écrites) : le worker
      # en découpe la timeline scoretk.
      measureStart: bounds[localIndex] ? 0
      measureEnd: bounds[localIndex + 1] ? null
  console.log "Source #{index + 1}/#{currentSources.length} : #{count} mouvement(s), #{movements.length} au total"

# Enregistre une fois par source le XML complet dans le worker : le MIDI
# scoretk est global au fichier, pas au mouvement élagué.
ensureWorkerSource = (index, info) ->
  return unless info?.xml?
  return if workerSources.has index
  workerSources.add index
  worker.postMessage
    type: "registerSource"
    sourceId: index
    xml: info.xml

# Charge une entrée : un fichier seul est une source, un dossier en a plusieurs.
# Les sources auxiliaires d'un dossier (.ily, fichiers inclus) sont conservées
# dans l'entrée mais ne deviennent pas des pièces. Les anciennes entrées, sans
# `role`, gardent leur comportement : toutes leurs sources sont chargées.
# La première source est convertie et affichée tout de suite, les suivantes
# sont ajoutées en tâche de fond.
loadSources = (sources, startPage = 1) ->
  currentSources = (source for source in sources when source.role isnt "aux")
  sourceCache.clear()
  startLoad startPage

# Recharge la partition courante (redimensionnement, zoom, voix) : les XML
# convertis et les découpages restent en cache
reloadScore = (startPage) ->
  return unless currentSources?.length
  startLoad startPage, true

# Reset the render state and start converting the first source. `keepSources`
# (rechargement à XML inchangé) laisse au worker ses sources, son MIDI et sa
# timeline scoretk, qui ne dépendent ni de la mise en page ni des voix masquées.
startLoad = (startPage = 1, keepSources = false) ->
  token = ++loadToken
  # Nouveau chargement (fichier, rechargement, zoom, voix) : le transport
  # repart de zéro et le moteur audio libère son contexte.
  hideTransport()
  resetPlayback()
  partsChanged = false
  loadPartSettings()
  loadPlaybackTempo()
  loadTransposition()
  fileTempoRequest = null
  fileTempoError = false
  scrollPos = 0
  pendingPageScroll = null
  clearTimeout pageSeekTimer if pageSeekTimer
  pageSeekTimer = null
  lastDisplayedPage = null
  followSuppressSeek = false
  followTargetPage = null
  pageSeekPending = false
  lastWidth = window.innerWidth
  # Drop the displayed pages: they belong to the previous render
  $("page-current").innerHTML = ""
  memoryCache.clear()
  memoryVariant = partsVariant()
  movementVariants = {}
  pendingRequests.clear()
  pendingRenders.clear()
  pendingMovementLoads.clear()
  # Les données de lecture du chargement précédent ne sont plus valides. Les
  # demandes en cours sont rejetées : leur réponse pourrait arriver trop tard.
  pendingPlayback.forEach (pending) -> pending.reject new Error "Chargement remplacé"
  pendingPlayback.clear()
  playbackCache.clear()
  workerSources.clear() unless keepSources
  pushedPages = {}
  movements = []
  awaitingLoad = true
  nextSourceToLoad = 0
  allSourcesLoaded = false
  fileLoaded = false
  targetPage = if startPage > 1 then startPage else null  # Navigate later if needed
  showLoading()
  hideLoadingIndicator()

  # Le mode de mise en page est redécidé à chaque chargement, y compris un
  # rechargement (zoom, voix, redimensionnement, transposition) : la première
  # page du premier mouvement est relue en mise en page naturelle. Le réglage
  # « Disposition » peut l'imposer d'avance. Il est ensuite transmis aux
  # mouvements suivants de ce chargement.
  scrollMode = if layoutPreference is "auto" then null else layoutPreference
  scrollModeVientDeGregorien = false
  natureTransportAffichee = null
  verticalPos = 0

  currentPageWidth = Math.round(window.innerWidth * 100 / currentScale)
  currentPageHeight = Math.round(window.innerHeight * 100 / currentScale)

  # Les pages des autres variantes de voix ne seront plus demandées : les
  # purger évite que le cache enfle à chaque essai de taille.
  if currentFileId
    svgStore.pruneVariants(currentFileId, partsVariant()).catch (err) ->
      console.warn "Purge du cache SVG impossible : #{err?.message or err}"

  # Clear previous movements before loading new file. Les marques de synchro
  # dépendent de la mise en page : elles repartent toujours de zéro.
  clearMsg = { type: "clearMovements" }
  clearMsg.keepSources = true if keepSources
  worker.postMessage clearMsg

  loadFirstSource token

# Convertit les sources dans l'ordre jusqu'à la première qui donne un
# mouvement, et charge son premier mouvement
loadFirstSource = (token) ->
  return unless token is loadToken
  return finishLoad(token) if nextSourceToLoad >= currentSources.length

  index = nextSourceToLoad++
  ensureSource(index)
    .then (info) ->
      return unless token is loadToken
      appendSourceMovements index, info
      if info.gregorien
        # Mise en page dans la page, sans worker : le mouvement n'est déclaré
        # chargé qu'une fois ses SVG produits. Un gabc invalide est retiré et
        # signalé, sans empêcher les sources suivantes.
        firstMovement = movements[movements.length - 1]
        chargerGregorienMovement(firstMovement.id, info)
          .then (result) ->
            return unless token is loadToken
            fileLoaded = true
            hideImport()
            showLibraryBtn()
            hideTransport()
            natureTransportAffichee = "gregorien"
            applyMovementLoaded firstMovement.id, result.svgs.length,
              result.svgs.length, result.mode
          .catch (err) ->
            return unless token is loadToken
            retirerMouvementGregorien firstMovement
            reportSourceError index, err
            loadFirstSource token
        return
      mvXml = extractMovement info.splitInfo, 0
      unless mvXml
        return loadFirstSource token
      ensureWorkerSource index, info
      firstMovement = movements[0]
      loadMovementAndWait(1, mvXml, currentPageWidth, currentPageHeight, index,
        firstMovement?.measureStart, firstMovement?.measureEnd, modePourWorker())
      # Subsequent movements and sources are loaded once this one is displayed
      # (see movementLoaded handler)
      fileLoaded = true
      hideImport()
      showLibraryBtn()
      showTransport()
      natureTransportAffichee = "xml"
    .catch (err) ->
      return unless token is loadToken
      reportSourceError index, err
      loadFirstSource token

# Report a source that could not be converted, without stopping the others
reportSourceError = (index, err) ->
  console.log "Conversion impossible pour la source #{index + 1}:", err
  name = currentSources?[index]?.name or "source #{index + 1}"
  showError t("errors.sourceSkipped", {name, error: err?.message or err})

# Load remaining movements (and sources) sequentially after the first page is
# displayed. A source is converted only when the previous one is fully loaded.
loadRemainingMovements = ->
  return unless currentSources?.length
  token = loadToken
  # Show loading indicator while loading remaining movements
  showLoadingIndicator()
  stepLoad token

stepLoad = (token) ->
  return unless token is loadToken and currentSources?.length

  # 1. A movement is known but not rendered yet
  pending = movements.find (m) -> not m.loaded
  if pending
    info = sourceCache.get pending.sourceIndex
    return finishLoad token unless info
    if pending.gregorien
      chargerGregorienMovement(pending.id, info)
        .then (result) ->
          return unless token is loadToken
          applyMovementLoaded pending.id, result.svgs.length,
            result.svgs.length, result.mode
          stepLoad token
        .catch (err) ->
          return unless token is loadToken
          retirerMouvementGregorien pending
          reportSourceError pending.sourceIndex, err
          stepLoad token
      return
    mvXml = extractMovement info.splitInfo, pending.localIndex
    unless mvXml
      pending.loaded = true
      return stepLoad token
    ensureWorkerSource pending.sourceIndex, info
    pageWidth = Math.round(window.innerWidth * 100 / currentScale)
    pageHeight = Math.round(window.innerHeight * 100 / currentScale)
    loadMovementAndWait(pending.id, mvXml, pageWidth, pageHeight, pending.sourceIndex,
      pending.measureStart, pending.measureEnd, modePourWorker()).then ->
      stepLoad token
    return

  # 2. Convert the next source, then append its movements
  if nextSourceToLoad < currentSources.length
    index = nextSourceToLoad++
    ensureSource(index)
      .then (info) ->
        return unless token is loadToken
        appendSourceMovements index, info
        stepLoad token
      .catch (err) ->
        return unless token is loadToken
        reportSourceError index, err
        stepLoad token
    return

  finishLoad token

finishLoad = (token) ->
  return unless token is loadToken
  allSourcesLoaded = true
  hideLoading()
  hideLoadingIndicator()
  unless fileLoaded
    # Nothing could be displayed: back to the import screen, with access to the
    # library (the entry is saved even if its files cannot be read)
    showImport()
    showLibraryBtn()
  tryNavigateTarget()

# Go to the remembered page as soon as its movement is loaded, without waiting
# for the remaining sources
tryNavigateTarget = ->
  return unless targetPage
  offset = 0
  for m in movements
    count = m.pageCount or 0
    if offset + count >= targetPage
      break unless m.loaded
      page = targetPage
      targetPage = null
      goToPage page
      return
    break unless m.loaded
    offset += count
  return unless allSourcesLoaded
  # The page no longer exists (fewer pages than when it was saved)
  page = Math.min targetPage, pageCount
  targetPage = null
  goToPage page

# Mode transmis au worker : un mode vertical venu d'un gabc ne doit pas lui être
# imposé pour un MusicXML suivant, qui doit détecter le sien (null = détection).
modePourWorker = ->
  if scrollModeVientDeGregorien then null else scrollMode

# Load a movement in worker and return Promise that resolves when loaded.
# `mode` est le mode de mise en page effectif (null pour le premier mouvement
# d'un chargement en disposition automatique : le worker le détecte alors sur
# la première page).
loadMovementAndWait = (movementId, xmlString, pageWidth, pageHeight, sourceId = null, measureStart = 0, measureEnd = null, mode = null) ->
  new Promise (resolve) ->
    # Store resolver to be called when movementLoaded message arrives
    pendingMovementLoads.set movementId, resolve
    # Retain the load this reply belongs to, so a superseded one is ignored
    movementLoadTokens.set movementId, loadToken
    # Le XML envoyé porte les tailles de voix et la transposition visuelle
    # courantes : les pages que le worker va produire vaudront pour cette
    # variante.
    movementVariants[movementId] = partsVariant()

    worker.postMessage
      type: "loadMovement"
      movementId: movementId
      xmlString: xmlString
      pageWidth: pageWidth
      pageHeight: pageHeight
      scale: currentScale
      transpose: visualTranspose
      sourceId: sourceId
      measureStart: measureStart
      measureEnd: measureEnd
      scrollMode: mode
      hideEmptyStaves: hideEmptyStaves
      # Jeton du chargement : les pages d'un rendu remplacé (mise en page
      # différente) seront ignorées même si elles arrivent après le nouveau.
      loadToken: loadToken

# Met en page un mouvement grégorien et garde ses SVG sur le mouvement. La
# promesse résout avec {svgs, mode} ; elle échoue si un chargement plus récent a
# remplacé celui-ci.
chargerGregorienMovement = (movementId, info) ->
  new Promise (resolve, reject) ->
    # Jeton figé au départ : comparer movementLoadTokens.get(id) à loadToken
    # plus tard comparerait deux valeurs courantes, réécrites ensemble par un
    # rechargement, et laisserait l'ancienne mise en page écraser la nouvelle.
    jeton = loadToken
    miseEnPageGabc(info.texte, {scale: currentScale})
      .then (result) ->
        return reject new Error "Chargement remplacé" unless jeton is loadToken
        mv = movements.find (m) -> m.id is movementId
        return reject new Error "mouvement inconnu" unless mv
        mv.gregorienSvgs = result.svgs
        resolve result
      .catch (err) ->
        reject err

# Retire un mouvement grégorien qui n'a pas pu être mis en page : il est le
# dernier ajouté (les sources sont chargées dans l'ordre), donc retirer la fin
# de liste laisse les identifiants des mouvements chargés cohérents.
retirerMouvementGregorien = (movement) ->
  index = movements.indexOf movement
  return unless index >= 0
  movements.splice index, 1

# Loading indicator for background movement loading
showLoadingIndicator = ->
  el = $("loading-indicator")
  el?.classList.remove "hidden"

hideLoadingIndicator = ->
  el = $("loading-indicator")
  el?.classList.add "hidden"

