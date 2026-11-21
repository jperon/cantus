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
#   setTranspose(semitones)      -> décalage des hauteurs jouées (percussions exclues)
#   setVoiceVolume(label, v)     -> 0..100, par libellé de voix (défaut 50)
#   setVoiceMuted(label, m)      -> true : silence réel
#   setVoiceProgram(label, p)    -> programme GM 0..127 de la voix, null = celui
#                                   de la partition ; appliqué par programChange
#   setPianoOnly(enabled)        -> force le programme 0 sur les voix mélodiques
#                                   (la batterie garde le sien), sans effacer les
#                                   choix par voix
#   getChannelAssignments()      -> diagnostic : canaux, programmes effectifs
#   getVoiceGain(label)          -> gain courant du GainNode de la voix (ou null)
#   resume()                     -> reprend l'AudioContext (politique autoplay)
#   destroy()
#
# Le programme effectif d'une piste est calculé par effectiveTrackProgram :
# batterie inchangée, sinon 0 quand pianoOnly est actif, sinon le choix de la
# voix, sinon le programme de la partition (0 à défaut).
#
# Les dépendances du navigateur (window.__musicaMidi, window.__musicaSpessa et
# la soundfont) sont préchargées en tâche de fond dès load(), qui crée aussi
# l'AudioContext (suspendu tant qu'aucun geste utilisateur ne le reprend). Le
# premier play() attend que le moteur soit prêt et ne le recharge jamais. Le
# synthétiseur
# SpessaSynth (spessasynth_lib) est embarqué par build.js ; le fichier SF3 est
# servi depuis soundfonts/ (build normal) ou inliné en base64 (SPA), et le
# processeur AudioWorklet depuis soundfonts/ (build normal) ou inliné (SPA).
#
# Graphe : sortie de canal SpessaSynth -> GainNode par piste -> GainNode par
# voix (libellé) -> masterGain -> destination. Une piste sans canal (cas
# dégradé) est jouée par l'oscillateur de repli vers son GainNode de piste.
# Les pistes absentes de trackMap sont rattachées directement au master pour
# ne jamais les perdre.

FLOOR = 0.01            # plancher du curseur de volume (≈ −40 dB)
DEFAULT_VOLUME = 100    # volume général, en pourcentage du maximum
# Volume d'une voix sans réglage enregistré : la moitié du maximum, pour
# laisser de la marge au volume général (gain 0,505, ≈ −6 dB).
DEFAULT_VOICE_VOLUME = 50
SCHEDULE_INTERVAL = 25  # ms, période de l'ordonnanceur à anticipation
SCHEDULE_WINDOW = 0.150 # s, fenêtre de notes planifiées d'avance
MAX_VOICES = 64         # plafond de sources simultanées (repli oscillateur)
SOUNDFONT_TIMEOUT = 15000 # ms avant bascule vers la synthèse de repli
FALLBACK_ATTACK = 0.01
FALLBACK_DECAY = 0.07
FALLBACK_SUSTAIN = 0.7
FALLBACK_RELEASE = 0.15
DEFAULT_PROGRAM = 0     # piano acoustique GM
DRUM_CHANNEL = 9        # canal MIDI 10 (index 9) : percussion GM
# Canaux mélodiques : les 15 canaux autres que le 9. Un canal par piste, ou
# par libellé de voix quand les pistes dépassent cette capacité.
MELODIC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]
SOUNDFONT_FILE = 'soundfonts/TimGM6mb.sf3'
SPESSA_WORKLET_FILE = 'soundfonts/spessasynth_processor.min.js'
# Petite tolérance pour l'envoi des noteOff : une note est relâchée au tick où
# son échéance est atteinte (voir flushSpessaOffs).
SPESSA_DUE_EPSILON = 0.005

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
# un masquage explicite vaut un vrai zéro. Au volume par défaut de 50 %, le
# gain vaut 0,505 (≈ −6 dB), donc bien audible.
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

# Programme GM d'une piste (0 à 127). Une piste sans programChange explicite
# reçoit le piano acoustique, programme 0.
trackProgram = (track) ->
  program = Number track?.program
  return DEFAULT_PROGRAM unless isFinite program
  Math.min 127, Math.max 0, Math.floor program

# Choix d'instrument d'une voix (libellé -> programme GM). Une absence, une
# valeur non numérique ou null vaut « instrument de la partition ».
voiceProgramChoice = (programs, label) ->
  program = (programs ? {})[label]
  return null unless program?
  value = Number program
  return null unless isFinite value
  Math.min 127, Math.max 0, Math.floor value

# Programme GM effectif d'une piste. La batterie garde toujours le programme de
# sa partition (le canal 9 joue le kit GM) ; pour les autres, « piano
# seulement » prime sur le choix de la voix, qui prime sur la partition.
effectiveTrackProgram = (track, label, programs, pianoOnly) ->
  return trackProgram track if Number(track?.channel) is DRUM_CHANNEL
  return DEFAULT_PROGRAM if pianoOnly
  choice = voiceProgramChoice programs, label
  return choice if choice?
  trackProgram track

