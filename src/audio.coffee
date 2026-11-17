# audio.coffee — Moteur audio WebAudio pour l'aperçu des partitions.
#
# API exposée (window.__musicaAudio dans le navigateur, module.exports en
# CommonJS pour les tests Node) :
#   load(playbackData, options)  -> objet normalisé (MIDI analysé une fois)
#   play(fromSeconds = 0)        -> démarre ou redémarre
#   pause()                      -> suspend et conserve la position
#   stop()                       -> arrête et revient au début
#   seek(seconds)
#   position()                   -> secondes écoulées
#   isPlaying()
#   onEnd(cb)
#   setMasterVolume(v)           -> 0..100
#   setVoiceVolume(label, v)     -> 0..100, par libellé de voix
#   setVoiceMuted(label, m)      -> true : silence réel
#   getVoiceGain(label)          -> gain courant du GainNode de la voix (ou null)
#   resume()                     -> reprend l'AudioContext (politique autoplay)
#   destroy()
#
# Les dépendances du navigateur (window.__musicaMidi, window.Soundfont et
# l'asset window.MIDI.Soundfont.acoustic_grand_piano) sont lues paresseusement
# au premier play() : en build normal l'asset est chargé en defer et peut ne
# pas encore être disponible quand ce fichier est évalué.
#
# Graphe : GainNode par piste MIDI -> GainNode par voix (libellé) -> masterGain
# -> destination. Les pistes absentes de trackMap sont rattachées directement
# au master pour ne jamais les perdre.

FLOOR = 0.01            # plancher du curseur de volume (≈ −40 dB)
DEFAULT_VOLUME = 100
SCHEDULE_INTERVAL = 25  # ms, période de l'ordonnanceur à anticipation
SCHEDULE_WINDOW = 0.150 # s, fenêtre de notes planifiées d'avance
MAX_VOICES = 64         # plafond de sources simultanées
SOUNDFONT_TIMEOUT = 1500 # ms avant bascule vers la synthèse de repli
FALLBACK_ATTACK = 0.01
FALLBACK_DECAY = 0.07
FALLBACK_SUSTAIN = 0.7
FALLBACK_RELEASE = 0.15
DEFAULT_INSTRUMENT = 'acoustic_grand_piano'
SOUNDFONT_FILE = 'soundfonts/piano-fluidr3-13notes.js'

# --- Logique pure (testable sans AudioContext) ------------------------------

clampVolume = (volume) ->
  value = Number volume
  value = DEFAULT_VOLUME unless isFinite value
  Math.min 100, Math.max 1, value

# EXIGENCE : le curseur de volume ne doit JAMAIS couper totalement le son.
# On mappe donc [1, 100] sur [FLOOR, 1] : à 1 % le gain vaut encore 0,0199
# (≈ −34 dB), à 100 % il vaut 1. Seul setVoiceMuted() coupe vraiment.
volumeToGain = (volume) ->
  value = clampVolume volume
  FLOOR + (1 - FLOOR) * (value / 100)

# Gain effectif d'une voix : le plancher ne s'applique qu'au réglage de volume,
# un masquage explicite vaut un vrai zéro.
voiceGainValue = (volume, muted) ->
  return 0 if muted
  volumeToGain volume

# Résout le mapping playbackData.trackMap (libellé -> indices de pistes) en
# deux tables : par piste et par libellé (sans doublons, entrées invalides
# ignorées).
resolveTrackMap = (trackMap) ->
  byTrack = {}
  byLabel = {}
  for own label, indices of (trackMap ? {})
    continue unless Array.isArray indices
    list = []
    for raw in indices
      index = Number raw
      continue unless isFinite(index) and index >= 0
      byTrack[index] = label
      list.push index unless index in list
    byLabel[label] = list
  {byTrack, byLabel}

# Échantillon le plus proche d'une hauteur MIDI. Le sous-ensemble FluidR3 ne
# contient qu'une note tous les 4 demi-tons : on choisit le buffer voisin et on
# corrige la hauteur par playbackRate, au lieu de chercher une note exacte.
nearestSampleKey = (buffers, pitch) ->
  return null unless buffers?
  target = Number pitch
  return null unless isFinite target
  keys = []
  for own key of buffers
    value = Number key
    keys.push value if isFinite value
  return null unless keys.length
  best = keys[0]
  for key in keys[1..]
    if Math.abs(key - target) < Math.abs(best - target)
      best = key
  best

samplePlaybackRate = (sampleKey, pitch) ->
  2 ** ((Number(pitch) - Number(sampleKey)) / 12)

