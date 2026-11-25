# Transport audio (lecture, pause, arrêt, progression, volume, raccourcis) et
# suivi du défilement sur la tête de lecture pendant la lecture.
# --- Transport audio (lot 1) ---------------------------------------------
# Lecture/pause, arrêt, progression et volume général. Aucune synchronisation
# de défilement ni volume par voix ici : ces lots viendront ensuite.

audioEngine = -> window.__musicaAudio

# Vrai pendant un glissement du curseur de position : le libellé et le curseur
# suivent alors le geste, pas la tête de lecture.
transportSeeking = false
# Position visée par le glissement (ms, locale au mouvement), ou null quand le
# suivi reprend la tête de lecture. Le défilement pendant le geste passe par la
# même fonction que le suivi de lecture (applyFollowScroll).
transportSeekPreview = null
# Boucle d'aperçu du glissement : au plus une mise à jour de vue par frame.
transportSeekRaf = null

formatTime = (ms) ->
  total = Math.max 0, Math.round((Number(ms) or 0) / 1000)
  minutes = Math.floor total / 60
  seconds = total % 60
  "#{minutes}:#{if seconds < 10 then "0#{seconds}" else seconds}"

showTransport = ->
  # Un mouvement grégorien n'a ni lecture ni données de lecture : le transport
  # reste masqué et aucune requête n'est envoyée au worker.
  return hideTransport() if estGregorienAffiche()
  el = $("transport")
  el?.classList.remove "hidden"
  updateCommandBarSpace()

hideTransport = ->
  el = $("transport")
  el?.classList.add "hidden"
  updateCommandBarSpace()

# Position affichée : le moteur fait foi pendant la lecture
currentPlaybackPosition = ->
  return playback.position unless playback.state is "playing"
  engine = audioEngine()
  return playback.position unless engine
  Math.max 0, engine.position() * 1000

# Position qui pilote le suivi : celle visée par un glissement du curseur
# s'il est en cours, sinon la tête de lecture.
followPosition = ->
  return transportSeekPreview if transportSeekPreview?
  currentPlaybackPosition()

# Durée affichée : celle de la source entière (tous les mouvements
# s'enchaînent), fournie par le worker.
displayDuration = -> playback.sourceDuration

# Position affichée : cumulée sur la source (début du mouvement + temps local).
displayPosition = ->
  Math.max 0, (Number(playback.offset) or 0) + currentPlaybackPosition()

renderTransport = ->
  time = $("transport-time")
  playBtn = $("transport-play")
  seek = $("transport-seek")
  duration = displayDuration()
  rawPosition = displayPosition()
  position = Math.max 0, rawPosition
  position = Math.min position, duration if duration > 0
  # `playback.position` reste locale au mouvement (domaine du moteur).
  local = currentPlaybackPosition()
  local = Math.min local, playback.duration if playback.duration > 0
  playback.position = Math.max 0, local
  playing = playback.state is "playing"
  loading = playback.state is "loading"
  # Le curseur couvre le mouvement chargé (seule portée que le moteur sait
  # déplacer) ; le libellé de temps reste cumulé sur la source entière.
  sliderDuration = Math.max 0, playback.duration or 0
  # Pendant un glissement du curseur, la position affichée suit le doigt et
  # non la lecture : la boucle de rendu ne doit pas ramener le curseur.
  unless transportSeeking
    time.textContent = "#{formatTime position} / #{formatTime duration}" if time
    if seek
      seek.value = if sliderDuration > 0 then Math.round(local / sliderDuration * 1000) else 0
      seek.setAttribute "aria-valuetext", "#{formatTime local} / #{formatTime sliderDuration}"
  if seek
    seek.disabled = sliderDuration <= 0
  if playBtn
    playBtn.textContent = if playing then "❚❚" else "▶"
    playBtn.setAttribute "aria-label", t(if playing then "transport.pauseAria" else "transport.playAria")
    playBtn.disabled = loading

cancelPlaybackFrame = ->
  if playback.rafId?
    cancelAnimationFrame playback.rafId
    playback.rafId = null

# En mode horizontal, chaque page vaut deux demi-pages (scrollPos pair : début
# de page, impair : milieu de page), exactement comme le geste manuel qui
# avance d'un cran à la fois. Au-delà du milieu, on franchit le seuil avec une
# petite marge : un élément pile sur la frontière ne fait pas osciller le suivi
# d'une demi-page à l'autre à chaque frame.
HALF_HYSTERESIS = 0.05