# Répartit les pistes jouées sur les canaux MIDI de SpessaSynth :
#   - une piste par canal mélodique tant qu'il y en a au plus 15 ;
#   - au-delà, un canal par libellé de voix (les pistes d'une même voix
#     partagent alors le programme de la première) ;
#   - la percussion va toujours sur le canal 9.
# `byTrack` est la table libellé par piste de resolveTrackMap. Retourne aussi
# le nombre de groupes qui n'ont pas pu obtenir leur propre canal (overflow),
# signalé par l'appelant : au-delà de 15 voix, deux voix doivent partager un
# canal et l'une des deux est jouée avec le programme de l'autre.
assignTrackChannels = (tracks, byTrack) ->
  played = (track for track in (tracks ? []) when track?.notes?.length)
  melodic = (track for track in played when Number(track.channel) isnt DRUM_CHANNEL)
  percussion = (track for track in played when Number(track.channel) is DRUM_CHANNEL)
  byTrackChannel = {}
  channels = []
  addChannel = (channel, entries, label, percussionFlag) ->
    return unless entries.length
    entries = entries.slice().sort (a, b) -> Number(a.index) - Number(b.index)
    channels.push {
      channel
      program: trackProgram entries[0]
      tracks: (Number(track.index) for track in entries)
      label: label ? null
      percussion: !!percussionFlag
    }
    byTrackChannel[Number track.index] = channel for track in entries

  if melodic.length <= MELODIC_CHANNELS.length
    for track, i in melodic
      addChannel MELODIC_CHANNELS[i], [track], (byTrack ? {})[Number(track.index)], false
  else
    groups = []
    index = {}
    for track in melodic
      trackIndex = Number track.index
      label = (byTrack ? {})[trackIndex]
      key = if label? then "label:#{label}" else "track:#{trackIndex}"
      unless index[key]?
        index[key] = {entries: [], label: label ? null}
        groups.push index[key]
      index[key].entries.push track
    for group, i in groups
      addChannel MELODIC_CHANNELS[i % MELODIC_CHANNELS.length], group.entries, group.label, false

  # Percussion : un seul canal (9) pour toutes les pistes de batterie, dont
  # les sorties ne peuvent donc pas être séparées par piste.
  if percussion.length
    labels = {}
    for track in percussion
      label = (byTrack ? {})[Number(track.index)]
      labels[label] = true if label?
    addChannel DRUM_CHANNEL, percussion, (Object.keys labels)[0] ? null, true
  {
    byTrack: byTrackChannel
    channels
    overflow: if melodic.length > MELODIC_CHANNELS.length then Math.max(0, groups.length - MELODIC_CHANNELS.length) else 0
  }

# Transposition auditive : décale une hauteur MIDI entière (le réglage est
# borné en amont par clampTranspose) sans jamais sortir du domaine 0..127 :
# une note poussée hors limites est ramenée à la borne.
transposePitch = (pitch, semitones) ->
  Math.max 0, Math.min 127, pitch + semitones

# Hauteur réellement jouée : les percussions (canal MIDI 10, index 9) ne sont
# jamais transposées, quel que soit le réglage.
playedPitch = (pitch, semitones, percussion) ->
  return pitch if percussion
  transposePitch pitch, semitones

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

# Remappe les notes d'un flux MIDI complet sur les segments de lecture
# linéaire : chaque segment [from, to) est réécrit à partir de son offset.
# Les segments sont exprimés dans l'unité des notes (secondes) ; le worker les
# produit en millisecondes comme le reste du timemap, la conversion se fait
# dans normalizePlaybackData.
# Une note qui commence dans un segment est translatée et tronquée à la
# frontière (dur' = min(dur, to - start)). Une note qui commence hors de tout
# segment est écartée, ainsi qu'une note dont la durée restante serait nulle.
# Le résultat est trié par start croissant puis par hauteur.
remapNotesToSegments = (notes, segments) ->
  return notes unless Array.isArray(notes)
  seps = []
  for segment in (segments ? [])
    from = Number segment.from
    to = Number segment.to
    offset = Number segment.offset
    continue unless isFinite(from) and isFinite(to) and isFinite(offset)
    continue unless to > from and offset >= 0
    seps.push {from, to, offset}
  return [] unless seps.length
  # Les segments écrits sont disjoints ; on les trie par prudence et on
  # cherche pour chaque note le dernier segment dont from <= start.
  seps.sort (a, b) -> a.from - b.from
  out = []
  for note in notes
    start = Number note.start
    continue unless isFinite start
    lo = 0
    hi = seps.length
    while lo < hi
      mid = (lo + hi) >> 1
      if seps[mid].from <= start then lo = mid + 1 else hi = mid
    continue if lo is 0
    seg = seps[lo - 1]
    continue if start >= seg.to
    duration = Number note.dur
    duration = 0 unless isFinite(duration) and duration > 0
    remaining = seg.to - start
    continue unless remaining > 0
    duration = remaining if duration > remaining
    continue unless duration > 0
    out.push {
      start: seg.offset + (start - seg.from)
      dur: duration
      pitch: note.pitch
      velocity: note.velocity
      track: note.track
    }
  out.sort (a, b) -> (a.start - b.start) or (a.pitch - b.pitch)
  out

# Durée totale couverte par des segments (offset + longueur du dernier).
segmentsDuration = (segments) ->
  duration = 0
  for segment in (segments ? [])
    to = Number segment.to
    offset = Number segment.offset
    continue unless isFinite(to) and isFinite(offset)
    end = offset + Math.max 0, to - Number(segment.from)
    duration = end if isFinite(end) and end > duration
  duration