# Première note dont le début est >= time (recherche binaire ; notes triées).
noteIndexAt = (notes, time) ->
  return 0 unless Array.isArray(notes) and notes.length
  lo = 0
  hi = notes.length
  while lo < hi
    mid = (lo + hi) >> 1
    if (notes[mid].start ? 0) < time then lo = mid + 1 else hi = mid
  lo

# Bloc de notes à planifier : à partir de index, toutes celles qui commencent
# avant toTime, en ne retenant que celles qui commencent à/après fromTime.
# Retourne aussi l'index de reprise pour l'ordonnanceur.
notesToSchedule = (notes, index, fromTime, toTime) ->
  out = []
  i = index ? 0
  i = 0 if i < 0
  while i < notes.length and (notes[i].start ? 0) < toTime
    note = notes[i]
    out.push note if (note.start ? 0) >= fromTime
    i += 1
  {notes: out, nextIndex: i}

# Analyse le MIDI une seule fois et normalise les notes en secondes, avec
# l'indice de piste de chacune.
normalizePlaybackData = (data, parser) ->
  throw new Error "Données de lecture absentes" unless data
  throw new Error "Parseur MIDI indisponible" unless parser
  midi = if typeof data.midi is 'string' then parser.parseBase64(data.midi) else parser.parse(data.midi)
  tracks = midi.tracks ? []
  notes = []
  lastEnd = 0
  for track in tracks
    index = track.index ? tracks.indexOf track
    for note in (track.notes ? [])
      start = Number note.start
      continue unless isFinite start
      duration = Number note.dur
      duration = 0 unless isFinite(duration) and duration > 0
      pitch = Number note.pitch
      continue unless isFinite pitch
      velocity = Number note.velocity
      velocity = 100 unless isFinite velocity
      notes.push {start, dur: duration, pitch, velocity, track: index}
      end = start + duration
      lastEnd = end if end > lastEnd
  notes.sort (a, b) -> (a.start - b.start) or (a.pitch - b.pitch)
  durationMs = Number data.duration
  duration = if isFinite(durationMs) and durationMs > 0 then durationMs / 1000 else 0
  # La durée du timemap fait foi ; on ne descend jamais sous la fin réelle du
  # MIDI ni sous la dernière note, pour ne pas tronquer la lecture.
  duration = Math.max duration, Number(midi.duration) or 0, lastEnd
  {
    midi
    tracks
    notes
    duration
    trackMap: resolveTrackMap data.trackMap
    syncMarks: data.syncMarks ? []
    staffLabels: data.staffLabels ? []
  }

# --- Moteur ----------------------------------------------------------------