# Demi-page visée pour l'élément `id` de la page `page` (mode horizontal).
# Le repère est le rapport (x élément - x SVG) / largeur du SVG : il reste
# juste quel que soit le zoom, la taille de portée ou la transformation CSS,
# puisqu'élément et page sont mesurés dans le même repère écran.
horizontalHalfPage = (page, id) ->
  pageEl = $("page-current").querySelector ".scroll-page[data-page=\"#{page}\"]"
  svg = pageEl?.querySelector "svg"
  return null unless svg
  element = document.getElementById id if id?
  return null unless element and pageEl.contains element
  svgRect = svg.getBoundingClientRect()
  return null unless svgRect.width > 0
  ratio = (element.getBoundingClientRect().left - svgRect.left) / svgRect.width
  base = (page - 1) * 2
  half = if ratio < 0.5 then 0 else 1
  # Hystérésis : on ne change de moitié qu'après avoir dépassé le milieu de
  # HALF_HYSTERESIS. La position courante doit être l'une des deux demi-pages
  # de cette page (sinon on vient d'ailleurs : pas de marge à conserver).
  if scrollPos >= base and scrollPos <= base + 1
    currentHalf = scrollPos - base
    if currentHalf is 0 and ratio < 0.5 + HALF_HYSTERESIS
      half = 0
    else if currentHalf is 1 and ratio > 0.5 - HALF_HYSTERESIS
      half = 1
  # Même domaine de positions que le geste manuel : entier, borné à la
  # dernière page atteignable.
  Math.max 0, Math.min maxScrollPos(), base + half

# Mémorise la page affichée et, si elle a changé, programme la cale de la tête
# de lecture. Appelé une fois par frame de défilement et après chaque saut
# explicite (setScrollPos : boutons de page, ±5, goto). Le debounce évite de
# bouger la lecture à chaque frame d'un geste de défilement.
schedulePageSeek = (page, fromScroll = false) ->
  return if lastDisplayedPage is null
  return if page is lastDisplayedPage
  # Pendant le suivi automatique, c'est followPlaybackFrame qui mémorise la
  # page visée (la page effectivement mesurée peut être en retard d'une frame) :
  # ne rien programmer ici.
  return if followSuppressSeek
  # Un événement `scroll` arrive à la frame suivante : il peut encore mesurer
  # la page d'AVANT le déplacement du suivi (SVG pas encore posé, liseuse
  # lente). Cale + suivi se renverraient alors la balle : seek vers le début de
  # la page précédente, suivi qui y revient, nouvel événement périmé, etc. —
  # la lecture recule sans fin. Pendant la lecture avec suivi actif, seul
  # applyFollowScroll pilote le défilement (il mémorise sa cible) ; une mesure
  # issue d'un `scroll` ne doit donc jamais programmer de cale. Les sauts
  # explicites (boutons, tap, goto) appellent noteDisplayedPage() sans ce
  # drapeau et restent actifs, y compris en lecture.
  return if fromScroll and followPlaybackEnabled and playback.state is "playing"
  lastDisplayedPage = page
  pageSeekPending = true
  clearTimeout pageSeekTimer if pageSeekTimer
  pageSeekTimer = setTimeout (-> seekToDisplayedPage page), pageSeekDebounceMs

# Le transport ne réagit qu'au changement de nature du mouvement affiché
# (grégorien ↔ MusicXML), pour un dossier mixte. Un changement de page dans un
# même MusicXML ne doit pas réafficher un transport masqué (données absentes ou
# erreur de lecture). La nature du premier mouvement est posée par
# loadFirstSource, en même temps que la visibilité initiale du transport.
syncTransportForDisplayedMovement = ->
  return unless fileLoaded
  mouvement = mouvementAffiche()
  return unless mouvement
  nature = if mouvement.gregorien then "gregorien" else "xml"
  return if nature is natureTransportAffichee
  natureTransportAffichee = nature
  if nature is "gregorien" then hideTransport() else showTransport()

noteDisplayedPage = (fromScroll = false) ->
  syncTransportForDisplayedMovement()
  page = displayedPage()
  # Premier affichage (ou rechargement) : simple prise de référence, sinon on
  # déplacerait la lecture au chargement sans geste de l'utilisateur.
  if lastDisplayedPage is null
    lastDisplayedPage = page
    return
  # Déplacement dû au suivi (événement `scroll` différé) : simple mise à jour,
  # aucun seek, sinon la cale ramènerait la lecture en arrière et bouclerait.
  if page is followTargetPage
    lastDisplayedPage = page
    return
  schedulePageSeek page, fromScroll