# Facteur de tempo d'une lecture : tempo choisi / tempo initial du fichier.
# 1 laisse la partition telle quelle ; 2 joue deux fois plus vite (les durées
# sont divisées par 2). Un tempo de fichier absent ou nul ne change rien.
playbackTempoFactor = (chosenBpm, fileBpm) ->
  chosen = Number chosenBpm
  base = Number fileBpm
  return 1 unless isFinite(chosen) and chosen > 0 and isFinite(base) and base > 0
  chosen / base

scaleTimeValue = (value, factor) ->
  n = Number value
  if isFinite(n) then n / factor else value

# Applique le facteur de tempo à l'axe de TEMPS DE LECTURE (sortie) : durée,
# marqueurs de synchronisation et pauses. Un facteur 2 (deux fois plus vite)
# DIVISE ces temps par 2. Les segments NE sont PAS mis à l'échelle : `from`/
# `to` sont des positions dans le flux MIDI source, indépendantes du tempo.
# Le facteur est transmis par `tempoFactor` ; normalizePlaybackData l'applique
# une seule fois aux débuts et durées des notes remappées, après avoir
# sélectionné celles-ci dans le temps source. Aucun champ d'origine n'est
# modifié (les données brutes restent en cache, indépendantes du tempo).
scalePlaybackData = (data, factor) ->
  f = Number factor
  return data unless data? and isFinite(f) and f > 0
  return data if f is 1
  scaled = {}
  scaled[key] = value for own key, value of data
  scaled.tempoFactor = f
  scaled.duration = scaleTimeValue data.duration, f if data.duration?
  # Position du mouvement dans sa source et durée totale de la source : même
  # axe de sortie que la durée, donc même facteur.
  scaled.offsetMs = scaleTimeValue data.offsetMs, f
  scaled.sourceDurationMs = scaleTimeValue data.sourceDurationMs, f
  if Array.isArray data.syncMarks
    scaled.syncMarks = for mark in data.syncMarks
      copy = {}
      copy[key] = value for own key, value of mark
      copy.t = Number(copy.t) / f if copy.t?
      copy
  if Array.isArray data.pauses
    scaled.pauses = for pause in data.pauses
      copy = {}
      copy[key] = value for own key, value of pause
      for key in ['timeUs', 'endTimeUs', 'timeMs', 'endTimeMs', 'seconds']
        copy[key] = Number(copy[key]) / f if copy[key]?
      copy
  scaled

# Analyse le MIDI une seule fois et normalise les notes en secondes, avec
# l'indice de piste de chacune. Les pistes de percussion (canal MIDI 10) sont
# signalées : la transposition auditive ne les décale pas.
normalizePlaybackData = (data, parser) ->
  throw new Error "Données de lecture absentes" unless data
  throw new Error "Parseur MIDI indisponible" unless parser
  midi = if typeof data.midi is 'string' then parser.parseBase64(data.midi) else parser.parse(data.midi)
  tracks = midi.tracks ? []
  percussionTracks = (track.index for track in tracks when Number(track.channel) is 9)
  notes = []
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
  notes.sort (a, b) -> (a.start - b.start) or (a.pitch - b.pitch)
  segments = if Array.isArray(data.segments) then data.segments else []
  durationMs = Number data.duration
  duration = if isFinite(durationMs) and durationMs > 0 then durationMs / 1000 else 0
  # Le worker fournit toujours des segments (un par mesure jouée, pauses
  # incluses) : tout le flux MIDI est remappé dessus, dans les deux modes.
  # Le worker les exprime en millisecondes (`fromMs`/`toMs`/`offsetMs`, cf.
  # timeline.buildSegments) : on les ramène en secondes, l'unité de `notes`.
  secondsSegments = for segment in segments
    from: Number(segment.fromMs) / 1000
    to: Number(segment.toMs) / 1000
    offset: Number(segment.offsetMs) / 1000
  notes = remapNotesToSegments notes, secondsSegments
  # Le temps MIDI source n'est jamais mis à l'échelle : le remappage ci-dessus
  # sélectionne et tronque les notes aux positions du flux. Seul le temps de
  # sortie l'est, exactement une fois, ici : start = (offset + (start - from))
  # / f et dur / f.
  tempoFactor = Number data.tempoFactor
  tempoFactor = 1 unless isFinite(tempoFactor) and tempoFactor > 0
  if tempoFactor isnt 1
    notes = for note in notes
      start: note.start / tempoFactor
      dur: note.dur / tempoFactor
      pitch: note.pitch
      velocity: note.velocity
      track: note.track
  # La durée du slice fait foi (déjà mise à l'échelle) ; à défaut, la somme
  # des segments, exprimée en temps source, est ramenée en temps de lecture.
  duration = segmentsDuration(secondsSegments) / tempoFactor unless duration > 0
  {
    midi
    tracks
    notes
    duration
    trackMap: resolveTrackMap data.trackMap
    syncMarks: data.syncMarks ? []
    staffLabels: data.staffLabels ? []
    segments
    percussionTracks
  }

# --- Moteur ----------------------------------------------------------------