createEngine = (initialOptions = {}) ->
  state =
    options: {engine: initialOptions.engine ? 'auto'}
    ctx: null
    masterGain: null
    voiceGains: {}
    trackGains: {}
    soundfont: null
    enginePromise: null
    engineMode: null
    loaded: false
    tracks: []
    notes: []
    duration: 0
    trackMap: {byTrack: {}, byLabel: {}}
    syncMarks: []
    staffLabels: []
    position: 0
    startCtxTime: 0
    noteIndex: 0
    playing: false
    timer: null
    sources: []
    masterVolume: DEFAULT_VOLUME
    voiceVolumes: {}
    voiceMuted: {}
    onEndCb: null

  api = {}

  disconnectGraph = ->
    node.disconnect() for node in state.sources when node?.disconnect
    state.sources = []
    for own key, gain of state.voiceGains
      gain.disconnect()
    for own key, gain of state.trackGains
      gain.disconnect()
    state.voiceGains = {}
    state.trackGains = {}
    state.masterGain?.disconnect()
    state.masterGain = null

  buildGraph = ->
    ctx = state.ctx
    return unless ctx
    # Les anciens nœuds sont d'abord détachés : recharger un mouvement ne
    # laisse pas traîner de gains orphelins.
    for own key, gain of state.voiceGains
      gain.disconnect()
    for own key, gain of state.trackGains
      gain.disconnect()
    state.voiceGains = {}
    state.trackGains = {}
    state.masterGain.gain.value = volumeToGain state.masterVolume
    for own label, indices of state.trackMap.byLabel
      gain = ctx.createGain()
      gain.gain.value = voiceGainValue(state.voiceVolumes[label] ? DEFAULT_VOLUME, state.voiceMuted[label] ? false)
      gain.connect state.masterGain
      state.voiceGains[label] = gain
    for track in state.tracks
      gain = ctx.createGain()
      gain.gain.value = 1
      label = state.trackMap.byTrack[track.index]
      destination = if label? and state.voiceGains[label] then state.voiceGains[label] else state.masterGain
      gain.connect destination
      state.trackGains[track.index] = gain

  ensureContext = ->
    return state.ctx if state.ctx
    Context = window?.AudioContext ? window?.webkitAudioContext
    throw new Error "WebAudio indisponible dans ce navigateur" unless Context
    ctx = new Context {latencyHint: 'playback'}
    master = ctx.createGain()
    master.gain.value = volumeToGain state.masterVolume
    master.connect ctx.destination
    state.ctx = ctx
    state.masterGain = master
    buildGraph()
    ctx

  resetEngine = ->
    state.soundfont = null
    state.enginePromise = null
    state.engineMode = null

  clampTime = (seconds) ->
    value = Number seconds
    value = 0 unless isFinite value
    value = 0 if value < 0
    value = state.duration if state.duration > 0 and value > state.duration
    value

  # Source MIDI.js relue par soundfont-player. L'asset est déjà en mémoire
  # (build normal : script defer ; SPA : script inliné) : on le sérialise en
  # data: URL terminée par « //.js », ce qui évite tout accès réseau et tout
  # blob à révoquer. Le « //.js » final est un commentaire JS inerte qui sert
  # seulement à ce que le chargeur reconnaisse un fichier .js.
  soundfontSource = (asset) ->
    return SOUNDFONT_FILE unless asset
    try
      json = JSON.stringify asset
      # Virgule finale : midiJsToJson coupe au dernier « , » puis ajoute « } ».
      body = "MIDI.Soundfont.#{DEFAULT_INSTRUMENT} = #{json.slice(0, -1)},;//.js"
      "data:application/javascript,#{encodeURIComponent body}"
    catch
      SOUNDFONT_FILE

  # Charge l'instrument UNE SEULE FOIS, quel que soit le nombre de pistes.
  # Les buffers décodés sont ensuite partagés par toutes les pistes ; le
  # routage se fait note par note vers le GainNode de piste puis de voix.
  loadSoundfont = (ctx) ->
    tracks = (track for track in state.tracks when track.notes?.length)
    return Promise.resolve(null) unless tracks.length
    asset = window?.MIDI?.Soundfont?[DEFAULT_INSTRUMENT]
    soundfont = window?.Soundfont
    # Asset absent (build sans échantillons, ou premier lancement hors ligne
    # sans précache) : repli immédiat sur l'oscillateur, sans requête réseau.
    return Promise.resolve(null) unless asset and soundfont?.instrument
    source = soundfontSource asset
    loading = soundfont.instrument ctx, source,
      isSoundfontURL: -> true
      destination: state.masterGain
    .then (instrument) ->
      return null unless instrument?.buffers and Object.keys(instrument.buffers).length
      instrument
    # La bascule doit être rapide et transparente : au-delà du délai, on
    # n'attend plus les échantillons et on joue avec l'oscillateur.
    new Promise (resolve) ->
      settled = false
      timer = setTimeout (->
        return if settled
        settled = true
        resolve null
      ), SOUNDFONT_TIMEOUT
      loading.then (instrument) ->
        return if settled
        settled = true
        clearTimeout timer
        resolve instrument
      .catch ->
        return if settled
        settled = true
        clearTimeout timer
        resolve null

  ensureEngine = ->
    return state.enginePromise if state.enginePromise
    if state.options.engine is 'oscillator'
      state.engineMode = 'oscillator'
      state.enginePromise = Promise.resolve null
      return state.enginePromise
    unless window?.Soundfont
      state.engineMode = 'oscillator'
      state.enginePromise = Promise.resolve null
      return state.enginePromise
    ctx = state.ctx
    state.enginePromise = loadSoundfont(ctx).then (soundfont) ->
      if soundfont
        state.soundfont = soundfont
        state.engineMode = 'soundfont'
      else
        state.soundfont = null
        state.engineMode = 'oscillator'
      state.engineMode
    .catch ->
      state.soundfont = null
      state.engineMode = 'oscillator'
      null
    state.enginePromise

  removeSource = (source) ->
    index = state.sources.indexOf source
    state.sources.splice index, 1 if index >= 0

  cancelSources = ->
    ctx = state.ctx
    now = if ctx then ctx.currentTime else 0
    for source in state.sources.slice()
      try
        if source.kind is 'oscillator'
          source.gain.gain.cancelScheduledValues now
          source.gain.gain.setValueAtTime 0, now
          source.osc.stop now
        else if source.node?.stop
          source.node.stop now
      catch
        null
    state.sources = []

  trackDestination = (trackIndex) ->
    state.trackGains[trackIndex] ? state.masterGain

  playOscillator = (note, at) ->
    ctx = state.ctx
    return unless ctx
    osc = ctx.createOscillator()
    gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = 440 * Math.pow(2, (note.pitch - 69) / 12)
    # velocity/127 en amplitude, avec un peu de marge pour éviter la saturation
    peak = (Math.min(127, Math.max(0, note.velocity)) / 127) * 0.25
    end = at + Math.max(0.05, note.dur)
    gain.gain.setValueAtTime 0, at
    gain.gain.linearRampToValueAtTime peak, at + FALLBACK_ATTACK
    gain.gain.linearRampToValueAtTime peak * FALLBACK_SUSTAIN, at + FALLBACK_ATTACK + FALLBACK_DECAY
    gain.gain.setValueAtTime peak * FALLBACK_SUSTAIN, end
    gain.gain.exponentialRampToValueAtTime 0.0001, end + FALLBACK_RELEASE
    osc.connect gain
    gain.connect trackDestination(note.track)
    source = {kind: 'oscillator', osc, gain}
    state.sources.push source
    osc.onended = ->
      removeSource source
      try
        gain.disconnect()
      catch
        null
    osc.start at
    osc.stop end + FALLBACK_RELEASE + 0.01

  # Joue un buffer du soundfont partagé vers la piste de la note. Retourne
  # false si aucun échantillon n'est disponible (repli oscillateur).
  playSoundfont = (note, at) ->
    ctx = state.ctx
    buffers = state.soundfont?.buffers
    return false unless ctx and buffers
    sampleKey = nearestSampleKey buffers, note.pitch
    return false unless sampleKey?
    buffer = buffers[sampleKey] ? buffers["#{sampleKey}"]
    return false unless buffer
    sourceNode = ctx.createBufferSource()
    gain = ctx.createGain()
    source = {kind: 'soundfont', node: sourceNode, gain}
    try
      sourceNode.buffer = buffer
      sourceNode.playbackRate.value = samplePlaybackRate sampleKey, note.pitch
      peak = (Math.min(127, Math.max(0, note.velocity)) / 127) * 0.6
      end = at + Math.max(0.05, note.dur)
      gain.gain.setValueAtTime 0, at
      gain.gain.linearRampToValueAtTime peak, at + FALLBACK_ATTACK
      gain.gain.linearRampToValueAtTime peak * FALLBACK_SUSTAIN, at + FALLBACK_ATTACK + FALLBACK_DECAY
      gain.gain.setValueAtTime peak * FALLBACK_SUSTAIN, end
      gain.gain.exponentialRampToValueAtTime 0.0001, end + FALLBACK_RELEASE
      sourceNode.connect gain
      gain.connect trackDestination(note.track)
      sourceNode.onended = ->
        removeSource source
        try
          gain.disconnect()
        catch
          null
      sourceNode.start at
      sourceNode.stop end + FALLBACK_RELEASE + 0.01
      state.sources.push source
      true
    catch
      try
        gain.disconnect()
      catch
        null
      false

  scheduleNote = (note, at) ->
    return if state.sources.length >= MAX_VOICES
    return if state.engineMode is 'soundfont' and playSoundfont note, at
    playOscillator note, at

  clearTimer = ->
    if state.timer?
      clearInterval state.timer
      state.timer = null

  finish = ->
    return unless state.playing
    state.playing = false
    state.position = state.duration
    clearTimer()
    cancelSources()
    callback = state.onEndCb
    callback? state.position

  tick = ->
    return unless state.playing and state.ctx
    ctx = state.ctx
    now = ctx.currentTime
    current = now - state.startCtxTime
    return if current < 0
    horizon = current + SCHEDULE_WINDOW
    while state.noteIndex < state.notes.length and (state.notes[state.noteIndex].start ? 0) < horizon
      note = state.notes[state.noteIndex]
      state.noteIndex += 1
      continue if (note.start ? 0) < current - 0.05
      at = state.startCtxTime + note.start
      at = now if at < now
      scheduleNote note, at
    if state.duration > 0 and current >= state.duration
      finish()

  startTimer = ->
    clearTimer()
    state.timer = setInterval tick, SCHEDULE_INTERVAL
    tick()

  api.resume = ->
    return Promise.resolve() unless state.ctx
    return Promise.resolve() if state.ctx.state isnt 'suspended'
    state.ctx.resume()

  api.load = (playbackData, options = {}) ->
    api.stop()
    for own key, value of options
      state.options[key] = value
    parser = window?.__musicaMidi
    normalized = normalizePlaybackData playbackData, parser
    state.tracks = normalized.tracks
    state.notes = normalized.notes
    state.duration = normalized.duration
    state.trackMap = normalized.trackMap
    state.syncMarks = normalized.syncMarks
    state.staffLabels = normalized.staffLabels
    state.loaded = true
    state.position = 0
    state.noteIndex = 0
    resetEngine()
    buildGraph() if state.ctx
    normalized

  api.play = (fromSeconds = 0, options = {}) ->
    throw new Error "Aucune donnée de lecture chargée" unless state.loaded
    if options.engine? and options.engine isnt state.options.engine
      state.options.engine = options.engine
      state.soundfont = null
      state.enginePromise = null
      state.engineMode = null
    ctx = ensureContext()
    api.resume()
    cancelSources()
    state.noteIndex = 0
    from = Number fromSeconds
    from = 0 unless isFinite from
    from = clampTime from
    state.position = from
    state.startCtxTime = ctx.currentTime - from
    state.noteIndex = noteIndexAt state.notes, from
    state.playing = true
    ensureEngine()
    startTimer()
    api

  api.pause = ->
    return api unless state.playing
    state.position = clampTime api.position()
    state.playing = false
    clearTimer()
    cancelSources()
    api

  api.stop = ->
    state.playing = false
    clearTimer()
    cancelSources()
    state.position = 0
    state.noteIndex = 0
    api

  api.seek = (seconds) ->
    value = clampTime seconds
    state.position = value
    state.noteIndex = noteIndexAt state.notes, value
    if state.playing and state.ctx
      cancelSources()
      state.startCtxTime = state.ctx.currentTime - value
    api

  api.position = ->
    return state.position unless state.playing and state.ctx
    Math.max 0, state.ctx.currentTime - state.startCtxTime

  api.isPlaying = -> state.playing

  # Diagnostic : 'soundfont', 'oscillator' ou null tant que rien n'est chargé
  api.getEngineMode = -> state.engineMode

  api.onEnd = (callback) ->
    state.onEndCb = callback
    api

  api.setMasterVolume = (volume) ->
    state.masterVolume = clampVolume volume
    if state.masterGain and state.ctx
      state.masterGain.gain.setTargetAtTime volumeToGain(state.masterVolume), state.ctx.currentTime, 0.01
    api

  api.setVoiceVolume = (label, volume) ->
    return api unless label?
    state.voiceVolumes[label] = clampVolume volume
    gain = state.voiceGains[label]
    if gain and state.ctx
      gain.gain.setTargetAtTime voiceGainValue(state.voiceVolumes[label], state.voiceMuted[label] ? false), state.ctx.currentTime, 0.01
    api

  # Diagnostic / tests : valeur courante du GainNode d'une voix, null si le
  # libellé n'a pas de piste dans le mouvement chargé.
  api.getVoiceGain = (label) ->
    gain = state.voiceGains[label]
    return null unless gain?
    Number gain.gain.value

  api.setVoiceMuted = (label, muted) ->
    return api unless label?
    state.voiceMuted[label] = !!muted
    gain = state.voiceGains[label]
    if gain and state.ctx
      gain.gain.setTargetAtTime voiceGainValue(state.voiceVolumes[label] ? DEFAULT_VOLUME, state.voiceMuted[label]), state.ctx.currentTime, 0.01
    api

  api.destroy = ->
    api.stop()
    disconnectGraph()
    if state.ctx
      ctx = state.ctx
      state.ctx = null
      ctx.close?().catch? -> null
    state.soundfont = null
    state.enginePromise = null
    state.engineMode = null
    state.loaded = false
    api

  # Exposé pour les tests purs et les intégrations avancées
  api.volumeToGain = volumeToGain
  api.voiceGainValue = voiceGainValue
  api.clampVolume = clampVolume
  api.resolveTrackMap = resolveTrackMap
  api.nearestSampleKey = nearestSampleKey
  api.samplePlaybackRate = samplePlaybackRate
  api.noteIndexAt = noteIndexAt
  api.notesToSchedule = notesToSchedule
  api.FLOOR = FLOOR
  api

api = createEngine()
api.createEngine = createEngine
api.normalizePlaybackData = normalizePlaybackData

window.__musicaAudio = api if typeof window isnt 'undefined'
module.exports = api if typeof module isnt 'undefined' and module.exports?