# Place la tête de lecture au temps du premier marqueur de la page affichée.
# Pendant la lecture, un saut vers une page d'un autre mouvement charge ce
# mouvement et reprend sur sa mesure : la lecture reste continue d'un mouvement
# à l'autre. À l'arrêt ou en pause, on ne charge rien ici (le prochain appui sur
# lecture partira de la page affichée).
seekToDisplayedPage = (page) ->
  pageSeekTimer = null
  pageSeekPending = false
  return unless fileLoaded
  result = getMovementForPage page
  return unless result
  # La page des marqueurs est locale au mouvement : on réutilise la conversion
  # déjà faite par getMovementForPage au lieu d'en écrire une seconde.
  unless playback.hasData and playback.movementId is result.movement.id
    if playback.state is "playing"
      switchPlaybackToMovement result.movement.id, result.localPage
    return
  marks = playback.marks
  return unless Array.isArray(marks) and marks.length
  api = window.__musicaPlayback
  return unless api?.firstMarkOfPage?
  mark = api.firstMarkOfPage marks, result.localPage
  return unless mark
  markMs = Number mark.t
  return unless isFinite markMs
  # Jamais de recul pendant la lecture : viser > 300 ms avant la position
  # courante relancerait la page précédente et la ferait boucler.
  if playback.state is "playing" and markMs < currentPlaybackPosition() - 300
    lastDisplayedPage = page
    return
  # Même en pause ou à l'arrêt : la position est mémorisée, un appui sur
  # lecture repartira du début de la page.
  seekPlayback markMs

# Suivi de partition : amène à l'écran le marqueur courant. Appelé depuis la
# boucle de lecture ; ne fait rien quand le réglage est désactivé. Une page
# absente du DOM est demandée puis réalignée à la frame suivante : l'écran
# n'est jamais vidé, la page existante reste affichée en attendant son SVG.
followPlaybackFrame = ->
  return unless followPlaybackEnabled
  # Une cale manuelle attend son debounce : ne pas la contredire en ramenant
  # l'écran sur la page de la position courante avant qu'elle s'applique.
  return if pageSeekPending
  # Pendant une pause (silence écrit), la partition ne doit pas avancer : le
  # temps continue mais aucun marqueur n'est atteint.
  timeline = window.__musicaTimeline
  if timeline?.pauseAt? and Array.isArray(playback.pauses) and playback.pauses.length
    return if timeline.pauseAt playback.pauses, currentPlaybackPosition()
  applyFollowView()

# Applique le suivi de la position courante à la vue, en une seule frame, et
# mémorise la page visée pour que les `scroll` différés ne déclenchent pas de
# cale de lecture. Partagé par la boucle de lecture et l'aperçu du glissement
# du curseur : c'est exactement la même fonction de suivi dans les deux cas.
applyFollowView = ->
  followSuppressSeek = true
  try
    target = applyFollowScroll()
    # Mémoriser la page visée, pas la page mesurée (qui peut être en retard
    # d'une frame) : les événements `scroll` différés du suivi tombent alors
    # sur la même page. Sans déplacement, on ne touche à rien, sinon un
    # changement manuel survenu avant l'événement `scroll` serait avalé.
    if target
      followTargetPage = target
      lastDisplayedPage = target
      clearTimeout pageSeekTimer if pageSeekTimer
      pageSeekTimer = null
    target
  finally
    followSuppressSeek = false

# Aperçu du défilement pendant le glissement du curseur : une mise à jour de
# la vue par frame, avec la même fonction que le suivi de lecture. La boucle
# reste vivante pendant le geste pour laisser au rendu asynchrone de la page
# cible le temps d'arriver (sinon un arrêt du doigt laisserait la vue en
# attente), mais ne fait rien quand la position visée est déjà à l'écran.
seekPreviewFrame = ->
  transportSeekRaf = null
  return unless transportSeeking and transportSeekPreview?
  applyFollowView()
  transportSeekRaf = requestAnimationFrame seekPreviewFrame if transportSeeking

scheduleSeekPreview = ->
  transportSeekRaf = requestAnimationFrame seekPreviewFrame unless transportSeekRaf?

stopSeekPreview = ->
  if transportSeekRaf?
    cancelAnimationFrame transportSeekRaf
    transportSeekRaf = null
  transportSeekPreview = null

# Interrompt seulement la boucle d'aperçu, sans oublier la position visée : le
# `change` qui suit le relâchement reste maître du seek. Évite qu'une boucle
# survive à un geste qui ne déclenche pas de `change` (valeur inchangée,
# annulation du pointeur).
cancelSeekPreviewFrame = ->
  if transportSeekRaf?
    cancelAnimationFrame transportSeekRaf
    transportSeekRaf = null