createEngine = (initialOptions = {}) ->
  state =
    options: {engine: initialOptions.engine ? 'auto'}
    ctx: null
    masterGain: null
    voiceGains: {}
    trackGains: {}
    # Synthétiseur SpessaSynth (WorkletSynthesizer) et état de son chargement.
    synth: null
    enginePromise: null
    engineMode: null
    # Incrémenté à chaque libération du moteur : un chargement qui se termine
    # après un rechargement de partition est détruit au lieu d'être adopté.
    engineGeneration: 0
    workletUrl: null
    # Connexions sortie de canal -> GainNode de piste, à détacher au prochain
    # graphe (spessaLinks) et journal des programChange réellement envoyés.
    spessaLinks: []
    programChanges: []
    # Répartition piste -> canal SpessaSynth et description par canal.
    channelByTrack: {}
    channelPlan: []
    # File d'attente SpessaSynth : notes déjà retenues par l'ordonnanceur mais
    # pas encore dues, et noteOff à envoyer. Les deux sont vidés à chaque
    # pause/seek/stop, donc aucun événement ne survit à un changement de
    # transport.
    spessaQueue: []
    pendingOffs: []
    dispatchJitter: []
    loaded: false
    tracks: []
    notes: []
    duration: 0
    trackMap: {byTrack: {}, byLabel: {}}
    syncMarks: []
    staffLabels: []
    position: 0
    startCtxTime: 0
    # Faux tant que ensureEngine() n'a pas résolu : l'horloge et l'ordonnanceur
    # ne démarrent qu'à ce moment-là (voir api.play), la position reste alors
    # figée sur `from`. Sans ce drapeau, api.position() avancerait pendant le
    # chargement du moteur.
    clockStarted: false
    # Jeton de génération : incrémenté par play, pause, stop et load, pour
    # qu'un démarrage différé (attente du moteur) périmé ne relance pas
    # l'horloge après un changement de transport.
    playToken: 0
    noteIndex: 0
    # Journal d'ordonnancement activé à la demande (diagnostic et tests) :
    # null tant qu'aucune sonde ne le demande, pour ne pas croître sans fin.
    noteLog: null
    playing: false
    timer: null
    sources: []
    masterVolume: DEFAULT_VOLUME
    voiceVolumes: {}
    voiceMuted: {}
    # Choix d'instrument par libellé de voix (programme GM 0..127) et option
    # globale « piano seulement ». Ils survivent aux chargements : c'est
    # l'application qui les réapplique après chaque load().
    voicePrograms: {}
    pianoOnly: false
    # Transposition auditive (demi-tons) : appliquée aux notes programmées à
    # partir de maintenant, sans modifier les notes chargées. Les pistes de
    # percussion n'en dépendent pas.
    transposeSemitones: 0
    percussionTracks: new Set()
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
      gain.gain.value = voiceGainValue(state.voiceVolumes[label] ? DEFAULT_VOICE_VOLUME, state.voiceMuted[label] ? false)
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

  # Détache les sorties de canal du synthétiseur courant. Les nœuds peuvent
  # déjà avoir été déconnectés par buildGraph : disconnectChannel tolère un
  # nœud absent de la connexion.
  disconnectSpessa = ->
    synth = state.synth
    for link in state.spessaLinks
      try
        synth?.disconnectChannel link.node, link.channel
      catch
        null
    state.spessaLinks = []

  releaseSynth = ->
    state.engineGeneration += 1
    synth = state.synth
    state.synth = null
    state.spessaLinks = []
    state.programChanges = []
    state.pendingOffs = []
    state.spessaQueue = []
    state.dispatchJitter = []
    if synth
      try synth.stopAll true
      try synth.destroy()
    if state.workletUrl?.startsWith? 'blob:'
      try URL.revokeObjectURL state.workletUrl
      state.workletUrl = null
    null

  resetEngine = ->
    releaseSynth()
    state.enginePromise = null
    state.engineMode = null

  clampTime = (seconds) ->
    value = Number seconds
    value = 0 unless isFinite value
    value = 0 if value < 0
    value = state.duration if state.duration > 0 and value > state.duration
    value

  # URL du processeur AudioWorklet : fichier servi à côté de la page (build
  # normal) ou texte inliné (SPA, où file:// interdit fetch) transformé en
  # blob. Le blob est conservé jusqu'à destroy().
  workletModuleUrl = ->
    return state.workletUrl if state.workletUrl
    explicit = window?.__musicaSpessaWorkletUrl
    return state.workletUrl = explicit if typeof explicit is 'string' and explicit
    text = window?.__musicaSpessaWorkletText
    if typeof text is 'string' and text.length
      blob = new Blob [text], type: 'application/javascript'
      return state.workletUrl = URL.createObjectURL blob
    base = window?.location?.href ? 'http://localhost/'
    state.workletUrl = new URL(SPESSA_WORKLET_FILE, base).href

  decodeBase64Bytes = (b64) ->
    midi = window?.__musicaMidi
    return midi.decodeBase64 b64 if typeof midi?.decodeBase64 is 'function'
    unless typeof atob is 'function'
      throw new Error "Décodage base64 indisponible"
    bin = atob String(b64).replace /\s+/g, ''
    out = new Uint8Array bin.length
    for i in [0...bin.length]
      out[i] = bin.charCodeAt i
    out

  # Buffer de la soundfont : inliné en base64 dans le SPA (aucun fetch
  # possible en file://), sinon téléchargé depuis soundfonts/.
  readSoundfontBuffer = ->
    return Promise.reject new Error "Soundfont absente" if window?.__musicaSoundfontAvailable is false
    b64 = window?.__musicaSoundfontB64
    if typeof b64 is 'string' and b64.length
      try
        bytes = decodeBase64Bytes b64
        return Promise.resolve bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      catch err
        return Promise.reject err
    fetch SOUNDFONT_FILE, {cache: 'force-cache'}
    .then (response) ->
      throw new Error "Soundfont introuvable (#{response.status})" unless response.ok
      response.arrayBuffer()

  # Charge le synthétiseur et la banque UNE SEULE FOIS par moteur. La banque
  # n'est pas relue du MIDI : scheduleNote envoie les noteOn/noteOff, ce qui
  # laisse le remappage des reprises et le tempo sous le contrôle de
  # normalizePlaybackData.
  loadSoundfont = (ctx) ->
    tracks = (track for track in state.tracks when track.notes?.length)
    return Promise.resolve(null) unless tracks.length
    Spessa = window?.__musicaSpessa
    return Promise.resolve(null) unless Spessa?.WorkletSynthesizer
    return Promise.resolve(null) unless ctx?.audioWorklet?.addModule
    # Banque absente (build sans SF3) : inutile de charger le worklet.
    return Promise.resolve(null) if window?.__musicaSoundfontAvailable is false
    generation = state.engineGeneration
    loading = Promise.resolve()
      .then -> ctx.audioWorklet.addModule workletModuleUrl()
      .then -> new Spessa.WorkletSynthesizer ctx
      .then (synth) ->
        readSoundfontBuffer()
        .then (buffer) -> synth.soundBankManager.addSoundBank buffer, 'main'
        .then -> synth.isReady
        .then -> synth
    # La bascule doit rester transparente même sur un appareil lent (liseuse) :
    # au-delà du délai, on n'attend plus la banque et on joue avec
    # l'oscillateur. Le délai est large pour laisser sa chance à la banque SF3.
    new Promise (resolve) ->
      settled = false
      timer = setTimeout (->
        return if settled
        settled = true
        resolve null
      ), SOUNDFONT_TIMEOUT
      loading.then (synth) ->
        if settled or generation isnt state.engineGeneration
          try synth?.destroy()
          catch
            null
          # Chargement périmé (rechargement de partition) : on libère l'attente
          # au lieu de laisser le minuteur de repli courir dans le vide.
          return if settled
          settled = true
          clearTimeout timer
          resolve null
          return
        settled = true
        clearTimeout timer
        resolve synth
      .catch ->
        return if settled
        settled = true
        clearTimeout timer
        resolve null

  # Programme effectif d'un canal : celui de sa première piste, dont le
  # libellé porte le choix de voix éventuel. Les pistes d'une même voix
  # partagent déjà le canal et le programme.
  channelProgram = (entry) ->
    trackIndex = entry.tracks[0]
    label = state.trackMap.byTrack[trackIndex]
    effectiveTrackProgram state.tracks[trackIndex], label, state.voicePrograms, state.pianoOnly

  # Recalcule les programmes du plan après un chargement, sans rien envoyer :
  # setupSynth envoie ensuite chaque programme du plan.
  planChannelPrograms = ->
    for entry in state.channelPlan
      entry.program = channelProgram entry

  # Applique les choix au synthétiseur en cours. Seuls les canaux dont le
  # programme change reçoivent un programChange : un réglage identique ne
  # relance donc pas le preset en cours de lecture.
  refreshChannelPrograms = ->
    for entry in state.channelPlan
      program = channelProgram entry
      continue if program is entry.program
      entry.program = program
      continue unless state.synth
      try
        state.synth.programChange entry.channel, program
        state.programChanges.push {channel: entry.channel, program}
      catch
        null
    api

  # Envoie les programme GM de chaque canal et raccorde les sorties de canal
  # aux GainNode de piste. Une seule connexion par canal : les pistes d'une
  # même voix partagent le gain de leur représentante.
  setupSynth = (synth) ->
    return unless synth
    disconnectSpessa()
    state.programChanges = []
    seen = {}
    for entry in state.channelPlan
      unless seen[entry.channel]?
        seen[entry.channel] = true
        try
          synth.programChange entry.channel, entry.program
          state.programChanges.push {channel: entry.channel, program: entry.program}
        catch
          null
      node = state.trackGains[entry.tracks[0]]
      continue unless node
      try
        synth.connectChannel node, entry.channel
        state.spessaLinks.push {node, channel: entry.channel}
      catch
        null
    # Par sécurité, le canal 9 est explicitement un canal de batterie (c'est
    # déjà le cas en GM) : les programmes y sont ignorés au profit du kit.
    try
      synth.midiChannels?[DRUM_CHANNEL]?.setDrums? true
    catch
      null
    synth

  ensureEngine = ->
    return state.enginePromise if state.enginePromise
    if state.options.engine is 'oscillator'
      state.engineMode = 'oscillator'
      state.enginePromise = Promise.resolve null
      return state.enginePromise
    unless window?.__musicaSpessa?.WorkletSynthesizer
      state.engineMode = 'oscillator'
      state.enginePromise = Promise.resolve null
      return state.enginePromise
    ctx = state.ctx
    generation = state.engineGeneration
    # Un seul chargement à la fois : le préchargement de load() et le play()
    # qui suit partagent la même promesse, le worklet et la banque ne sont
    # jamais rechargés.
    state.enginePromise = loadSoundfont(ctx).then (synth) ->
      return state.engineMode if generation isnt state.engineGeneration
      if synth
        state.synth = synth
        state.engineMode = 'soundfont'
        setupSynth synth
      else
        state.synth = null
        state.engineMode = 'oscillator'
      state.engineMode
    .catch ->
      return state.engineMode if generation isnt state.engineGeneration
      state.synth = null
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
        source.gain.gain.cancelScheduledValues now
        source.gain.gain.setValueAtTime 0, now
        source.osc.stop now
      catch
        null
    state.sources = []

  # Coupe immédiatement les notes SpessaSynth (all sound off) et oublie les
  # noteOff en attente : pause, arrêt et seek ne laissent aucune traînée ni
  # aucun événement futur qui repartirait après la reprise.
  clearSpessaNotes = ->
    state.pendingOffs = []
    state.spessaQueue = []
    return unless state.synth
    try
      state.synth.stopAll true
    catch
      null

  cancelAll = ->
    cancelSources()
    clearSpessaNotes()

  trackDestination = (trackIndex) ->
    state.trackGains[trackIndex] ? state.masterGain

  # Note telle qu'elle sera jouée : seule la hauteur peut changer. La note
  # chargée reste intacte (même début, même durée, même piste).
  transposedNote = (note) ->
    return note if state.transposeSemitones is 0
    pitch = playedPitch note.pitch, state.transposeSemitones, state.percussionTracks.has note.track
    return note if pitch is note.pitch
    {start: note.start, dur: note.dur, pitch, velocity: note.velocity, track: note.track}

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

  # Envoie une note au synthétiseur. Le noteOff est mémorisé et envoyé par
  # l'ordonnanceur à son échéance : les événements ne sont pas datés dans le
  # futur, ce qui permet à pause/seek/stop de tout couper instantanément.
  # Retourne false si la note n'a pas de canal (repli oscillateur).
  playSpessa = (note, at, intendedAt = at) ->
    synth = state.synth
    channel = state.channelByTrack[note.track]
    return false unless synth and channel?
    pitch = Math.max 0, Math.min 127, Math.round note.pitch
    velocity = Math.max 1, Math.min 127, Math.round(note.velocity ? 100)
    try
      synth.noteOn channel, pitch, velocity
      state.pendingOffs.push {
        time: intendedAt + Math.max(0.02, note.dur)
        channel
        pitch
      }
      true
    catch
      false

  # Envoie les notes retenues par l'ordonnanceur dont l'instant est arrivé.
  # L'anticipation ne sert donc qu'à décider quelles notes jouer : rien n'est
  # daté dans le futur chez SpessaSynth, et la file est annulable.
  dispatchSpessaQueue = (now) ->
    return unless state.synth and state.spessaQueue.length
    remaining = []
    for item in state.spessaQueue
      if item.intendedAt <= now
        if playSpessa item.note, now, item.intendedAt
          if state.noteLog?
            state.dispatchJitter.push {start: item.note.start, jitter: now - item.intendedAt}
        else
          playOscillator item.note, Math.max(item.intendedAt, now)
      else
        remaining.push item
    state.spessaQueue = remaining

  # Envoie les noteOff dus. Le tri par échéance garde l'ordre quelle que soit
  # la durée des notes.
  flushSpessaOffs = (now) ->
    return unless state.synth and state.pendingOffs.length
    remaining = []
    for pending in state.pendingOffs
      if pending.time <= now + SPESSA_DUE_EPSILON
        try
          state.synth.noteOff pending.channel, pending.pitch
        catch
          null
      else
        remaining.push pending
    state.pendingOffs = remaining

  scheduleNote = (note, at, intendedAt = at) ->
    return true if state.engineMode is 'soundfont' and playSpessa note, at, intendedAt
    return if state.sources.length >= MAX_VOICES
    playOscillator note, at
    false

  clearTimer = ->
    if state.timer?
      clearInterval state.timer
      state.timer = null

  finish = ->
    return unless state.playing
    state.playing = false
    state.clockStarted = false
    state.position = state.duration
    clearTimer()
    cancelAll()
    callback = state.onEndCb
    callback? state.position

  tick = ->
    return unless state.playing and state.ctx and state.clockStarted
    ctx = state.ctx
    now = ctx.currentTime
    current = now - state.startCtxTime
    return if current < 0
    # L'oscillateur est planifié d'avance dans Web Audio. Les notes
    # SpessaSynth sont d'abord retenues par le même ordonnanceur (la file
    # d'anticipation), puis envoyées au moment où elles sont dues : faute
    # d'API pour annuler des événements datés, cela garantit que
    # pause/seek/stop coupent réellement tout.
    horizon = current + SCHEDULE_WINDOW
    flushSpessaOffs now
    while state.noteIndex < state.notes.length and (state.notes[state.noteIndex].start ? 0) < horizon
      note = state.notes[state.noteIndex]
      state.noteIndex += 1
      continue if (note.start ? 0) < current - 0.05
      intendedAt = state.startCtxTime + note.start
      played = transposedNote note
      if state.noteLog?
        state.noteLog.push {
          start: played.start
          dur: played.dur
          pitch: played.pitch
          # Hauteur d'origine : instrumentation de test, jamais utilisée par
          # le moteur (le journal n'existe qu'entre startNoteLog et stop).
          sourcePitch: note.pitch
          track: played.track
          offset: intendedAt - state.startCtxTime
        }
      if state.engineMode is 'soundfont'
        state.spessaQueue.push {note: played, intendedAt}
      else
        scheduleNote played, Math.max(intendedAt, now), intendedAt
    dispatchSpessaQueue now
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
    engineChanged = options.engine? and options.engine isnt state.options.engine
    for own key, value of options
      state.options[key] = value
    resetEngine() if engineChanged
    parser = window?.__musicaMidi
    normalized = normalizePlaybackData playbackData, parser
    state.tracks = normalized.tracks
    state.notes = normalized.notes
    state.duration = normalized.duration
    state.trackMap = normalized.trackMap
    state.syncMarks = normalized.syncMarks
    state.staffLabels = normalized.staffLabels
    state.percussionTracks = new Set normalized.percussionTracks ? []
    plan = assignTrackChannels state.tracks, state.trackMap.byTrack
    state.channelByTrack = plan.byTrack
    state.channelPlan = plan.channels
    planChannelPrograms()
    if plan.overflow > 0
      console.warn "Audio : #{plan.overflow} voix sans canal MIDI propre, programme partagé"
    state.loaded = true
    state.position = 0
    state.noteIndex = 0
    state.noteLog = null
    state.dispatchJitter = []
    # La banque reste chargée d'un mouvement à l'autre : seul un moteur
    # retombé sur l'oscillateur (banque absente ou illisible) est retenté. Un
    # chargement en cours est conservé : ensureEngine rend la même promesse.
    resetEngine() if state.engineMode is 'oscillator'
    buildGraph() if state.ctx
    setupSynth state.synth if state.synth
    # Préchargement systématique : l'AudioContext est créé dès le chargement
    # de la partition. Sans geste utilisateur il reste « suspended », ce qui
    # n'empêche ni addModule ni la lecture de la banque ; play() le reprend.
    # Le worklet et la banque SF3 se chargent en tâche de fond pour que le
    # premier play() trouve le moteur prêt ou déjà en cours de chargement.
    try
      ensureContext()
    catch err
      # WebAudio absent : play() signalera l'erreur ; le chargement reste
      # utilisable pour l'affichage et le rendu de la partition.
      console.warn "Audio : contexte indisponible au chargement : #{err?.message or err}" if console?.warn?
    ensureEngine() if state.ctx
    normalized

  api.play = (fromSeconds = 0, options = {}) ->
    throw new Error "Aucune donnée de lecture chargée" unless state.loaded
    if options.engine? and options.engine isnt state.options.engine
      state.options.engine = options.engine
      resetEngine()
    ctx = ensureContext()
    api.resume()
    cancelAll()
    # Aucun ordonnanceur ne doit survivre au redémarrage : l'ancien est coupé
    # tout de suite, le nouveau ne part qu'une fois le moteur prêt.
    clearTimer()
    token = ++state.playToken
    from = Number fromSeconds
    from = 0 unless isFinite from
    from = clampTime from
    state.position = from
    state.playing = true
    # L'horloge ne démarre qu'une fois le moteur prêt : tant que
    # state.engineMode est null, scheduleNote jouerait l'oscillateur de repli.
    # La position reste figée sur `from` pendant l'attente, et un pause, stop,
    # seek ou play survenu entre-temps est respecté via `token`.
    state.clockStarted = false
    state.noteIndex = noteIndexAt state.notes, from
    ensureEngine().then ->
      return unless token is state.playToken and state.playing
      # `state.position` peut avoir changé (seek) pendant le chargement du
      # moteur : le départ réel se cale sur la position courante.
      state.startCtxTime = ctx.currentTime - state.position
      state.noteIndex = noteIndexAt state.notes, state.position
      state.clockStarted = true
      startTimer()
    api

  api.pause = ->
    return api unless state.playing
    state.position = clampTime api.position()
    state.playing = false
    state.playToken += 1
    state.clockStarted = false
    clearTimer()
    cancelAll()
    api

  api.stop = ->
    state.playing = false
    state.playToken += 1
    state.clockStarted = false
    clearTimer()
    cancelAll()
    state.position = 0
    state.noteIndex = 0
    api

  api.seek = (seconds) ->
    value = clampTime seconds
    state.position = value
    state.noteIndex = noteIndexAt state.notes, value
    if state.playing and state.ctx and state.clockStarted
      cancelAll()
      state.startCtxTime = state.ctx.currentTime - value
    api

  api.position = ->
    # Pendant l'attente du moteur, l'horloge n'a pas démarré : la position est
    # celle fixée par play (ou par un seek), pas le temps écoulé.
    return state.position unless state.playing and state.ctx and state.clockStarted
    Math.max 0, state.ctx.currentTime - state.startCtxTime

  api.isPlaying = -> state.playing

  # Diagnostic : 'soundfont', 'oscillator' ou null tant que rien n'est chargé
  api.getEngineMode = -> state.engineMode

  # Diagnostic / tests : notes que le moteur va réellement programmer (débuts
  # et durées en secondes de lecture, donc déjà au tempo courant).
  api.getNotes = -> state.notes.slice()

  # Diagnostic / tests : journal des notes effectivement confiées à
  # l'ordonnanceur. `offset` est l'instant de lecture relatif au départ de la
  # lecture (secondes), aligné sur le `start` préparé. Null par défaut : aucun
  # journal n'est tenu tant qu'une sonde ne l'a pas demandé.
  api.startNoteLog = ->
    state.noteLog = []
    state.dispatchJitter = []
    api

  api.getScheduledNotes = -> (state.noteLog ? []).slice()

  api.onEnd = (callback) ->
    state.onEndCb = callback
    api

  api.setMasterVolume = (volume) ->
    state.masterVolume = clampVolume volume
    if state.masterGain and state.ctx
      state.masterGain.gain.setTargetAtTime volumeToGain(state.masterVolume), state.ctx.currentTime, 0.01
    api

  # Transposition auditive (demi-tons). Les notes déjà programmées (fenêtre
  # d'anticipation de 150 ms) et les sons en cours gardent leur hauteur : le
  # changement s'entend à la note suivante. Aucune donnée chargée n'est
  # modifiée, aucun re-rendu n'est déclenché.
  api.setTranspose = (semitones) ->
    state.transposeSemitones = semitones
    api

  api.getTranspose = -> state.transposeSemitones

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
      gain.gain.setTargetAtTime voiceGainValue(state.voiceVolumes[label] ? DEFAULT_VOICE_VOLUME, state.voiceMuted[label]), state.ctx.currentTime, 0.01
    api

  # Choix d'instrument d'une voix, appliqué immédiatement sur son canal (y
  # compris pendant la lecture). `null` revient à l'instrument de la partition.
  api.setVoiceProgram = (label, program) ->
    return api unless label?
    if program?
      value = Number program
      if isFinite value
        state.voicePrograms[label] = Math.min 127, Math.max 0, Math.floor value
      else
        delete state.voicePrograms[label]
    else
      delete state.voicePrograms[label]
    refreshChannelPrograms()

  # « Piano seulement » : toutes les voix mélodiques passent au programme 0,
  # sans modifier les choix par voix (ils reprennent quand on décoche).
  api.setPianoOnly = (enabled) ->
    state.pianoOnly = !!enabled
    refreshChannelPrograms()

  api.destroy = ->
    api.stop()
    disconnectGraph()
    releaseSynth()
    if state.ctx
      ctx = state.ctx
      state.ctx = null
      ctx.close?().catch? -> null
    state.enginePromise = null
    state.engineMode = null
    state.loaded = false
    state.noteLog = null
    api

  # Diagnostic / tests : répartition des pistes sur les canaux MIDI, avec le
  # programme GM et le libellé de voix de chaque canal.
  api.getChannelAssignments = ->
    for entry in state.channelPlan
      channel: entry.channel
      program: entry.program
      tracks: entry.tracks.slice()
      label: entry.label
      percussion: entry.percussion

  # Diagnostic / tests : programChange réellement envoyés au synthétiseur.
  api.getProgramChanges = ->
    for entry in state.programChanges
      {channel: entry.channel, program: entry.program}

  # Diagnostic / tests : gigue de l'ordonnanceur, mesurée à l'envoi réel des
  # notes SpessaSynth (déclenchement - début musical). Null sans journal.
  api.getTimingStats = ->
    log = state.dispatchJitter ? []
    return null unless log.length
    diffs = for entry in log
      Number entry.jitter
    rms = Math.sqrt diffs.reduce(((sum, d) -> sum + d * d), 0) / diffs.length
    {
      count: diffs.length
      max: Math.max.apply null, (Math.abs(d) for d in diffs)
      rms
      mean: diffs.reduce(((sum, d) -> sum + d), 0) / diffs.length
    }

  # Exposé pour les tests purs et les intégrations avancées
  api.volumeToGain = volumeToGain
  api.voiceGainValue = voiceGainValue
  api.DEFAULT_VOICE_VOLUME = DEFAULT_VOICE_VOLUME
  api.clampVolume = clampVolume
  api.resolveTrackMap = resolveTrackMap
  api.trackProgram = trackProgram
  api.voiceProgramChoice = voiceProgramChoice
  api.effectiveTrackProgram = effectiveTrackProgram
  api.assignTrackChannels = assignTrackChannels
  api.noteIndexAt = noteIndexAt
  api.notesToSchedule = notesToSchedule
  api.remapNotesToSegments = remapNotesToSegments
  api.segmentsDuration = segmentsDuration
  api.playbackTempoFactor = playbackTempoFactor
  api.scalePlaybackData = scalePlaybackData
  api.transposePitch = transposePitch
  api.playedPitch = playedPitch
  api.FLOOR = FLOOR
  api

api = createEngine()
api.createEngine = createEngine
api.normalizePlaybackData = normalizePlaybackData

window.__musicaAudio = api if typeof window isnt 'undefined'
module.exports = api if typeof module isnt 'undefined' and module.exports?
