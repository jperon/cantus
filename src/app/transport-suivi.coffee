# Transport audio (lecture, pause, arrêt, progression, volume, raccourcis) et
# suivi du défilement sur la tête de lecture pendant la lecture.
# --- Transport audio (lot 1) ---------------------------------------------
# Lecture/pause, arrêt, progression et volume général. Aucune synchronisation
# de défilement ni volume par voix ici : ces lots viendront ensuite.

audioEngine = -> window.__musicaAudio

formatTime = (ms) ->
  total = Math.max 0, Math.round((Number(ms) or 0) / 1000)
  minutes = Math.floor total / 60
  seconds = total % 60
  "#{minutes}:#{if seconds < 10 then "0#{seconds}" else seconds}"

showTransport = ->
  el = $("transport")
  el?.classList.remove "hidden"

hideTransport = ->
  el = $("transport")
  el?.classList.add "hidden"

# Position affichée : le moteur fait foi pendant la lecture
currentPlaybackPosition = ->
  return playback.position unless playback.state is "playing"
  engine = audioEngine()
  return playback.position unless engine
  Math.max 0, engine.position() * 1000

renderTransport = ->
  time = $("transport-time")
  playBtn = $("transport-play")
  duration = Math.max 0, playback.duration or 0
  rawPosition = currentPlaybackPosition()
  position = Math.max 0, rawPosition
  position = Math.min position, duration if duration > 0
  playback.position = position
  playing = playback.state is "playing"
  loading = playback.state is "loading"
  time.textContent = "#{formatTime position} / #{formatTime duration}" if time
  if playBtn
    playBtn.textContent = if playing then "❚❚" else "▶"
    playBtn.setAttribute "aria-label", if playing then "Pause" else "Lecture"
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

noteDisplayedPage = (fromScroll = false) ->
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
# Les données de lecture ne sont jamais demandées ici : sans données déjà
# chargées pour le mouvement affiché, on ne fait rien (un chargement implicite
# serait coûteux et surprenant ; le prochain appui sur lecture s'en charge).
seekToDisplayedPage = (page) ->
  pageSeekTimer = null
  pageSeekPending = false
  return unless fileLoaded
  result = getMovementForPage page
  return unless result
  # La page des marqueurs est locale au mouvement : on réutilise la conversion
  # déjà faite par getMovementForPage au lieu d'en écrire une seconde.
  return unless playback.hasData and playback.movementId is result.movement.id
  marks = playback.marks
  return unless Array.isArray(marks) and marks.length
  api = window.__musicaPlayback
  return unless api?.firstMarkOfPage?
  mark = api.firstMarkOfPage marks, result.localPage
  return unless mark
  t = Number mark.t
  return unless isFinite t
  # Jamais de recul pendant la lecture : viser > 300 ms avant la position
  # courante relancerait la page précédente et la ferait boucler.
  if playback.state is "playing" and t < currentPlaybackPosition() - 300
    lastDisplayedPage = page
    return
  # Même en pause ou à l'arrêt : la position est mémorisée, un appui sur
  # lecture repartira du début de la page.
  seekPlayback t

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
  finally
    followSuppressSeek = false

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
  plan = api.planFollow marks, currentPlaybackPosition(),
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

# Une seule boucle rAF vivante à la fois ; rien n'est écrit dans localStorage
playbackFrame = ->
  playback.rafId = null
  return unless playback.state is "playing"
  renderTransport()
  followPlaybackFrame()
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
  playback.loading = false
  playback.marks = []
  playback.pauses = []
  playback.followKey = null
  playback.rawData = null
  playback.tempoFactor = 1
  playback.tempoBpm = null
  playback.tempoUnit = "quarter"
  renderTransport()

stopPlayback = ->
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
  scaled = scaledPlaybackFor playback.rawData, playback.movementId
  factor = scaled.plan.factor
  duration = Math.max 0, Number(scaled.data.duration) or 0
  position = if factor > 0 then scorePosition / factor else 0
  position = Math.max 0, position
  position = Math.min position, duration if duration > 0
  fileTempo = scaled.plan.info
  playback.tempoFactor = factor
  playback.tempoBpm = scaled.plan.chosen
  playback.tempoUnit = scaled.plan.info.unit
  playback.duration = duration
  playback.marks = scaled.data.syncMarks ? []
  playback.pauses = scaled.data.pauses ? []
  playback.position = position
  try
    engine.load scaled.data
    applyVoiceAudio scaled.data.staffLabels
  catch err
    console.warn "Changement de tempo impossible : #{err?.message or err}"
    playback.state = "stopped"
    playback.hasData = false
    renderTransport()
    return
  if state is "playing"
    beginPlayback engine, position
    return
  playback.state = if state is "paused" then "paused" else "stopped"
  renderTransport()

# Démarre la lecture du mouvement affiché : charge ses données de lecture au
# besoin, puis lance le moteur.
startPlayback = ->
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
      unless data?.midi and (Number(data.duration) or 0) > 0
        playback.loading = false
        playback.state = "stopped"
        hideTransport()
        renderTransport()
        console.warn "Données de lecture vides ou incomplètes pour le mouvement #{movementId}"
        return
      current = getMovementForPage displayedPage()
      unless current?.movement.id is movementId
        playback.loading = false
        playback.state = "stopped"
        renderTransport()
        return
      playback.loading = false
      playback.movementId = movementId
      playback.hasData = true
      # Le facteur de tempo s'applique aux données avant le moteur et le suivi ;
      # les données brutes restent en cache pour un changement de tempo.
      scaled = scaledPlaybackFor data, movementId
      fileTempo = scaled.plan.info
      playback.rawData = data
      playback.tempoFactor = scaled.plan.factor
      playback.tempoBpm = scaled.plan.chosen
      playback.tempoUnit = scaled.plan.info.unit
      playback.duration = Math.max 0, Number(scaled.data.duration) or 0
      playback.position = 0
      playback.marks = scaled.data.syncMarks ? []
      playback.pauses = scaled.data.pauses ? []
      playback.followKey = null
      try
        engine.load scaled.data
        applyVoiceAudio scaled.data.staffLabels
      catch err
        playback.hasData = false
        playback.state = "stopped"
        hideTransport()
        renderTransport()
        console.warn "Chargement audio impossible : #{err?.message or err}"
        return
      beginPlayback engine, 0
    .catch (err) ->
      return unless playback.loadToken is token
      playback.loading = false
      playback.state = "stopped"
      hideTransport()
      renderTransport()
      console.warn "Données de lecture indisponibles : #{err?.message or err}"

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
    position: Math.round currentPlaybackPosition()
    duration: Math.round playback.duration or 0
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
  $("transport-stop")?.addEventListener "click", stopPlayback

  # Clic sur le libellé de temps : seek proportionnel à la position du clic
  # (seul moyen de déplacement fin ; la barre de progression a été retirée).
  time = $("transport-time")
  time?.addEventListener "click", (e) ->
    duration = Math.max 0, playback.duration or 0
    return unless duration > 0
    rect = time.getBoundingClientRect()
    ratio = if rect.width > 0 then (e.clientX - rect.left) / rect.width else 0
    seekPlayback Math.max(0, Math.min(1, ratio)) * duration

  engine = audioEngine()
  engine?.onEnd ->
    playback.state = "stopped"
    playback.position = 0
    cancelPlaybackFrame()
    renderTransport()

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