# Applique le suivi et renvoie la page globale visée, ou null si le défilement
# n'a pas bougé.
applyFollowScroll = ->
  return null unless playback.movementId?
  marks = playback.marks
  return null unless Array.isArray(marks) and marks.length
  api = window.__musicaPlayback
  return null unless api?.planFollow?
  vertical = scrollMode is "vertical"
  # Horizontal : l'id du marqueur courant (et non celui du début de page)
  # permet de choisir entre les deux demi-pages ; vertical : réglage inchangé.
  plan = api.planFollow marks, followPosition(),
    scrollUnit: if vertical then currentScrollUnit else "system"
  return null unless plan
  target = getGlobalPage playback.movementId, plan.page
  return null unless target >= 1
  slot = $("page-current")
  pageEl = slot.querySelector ".scroll-page[data-page=\"#{target}\"]"

  # Horizontal : viser la demi-page qui contient l'élément courant. Si son SVG
  # n'est pas encore rendu, replier sur le début de page puis réaligner à la
  # frame suivante (clé « pending » pour réessayer sans attendre un changement
  # de marqueur). Le déplacement passe par setScrollPos, donc reste couvert par
  # followSuppressSeek : il ne re-déclenche pas de cale de lecture.
  unless vertical
    pos = horizontalHalfPage target, plan.id
    if pos?
      return null if scrollPos is pos
      setScrollPos pos
      playback.followKey = "half:#{pos}"
    else
      pos = (target - 1) * 2
      key = "pending:#{target}"
      return null if scrollPos is pos and playback.followKey is key
      setScrollPos pos
      playback.followKey = key
    return target

  # Vertical : la page doit être rendue avant de viser un système.
  unless pageEl?.querySelector "svg"
    unless pageEl
      setScrollPos (target - 1) * 2
      playback.followKey = "pending:#{target}"
      return target
    return null

  system = null
  if currentScrollUnit is "system" and plan.id?
    element = document.getElementById plan.id
    system = element.closest("g.system") if element?.closest?
  if system
    # Même arithmétique que systemTops()/verticalTarget()
    base = slot.getBoundingClientRect().top - slot.scrollTop
    top = system.getBoundingClientRect().top - base
    return null if Math.abs(slot.scrollTop - top) <= SYSTEM_TOLERANCE
    slot.scrollTo top: Math.max(0, top), behavior: "instant"
    playback.followKey = "system:#{target}:#{plan.id}"
    target
  else
    # Sans système résoluble (id absent du SVG) : au moins la page en haut.
    key = "page:#{target}"
    return null if playback.followKey is key
    scrollToPageTop target
    playback.followKey = key
    target

# --- Surlignage de la mesure jouée -----------------------------------------
# Verovio écrit chaque mesure dans un <g class="measure" id="…"> ; les
# marqueurs de synchronisation portent cet id (`mark.id`, aussi utilisé par le
# suivi). Le rectangle de fond est inséré en premier enfant du système : il
# passe sous les notes, couvre toute la hauteur du système (portées masquées
# par condensation comprises) et suit le cadre de la mesure. Il n'est
# recalculé qu'au changement de mesure, pas à chaque frame.
measureHighlightRect = null
measureHighlightUpdates = 0

clearMeasureHighlight = ->
  playback.highlightKey = null
  if measureHighlightRect?.parentNode?
    measureHighlightRect.remove()
  measureHighlightRect = null

updateMeasureHighlight = ->
  unless highlightMeasureEnabled
    clearMeasureHighlight()
    return
  marks = playback.marks
  unless Array.isArray(marks) and marks.length
    clearMeasureHighlight()
    return
  api = window.__musicaPlayback
  mark = if api?.markAt? then api.markAt marks, followPosition() else null
  unless mark?.id?
    clearMeasureHighlight()
    return
  key = String mark.id
  return if key is playback.highlightKey and measureHighlightRect?.isConnected
  # La page de la mesure peut ne pas être encore rendue (suivi en avance sur
  # le rendu asynchrone) : garder le surlignage précédent et réessayer à la
  # frame suivante.
  element = document.getElementById key
  return unless element?
  system = element.closest? "g.system"
  return unless system?
  try
    measureBox = element.getBBox()
    systemBox = system.getBBox()
  catch
    return
  return unless measureBox.width > 0 and systemBox.height > 0
  unless measureHighlightRect?.parentNode is system
    clearMeasureHighlight()
    rect = document.createElementNS "http://www.w3.org/2000/svg", "rect"
    rect.setAttribute "class", "measure-highlight"
    rect.setAttribute "aria-hidden", "true"
    rect.setAttribute "pointer-events", "none"
    system.insertBefore rect, system.firstChild
    measureHighlightRect = rect
  rect = measureHighlightRect
  rect.setAttribute "x", String measureBox.x
  rect.setAttribute "y", String systemBox.y
  rect.setAttribute "width", String measureBox.width
  rect.setAttribute "height", String systemBox.height
  playback.highlightKey = key
  measureHighlightUpdates += 1

# Sonde de test : état du surlignage (mesure courante, rectangle, mises à jour).
window.__musicaMeasureHighlightState = ->
  rect = measureHighlightRect
  connected = rect?.isConnected is true
  {
    enabled: highlightMeasureEnabled
    key: playback.highlightKey
    updates: measureHighlightUpdates
    rect: if connected then {
      x: Number rect.getAttribute "x"
      y: Number rect.getAttribute "y"
      width: Number rect.getAttribute "width"
      height: Number rect.getAttribute "height"
    } else null
  }

# Sonde de test : marqueur de synchronisation de la position courante (mêmes
# données à l'échelle de la lecture que celles du suivi et du surlignage).
window.__musicaPlaybackCurrentMark = ->
  api = window.__musicaPlayback
  mark = if api?.markAt? then api.markAt playback.marks, currentPlaybackPosition() else null
  {
    id: mark?.id ? null
    t: mark?.t ? null
    page: mark?.page ? null
  }

# Une seule boucle rAF vivante à la fois ; rien n'est écrit dans localStorage
playbackFrame = ->
  playback.rafId = null
  return unless playback.state is "playing"
  renderTransport()
  followPlaybackFrame()
  updateMeasureHighlight()
  playback.rafId = requestAnimationFrame playbackFrame

startPlaybackFrame = ->
  cancelPlaybackFrame()
  playback.rafId = requestAnimationFrame playbackFrame

seekPlayback = (ms) ->
  duration = Math.max 0, playback.duration or 0
  value = Math.max 0, Number(ms) or 0
  value = duration if duration > 0 and value > duration
  playback.position = value
  engine = audioEngine()
  if playback.hasData and engine
    try
      engine.seek value / 1000
    catch err
      console.warn "Déplacement de lecture impossible : #{err?.message or err}"
  renderTransport()

# Libère le moteur et oublie les données chargées (changement de mouvement,
# rechargement, retour à la bibliothèque).
resetPlayback = ->
  transportSeeking = false
  stopSeekPreview()
  cancelPlaybackFrame()
  playback.loadToken++
  engine = audioEngine()
  if engine
    try
      engine.destroy()
    catch err
      console.warn "Arrêt du moteur audio impossible : #{err?.message or err}"
  playback.movementId = null
  playback.hasData = false
  playback.state = "stopped"
  playback.position = 0
  playback.duration = 0
  playback.offset = 0
  playback.sourceDuration = 0
  playback.loading = false
  playback.marks = []
  playback.pauses = []
  playback.followKey = null
  clearMeasureHighlight()
  playback.rawData = null
  playback.tempoFactor = 1
  playback.tempoBpm = null
  playback.tempoUnit = "quarter"
  renderTransport()

stopPlayback = ->
  transportSeeking = false
  stopSeekPreview()
  cancelPlaybackFrame()
  playback.loadToken++
  playback.loading = false
  engine = audioEngine()
  if engine
    try
      engine.stop()
    catch err
      console.warn "Arrêt de lecture impossible : #{err?.message or err}"
  playback.state = "stopped"
  playback.position = 0
  # Les marqueurs restent : les données de lecture sont toujours chargées
  # après un arrêt, une reprise doit pouvoir suivre immédiatement.
  playback.followKey = null
  clearMeasureHighlight()
  renderTransport()

pausePlayback = ->
  return unless playback.state is "playing"
  engine = audioEngine()
  return unless engine
  playback.position = Math.max 0, engine.position() * 1000
  try
    engine.pause()
  catch err
    console.warn "Pause impossible : #{err?.message or err}"
  playback.state = "paused"
  cancelPlaybackFrame()
  renderTransport()

beginPlayback = (engine, fromMs) ->
  try
    engine.play (fromMs or 0) / 1000
  catch err
    console.warn "Lecture impossible : #{err?.message or err}"
    playback.state = "stopped"
    hideTransport()
    renderTransport()
    return
  playback.state = "playing"
  renderTransport()
  startPlaybackFrame()

# --- Tempo de lecture -------------------------------------------------------
# Le tempo initial du fichier vient des données de lecture (worker : carte de
# tempo scoretk, indication de la première mesure du MusicXML et unité de
# battue). Le BPM est déjà exprimé dans cette unité.
fileTempoFromData = (data, movementId) ->
  bpm = Math.round Number data?.fileTempoBpm
  bpm = DEFAULT_FILE_TEMPO_BPM unless isFinite(bpm) and bpm > 0
  unit = data?.fileTempoUnit ? 'quarter'
  {bpm, explicit: data?.fileTempoExplicit is true, unit, fileId: currentFileId, movementId}

# Tempo choisi (réglage du fichier, sinon défaut du fichier : son tempo
# explicite ou 80), dans l'unité du fichier. Le facteur reste choisi / fichier
# sur la même unité.
playbackTempoPlan = (data, movementId) ->
  info = fileTempoFromData data, movementId
  chosen = if playbackTempoOverride? then playbackTempoOverride else window.__musicaTimeline.defaultPlaybackTempo(info)
  chosen = window.__musicaTimeline.clampPlaybackTempo chosen
  {
    info
    chosen
    factor: window.__musicaAudio.playbackTempoFactor(chosen, info.bpm)
  }

# Données de lecture au tempo courant. Le facteur n'est appliqué QU'ICI pour
# l'axe de sortie (durée, marqueurs, pauses) et transmis aux segments/notes :
# le moteur divise ensuite une seule fois les débuts et durées des notes, le
# temps source (from/to) restant intact. Les données brutes restent intactes
# pour le cache et pour un changement de tempo ultérieur.
scaledPlaybackFor = (data, movementId) ->
  plan = playbackTempoPlan data, movementId
  {data: window.__musicaAudio.scalePlaybackData(data, plan.factor), plan: plan}

# Applique des données de lecture brutes (worker) au moteur et à l'état, sans
# lancer la lecture. `position` est locale au mouvement ; `offset` est sa
# position absolue dans la source, pour l'affichage cumulé.
applyPlaybackData = (engine, movementId, data, position = 0) ->
  scaled = scaledPlaybackFor data, movementId
  playback.movementId = movementId
  playback.hasData = true
  playback.rawData = data
  playback.tempoFactor = scaled.plan.factor
  playback.tempoBpm = scaled.plan.chosen
  playback.tempoUnit = scaled.plan.info.unit
  playback.duration = Math.max 0, Number(scaled.data.duration) or 0
  playback.offset = scaled.data.offsetMs
  playback.sourceDuration = scaled.data.sourceDurationMs
  local = Math.max 0, Number(position) or 0
  local = Math.min local, playback.duration if playback.duration > 0
  playback.position = local
  playback.marks = scaled.data.syncMarks ? []
  playback.pauses = scaled.data.pauses ? []
  playback.followKey = null
  engine.load scaled.data
  engine.setTranspose auditoryTranspose
  applyVoiceAudio scaled.data.staffLabels
  scaled

# Position locale du premier marqueur de la page du mouvement chargé. Un saut
# vers une mesure d'un autre mouvement (ou une première lecture après un saut)
# démarre donc sur cette mesure, pas au début du mouvement.
startPositionForPage = (localPage) ->
  api = window.__musicaPlayback
  return 0 unless api?.firstMarkOfPage?
  mark = api.firstMarkOfPage playback.marks, localPage
  markMs = Number mark?.t
  if isFinite(markMs) and markMs > 0 then markMs else 0

# Charge un autre mouvement pendant la lecture et repart au premier marqueur de
# la page visée. Utilisé quand un saut de page/une navigation atteint un
# mouvement différent : la lecture continue sur cette mesure-là.
switchPlaybackToMovement = (movementId, localPage) ->
  engine = audioEngine()
  return unless engine
  token = ++playback.loadToken
  requestPlaybackData movementId
    .then (data) ->
      return unless playback.loadToken is token and playback.state is "playing"
      unless data?.midi and (Number(data.duration) or 0) > 0
        stopPlayback()
        return
      try
        applyPlaybackData engine, movementId, data
      catch err
        console.warn "Changement de mouvement impossible : #{err?.message or err}"
        stopPlayback()
        return
      beginPlayback engine, startPositionForPage localPage
    .catch (err) ->
      return unless playback.loadToken is token
      console.warn "Données de lecture du mouvement #{movementId} indisponibles : #{err?.message or err}"
      stopPlayback()

# Fin naturelle d'un mouvement : enchaîne sans pause sur le suivant de la
# partition, depuis son début. Au dernier mouvement, la lecture s'arrête.
finishPlaybackMovement = ->
  return unless playback.state is "playing"
  next = movements.find (m) -> m.id > (playback.movementId ? 0)
  if next?.loaded then switchPlaybackToMovement next.id, 0 else stopPlayback()

# Applique le tempo courant à la lecture chargée : reprend à la même position
# musicale (position de lecture × ancien facteur / nouveau facteur). Un
# changement pendant la lecture relance le moteur à cette position ; en pause
# ou à l'arrêt, seule la position est recalculée.
applyTempoToPlayback = ->
  return unless playback.hasData and playback.rawData
  engine = audioEngine()
  return unless engine
  oldFactor = playback.tempoFactor ? 1
  scorePosition = Math.max(0, currentPlaybackPosition()) * oldFactor
  state = playback.state
  # Le facteur sert d'abord à retrouver la position ; applyPlaybackData applique
  # ensuite au moteur et à l'état toutes les données remises à l'échelle.
  factor = (playbackTempoPlan playback.rawData, playback.movementId).factor
  position = if factor > 0 then scorePosition / factor else 0
  position = Math.max 0, position
  try
    applyPlaybackData engine, playback.movementId, playback.rawData, position
  catch err
    console.warn "Changement de tempo impossible : #{err?.message or err}"
    playback.state = "stopped"
    playback.hasData = false
    renderTransport()
    return
  if state is "playing"
    beginPlayback engine, playback.position
    return
  playback.state = if state is "paused" then "paused" else "stopped"
  renderTransport()

# Applique au moteur la réponse d'une demande de données de lecture, si elle
# concerne encore le mouvement affiché. Commun à la lecture et au
# préchargement. `status` vaut "ok" (données appliquées), "stale" (réponse
# périmée : chargement remplacé ou autre mouvement affiché), "empty" (aucune
# donnée exploitable) ou "error" (application au moteur impossible).
applyPlaybackReply = (engine, movementId, token, data) ->
  return {status: "stale"} unless playback.loadToken is token
  current = getMovementForPage displayedPage()
  return {status: "stale"} unless current?.movement.id is movementId
  unless data?.midi and (Number(data.duration) or 0) > 0
    return {status: "empty"}
  # Le facteur de tempo s'applique aux données avant le moteur et le suivi ;
  # les données brutes restent en cache pour un changement de tempo.
  try
    applyPlaybackData engine, movementId, data
  catch err
    playback.hasData = false
    return {status: "error", error: err}
  {status: "ok", current}

# Démarre la lecture du mouvement affiché : charge ses données de lecture au
# besoin, puis lance le moteur.
startPlayback = ->
  # Pas de lecture pour la notation carrée : aucune donnée de lecture à demander.
  return if estGregorienAffiche()
  engine = audioEngine()
  unless engine
    console.warn "Moteur audio indisponible"
    hideTransport()
    return
  result = getMovementForPage displayedPage()
  unless result
    hideTransport()
    return
  movementId = result.movement.id
  if playback.hasData and playback.movementId is movementId
    beginPlayback engine, playback.position
    return
  token = ++playback.loadToken
  playback.loading = true
  playback.state = "loading"
  renderTransport()
  requestPlaybackData movementId
    .then (data) ->
      return unless playback.loadToken is token
      outcome = applyPlaybackReply engine, movementId, token, data
      unless outcome.status is "ok"
        playback.loading = false
        playback.state = "stopped"
        renderTransport()
        if outcome.status is "empty"
          hideTransport()
          console.warn "Données de lecture vides ou incomplètes pour le mouvement #{movementId}"
        else if outcome.status is "error"
          hideTransport()
          console.warn "Chargement audio impossible : #{outcome.error?.message or outcome.error}"
        return
      playback.loading = false
      # Une lecture lancée après un saut dans un mouvement repart du premier
      # marqueur de la page affichée, pas du début du mouvement.
      beginPlayback engine, startPositionForPage(outcome.current.localPage)
    .catch (err) ->
      return unless playback.loadToken is token
      playback.loading = false
      playback.state = "stopped"
      hideTransport()
      renderTransport()
      console.warn "Données de lecture indisponibles : #{err?.message or err}"

# Demande de préchargement en cours : évite d'appliquer deux fois des données
# concurrentes pour le même mouvement.
preloadRequest = null

# Précharge les données de lecture du mouvement affiché, sans lancer la
# lecture : la barre de position et le temps total deviennent utilisables dès
# l'ouverture. Idempotent : sans effet pour un mouvement grégorien ou non
# chargé, quand les données du mouvement sont déjà là, pendant une lecture ou
# quand la même demande est déjà en vol. Un échec laisse la barre inactive et
# le transport visible.
preloadPlayback = ->
  return if estGregorienAffiche()
  return if playback.state is "playing" or playback.state is "loading" or playback.loading
  page = displayedPage()
  result = getMovementForPage page
  return unless result
  # getMovementForPage replie sur le premier mouvement chargé : ne pas
  # précharger un mouvement qui n'est pas celui de la page affichée (page d'un
  # mouvement encore en cours de chargement).
  return unless getGlobalPage(result.movement.id, result.localPage) is page
  movementId = result.movement.id
  return if playback.hasData and playback.movementId is movementId
  return if preloadRequest?.movementId is movementId and preloadRequest.token is playback.loadToken
  engine = audioEngine()
  return unless engine
  token = playback.loadToken
  request = {movementId, token}
  preloadRequest = request
  requestPlaybackData movementId
    .then (data) ->
      return unless preloadRequest is request
      preloadRequest = null
      # Un ▶ pendant la demande a pris la main (jeton changé) : il applique
      # lui-même les données, déjà dédupliquées par le cache de lecture.
      return unless playback.loadToken is token
      return unless playback.state is "stopped" and not playback.loading
      outcome = applyPlaybackReply engine, movementId, token, data
      switch outcome.status
        when "ok"
          # Une lecture avec données part de playback.position : se caler sur
          # la page affichée au moment de la réponse, comme startPlayback.
          # Le premier affichage a désormais sa référence de page : une
          # navigation ultérieure calera la lecture au lieu d'être prise pour
          # l'affichage initial.
          lastDisplayedPage = displayedPage() if lastDisplayedPage is null
          seekPlayback startPositionForPage outcome.current.localPage
        when "empty"
          console.warn "Données de lecture vides ou incomplètes pour le mouvement #{movementId} (préchargement)"
        when "error"
          # Aucune donnée partielle ne doit rester dans l'état : la barre
          # redevient inactive, le transport reste visible.
          resetPlayback()
          console.warn "Préchargement audio impossible : #{outcome.error?.message or outcome.error}"
    .catch (err) ->
      preloadRequest = null if preloadRequest is request
      return unless playback.loadToken is token
      console.warn "Préchargement des données de lecture indisponible : #{err?.message or err}"

togglePlayPause = ->
  return if playback.loading
  if playback.state is "playing"
    pausePlayback()
  else
    startPlayback()

# Sonde de test : état du transport audio
window.__musicaPlaybackState = ->
  engine = audioEngine()
  {
    state: playback.state
    movementId: playback.movementId
    # Position et durée locales au mouvement (domaine du moteur) ; la position
    # et la durée affichées sont cumulées sur la source.
    position: Math.round currentPlaybackPosition()
    duration: Math.round playback.duration or 0
    offset: Math.round playback.offset or 0
    displayPosition: Math.round displayPosition()
    sourceDuration: Math.round displayDuration()
    engine: if engine?.getEngineMode? then engine.getEngineMode() else null
    hasData: playback.hasData
    tempo: playback.tempoBpm
    fileTempo: fileTempo?.bpm ? null
    tempoUnit: playback.tempoUnit
    tempoFactor: playback.tempoFactor
  }

# Raccourci clavier : ne pas voler une touche saisie dans un champ, ni agir
# quand l'overlay de réglages est ouvert.
isFormField = (el) ->
  return false unless el
  tag = (el.tagName or "").toLowerCase()
  tag in ["input", "select", "textarea"] or el.isContentEditable is true

setupTransport = ->
  $("transport-play")?.addEventListener "click", togglePlayPause

  # Barre de position : le libellé suit le glissement, le moteur ne bouge
  # qu'au relâchement (change), y compris au clavier (flèches).
  seek = $("transport-seek")
  seek?.addEventListener "pointerdown", -> transportSeeking = true
  # Relâchement : le `change` qui suit applique le seek ; seule la boucle de
  # frames est arrêtée ici (geste sans changement de valeur, pointeur annulé).
  seek?.addEventListener "pointerup", -> cancelSeekPreviewFrame()
  seek?.addEventListener "pointercancel", ->
    transportSeeking = false
    stopSeekPreview()
    renderTransport()
  seek?.addEventListener "input", ->
    transportSeeking = true
    duration = Math.max 0, playback.duration or 0
    time = $("transport-time")
    if duration > 0
      value = Math.max 0, Math.min 1000, Number(seek.value) or 0
      preview = value / 1000 * duration
      # Avec « Suivre le défilement », la vue suit le doigt dès le glissé, par
      # la même fonction que le suivi de lecture (une frame au plus). Le geste
      # prime sur une cale de page encore en attente.
      if followPlaybackEnabled
        pageSeekPending = false
        if pageSeekTimer
          clearTimeout pageSeekTimer
          pageSeekTimer = null
        transportSeekPreview = preview
        scheduleSeekPreview()
      if time
        position = (Number(playback.offset) or 0) + preview
        time.textContent = "#{formatTime position} / #{formatTime displayDuration()}"
  seek?.addEventListener "change", ->
    transportSeeking = false
    stopSeekPreview()
    duration = Math.max 0, playback.duration or 0
    if duration > 0
      value = Math.max 0, Math.min 1000, Number(seek.value) or 0
      seekPlayback value / 1000 * duration
      # La position de lecture vient de changer : aligner la vue sur elle,
      # comme le fait la boucle de lecture (utile à l'arrêt, où elle ne tourne
      # pas, et pour rattraper la dernière frame du geste).
      applyFollowView() if followPlaybackEnabled and playback.hasData
    renderTransport()
  seek?.addEventListener "blur", ->
    hadPreview = transportSeekPreview?
    transportSeeking = false
    stopSeekPreview()
    # Geste interrompu sans `change` : la lecture n'a pas bougé, la vue revient
    # donc sur la tête de lecture.
    applyFollowView() if hadPreview and followPlaybackEnabled and playback.hasData
    renderTransport()

  engine = audioEngine()
  engine?.onEnd ->
    # Un mouvement se termine : enchaîner sur le suivant sans arrêter la
    # lecture (le suivi continue sur ses marqueurs).
    finishPlaybackMovement()

  document.addEventListener "keydown", (e) ->
    return unless fileLoaded
    return if e.ctrlKey or e.metaKey or e.altKey
    return if isFormField e.target
    return unless $("settings-overlay").classList.contains "hidden"
    switch e.key.toLowerCase()
      when "p"
        e.preventDefault()
        togglePlayPause()
      when "s"
        e.preventDefault()
        stopPlayback()

# Get movement and local page from global page number
