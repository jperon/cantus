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
#   setVoiceVolume(label, v)     -> 0..100, par libellé de voix (défaut 70)
#   setVoiceMuted(label, m)      -> true : silence réel
#   setVoiceProgram(label, p)    -> programme GM 0..127 de la voix, null = celui
#                                   de la partition
#   setPianoOnly(enabled)        -> force le programme 0 sur les voix mélodiques
#                                   (la batterie garde le sien), sans effacer les
#                                   choix par voix
#   getChannelAssignments()      -> diagnostic : canaux, programmes effectifs
#   getProgramChanges()          -> diagnostic : programmes appliqués par canal
#   getVoiceGain(label)          -> gain courant du GainNode de la voix (ou null)
#   startNoteLog() / getScheduledNotes() / getTimingStats()
#   renderOffline(seconds)       -> Promise<AudioBuffer> (mesures, écoute)
#   resume()                     -> reprend l'AudioContext (politique autoplay)
#   destroy()
#
# Le programme effectif d'une piste est calculé par effectiveTrackProgram :
# batterie inchangée, sinon 0 quand pianoOnly est actif, sinon le choix de la
# voix, sinon le programme de la partition (0 à défaut).
#
# Aucun calcul audio n'est fait en JavaScript : chaque note est un
# AudioBufferSourceNode branché sur un GainNode d'enveloppe puis sur le
# GainNode de sa piste, celui de sa voix et le gain maître. Les échantillons
# sont extraits de la banque General MIDI libre MuseScore_General.sf2 (MIT) par
# tools/build-samples.py, en un Ogg Vorbis pas programme plus un manifeste JSON
# (pwa/samples/). La hauteur est obtenue par playbackRate, la boucle par
# loopStart/loopEnd, et l'attaque/relâchement par automation du gain. Seuls les
# instruments utilisés par la partition sont téléchargés et décodés, la
# première fois qu'ils sont nécessaires.
#
# Graphe : AudioBufferSourceNode -> GainNode (enveloppe) -> GainNode par piste
# -> GainNode par voix (libellé) -> masterGain -> destination. Une piste sans
# échantillon disponible est jouée par l'oscillateur de repli vers son GainNode
# de piste. Les pistes absentes de trackMap sont rattachées directement au
# master pour ne jamais les perdre.
#
# Les notes sont programmées avec leur heure exacte dans l'horloge de
# l'AudioContext (start(when, offset, duration)), une fenêtre SCHEDULE_WINDOW
# avant l'échéance : les retards du fil principal ne décalent donc pas les
# notes déjà confiées au moteur. Web Audio déclenche ensuite l'échantillon à
# l'échantillon près. Toute coupure (pause, stop, seek, transposition,
# changement d'instrument) appelle stop() avec un fondu de quelques
# millisecondes sur les sources actives et programmées : la reprise est
# immédiate, sans purge différée.

FLOOR = 0.01            # plancher du curseur de volume (≈ −40 dB)
DEFAULT_VOLUME = 100    # volume général, en pourcentage du maximum
# Volume d'une voix sans réglage enregistré : 70 % du maximum, pour laisser
# de la marge au volume général (gain 0,703, ≈ −3 dB).
DEFAULT_VOICE_VOLUME = 70
SCHEDULE_INTERVAL = 25  # ms, période de l'ordonnanceur à anticipation
SCHEDULE_WINDOW = 0.400 # s, fenêtre de notes programmées d'avance
MAX_VOICES = 64         # plafond de sources simultanées (repli oscillateur)
SAMPLE_TIMEOUT = 15000  # ms avant bascule vers la synthèse de repli
STOP_FADE = 0.008       # s, fondu de coupure des sources (< 10 ms)
SAMPLE_LEVEL = 0.8      # niveau de crête d'un échantillon, avant gains
FALLBACK_ATTACK = 0.01
FALLBACK_DECAY = 0.07
FALLBACK_SUSTAIN = 0.7
FALLBACK_RELEASE = 0.15
DEFAULT_PROGRAM = 0     # piano acoustique GM
DRUM_CHANNEL = 9        # canal MIDI 10 (index 9) : percussion GM
# Canaux mélodiques : les 15 canaux autres que le 9. Un canal par piste, ou
# par libellé de voix quand les pistes dépassent cette capacité.
MELODIC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]
SAMPLE_MANIFEST = 'samples/manifest.json'

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
# un masquage explicite vaut un vrai zéro. Au volume par défaut de 70 %, le
# gain vaut 0,703 (≈ −3 dB), donc bien audible.
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

# Répartit les pistes jouées sur les canaux MIDI 0..15. Cette table reste le
# diagnostic des programmes effectifs et limite le partage de programme quand
# les voix dépassent la capacité mélodique :
#   - une piste par canal mélodique tant qu'il y en a au plus 15 ;
#   - au-delà, un canal par libellé de voix (les pistes d'une même voix
#     partagent alors le programme de la première) ;
#   - la percussion va toujours sur le canal 9.
# `byTrack` est la table libellé par piste de resolveTrackMap. Retourne aussi
# le nombre de groupes qui n'ont pas pu obtenir leur propre canal (overflow).
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

# Clé de manifeste d'un programme : la batterie a son propre fichier, quelle
# que soit la banque GM du programme de la piste.
sampleKey = (program, percussion) ->
  return 'drums' if percussion
  value = Number program
  value = DEFAULT_PROGRAM unless isFinite value
  String Math.min 127, Math.max 0, Math.floor value

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

# Zone d'échantillon à jouer pour une hauteur et une vélocité. Les zones du
# manifeste sont disjointes en tessiture par couche de vélocité ; on préfère
# la couche dont l'intervalle de vélocité contient la note, la plus étroite
# d'abord (les couches dynamiques priment sur la couche de base 0..127). À
# défaut on prend la zone la plus proche en hauteur puis en vélocité.
selectSampleZone = (zones, pitch, velocity) ->
  return null unless Array.isArray(zones) and zones.length
  p = Math.max 0, Math.min 127, Number(pitch) ? 60
  v = Math.max 1, Math.min 127, Number(velocity) ? 100
  best = null
  for zone in zones
    keyLo = Number zone.keyLo
    keyHi = Number zone.keyHi
    velLo = Number zone.velLo
    velHi = Number zone.velHi
    continue unless isFinite(keyLo) and isFinite(keyHi)
    continue unless isFinite(velLo) and isFinite(velHi)
    keyDistance = if p < keyLo then keyLo - p else if p > keyHi then p - keyHi else 0
    velDistance = if v < velLo then velLo - v else if v > velHi then v - velHi else 0
    velSpan = velHi - velLo
    keySpan = keyHi - keyLo
    # Ordre de préférence : dans la tessiture, dans la couche de vélocité,
    # distance de hauteur, distance de vélocité, couche la plus étroite.
    score = [(if keyDistance is 0 then 0 else 1),
             (if velDistance is 0 then 0 else 1),
             keyDistance, velDistance,
             velSpan, keySpan]
    if best is null or compareScores(score, best.score) < 0
      best = {zone, score}
  best?.zone ? null

compareScores = (a, b) ->
  for i in [0...Math.max(a.length, b.length)]
    diff = (a[i] ? 0) - (b[i] ? 0)
    return diff if diff isnt 0
  0

# Rapport de hauteur d'une note sur son échantillon : root key et accord fin
# (coarse/fine tune SF2) compris. La transposition auditive est déjà dans
# note.pitch, donc rien d'autre à ajouter.
zonePlaybackRate = (zone, pitch) ->
  root = Number zone.root
  root = 60 unless isFinite root
  tune = Number(zone.tune) ? 0
  rate = Math.pow 2, (Number(pitch) - root + tune / 100) / 12
  Math.min 32, Math.max 0.03125, rate

# Gain de crête d'une note : vélocité, atténuation SF2 de la zone et niveau
# global. Le gain d'enveloppe part de 0 et rejoint cette valeur.
zonePeakGain = (zone, velocity) ->
  v = Math.max 1, Math.min 127, Number(velocity) ? 100
  attenuation = Number zone.gain
  attenuation = 1 unless isFinite(attenuation) and attenuation > 0
  SAMPLE_LEVEL * Math.pow(v / 127, 1.2) * attenuation

# Niveau de l'enveloppe `dt` secondes après le début, selon attaque, tenue,
# décroissance et niveau de sustain de la zone. Sert à raccorder proprement le
# relâchement quand la note s'arrête au milieu d'une rampe.
zoneEnvelopeLevel = (zone, peak, dt) ->
  return 0 unless dt > 0
  attack = Math.max 0.001, Number(zone.attack) ? 0.001
  hold = Math.max 0, Number(zone.hold) ? 0
  decay = Math.max 0.001, Number(zone.decay) ? 0.001
  sustain = Math.min 1, Math.max 0, Number(zone.sustain) ? 1
  if dt < attack
    peak * dt / attack
  else if dt < attack + hold
    peak
  else if dt < attack + hold + decay
    peak * (1 - (1 - sustain) * (dt - attack - hold) / decay)
  else
    peak * sustain

# Durée d'extinction d'une zone (bornée pour ne pas immobiliser une source).
zoneRelease = (zone) ->
  release = Number zone.release
  return 0.15 unless isFinite release and release > 0
  Math.min 4, Math.max 0.02, release

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
  # Notes carrées : mêmes temps de lecture que les marqueurs de mesure.
  if Array.isArray data.noteMarks
    scaled.noteMarks = for mark in data.noteMarks
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
    # Manifeste d'échantillons et tampons décodés, chargés paresseusement.
    manifest: null
    # file -> promesse du décodage (une seule fois par programme)
    instrumentPromises: {}
    # file -> {buffer, zones, rate} une fois décodé
    instruments: {}
    # Signature des programmes nécessaires au dernier ensureEngine().
    enginePromise: null
    engineSignature: null
    engineMode: null
    # Incrémenté à chaque libération du moteur : un chargement qui se termine
    # après un rechargement de partition est ignoré.
    engineGeneration: 0
    # Journal des programChange réellement appliqués (diagnostic).
    programChanges: []
    sentPrograms: {}
    # Répartition piste -> canal et description par canal (diagnostic).
    channelByTrack: {}
    channelPlan: []
    # Programme GM effectif par piste, et clé d'échantillon associée.
    trackPrograms: {}
    trackSampleKeys: {}
    # Sources actives ou programmées : {source, gain, kind}. Web Audio les
    # déclenche à l'heure demandée ; cancelSources() les coupe au fondu.
    sources: []
    # Journal de gigue : retard du fil principal au moment où la note est
    # confiée au graphe (les débuts eux-mêmes sont exacts par construction).
    dispatchJitter: []
    noteLogStartCtx: 0
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
    # figée sur `from`.
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
    masterVolume: DEFAULT_VOLUME
    voiceVolumes: {}
    voiceMuted: {}
    # Choix d'instrument par libellé de voix (programme GM 0..127) et option
    # globale « piano seulement ». Ils survivent aux chargements.
    voicePrograms: {}
    pianoOnly: false
    # Transposition auditive (demi-tons) : appliquée aux notes programmées à
    # partir de maintenant, sans modifier les notes chargées.
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

  # Graphe de gains : un GainNode par libellé de voix et par piste. Les
  # AudioBufferSourceNode des notes s'y raccordent à la programmation.
  buildGraph = ->
    ctx = state.ctx
    return unless ctx
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
    # Le contexte est suspendu dès sa création : il ne démarre qu'au premier
    # play(), après un geste utilisateur. Le décodage des échantillons reste
    # possible pendant la suspension.
    try
      ctx.suspend?().catch? -> null
    catch
      null
    master = ctx.createGain()
    master.gain.value = volumeToGain state.masterVolume
    master.connect ctx.destination
    state.ctx = ctx
    state.masterGain = master
    buildGraph()
    ctx

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

  baseUrl = ->
    window?.location?.href ? 'http://localhost/'

  manifestUrl = -> new URL(SAMPLE_MANIFEST, baseUrl()).href

  # Manifeste : objet déjà chargé (SPA), ou fichier servi à côté de la page.
  readManifest = ->
    return Promise.resolve window.__musicaSamplesManifest if window?.__musicaSamplesManifest?
    return Promise.reject new Error "Échantillons absents" if window?.__musicaSamplesAvailable is false
    fetch manifestUrl(), {cache: 'force-cache'}
    .then (response) ->
      throw new Error "Manifeste d'échantillons introuvable (#{response.status})" unless response.ok
      response.json()

  # Données d'un programme : base64 inliné dans le SPA (file:// interdit
  # fetch), sinon fichier de pwa/samples/.
  readSampleBuffer = (key) ->
    b64 = window?.__musicaSamplesData?[key]
    if typeof b64 is 'string' and b64.length
      try
        bytes = decodeBase64Bytes b64
        return Promise.resolve bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      catch err
        return Promise.reject err
    entry = state.manifest?.programs?[key]
    return Promise.reject new Error "Programme #{key} absent du manifeste" unless entry?.file
    fetch new URL(entry.file, manifestUrl()).href, {cache: 'force-cache'}
    .then (response) ->
      throw new Error "Échantillon #{entry.file} introuvable (#{response.status})" unless response.ok
      response.arrayBuffer()

  decodeAudio = (ctx, arrayBuffer) ->
    new Promise (resolve, reject) ->
      try
        result = ctx.decodeAudioData arrayBuffer, resolve, reject
        resolve result if result?.then
      catch err
        reject err

  # Promesse de décodage d'un programme, mémorisée. Une erreur rend null : les
  # notes de ce programme passent à l'oscillateur de repli sans bloquer les
  # autres.
  instrumentPromise = (ctx, key) ->
    existing = state.instrumentPromises[key]
    return existing if existing?
    entry = state.manifest?.programs?[key]
    return Promise.resolve(null) unless entry
    promise = readSampleBuffer key
    .then (arrayBuffer) -> decodeAudio ctx, arrayBuffer
    .then (buffer) ->
      decoded = {buffer, zones: entry.zones ? [], rate: Number(entry.rate) ? buffer.sampleRate}
      state.instruments[key] = decoded
      decoded
    .catch (err) ->
      console.warn "Audio : échantillon #{key} indisponible : #{err?.message or err}"
      null
    state.instrumentPromises[key] = promise
    promise

  # Clés des instruments réellement utilisés par la partition chargée.
  usedSampleKeys = ->
    keys = {}
    for track in state.tracks when track.notes?.length
      key = state.trackSampleKeys[track.index]
      keys[key] = true if key?
    Object.keys keys

  ensureEngine = ->
    if state.options.engine is 'oscillator'
      state.engineMode = 'oscillator'
      return Promise.resolve 'oscillator'
    ctx = state.ctx
    unless ctx?.decodeAudioData?
      state.engineMode = 'oscillator'
      return Promise.resolve 'oscillator'
    keys = usedSampleKeys()
    signature = keys.slice().sort().join(',')
    if state.engineMode is 'samples' and state.engineSignature is signature
      return Promise.resolve 'samples'
    if state.enginePromise? and state.engineSignature is signature
      return state.enginePromise
    generation = state.engineGeneration
    state.engineSignature = signature
    manifestPromise = if state.manifest then Promise.resolve(state.manifest) else readManifest()
    state.enginePromise = manifestPromise
    .then (manifest) ->
      if generation isnt state.engineGeneration or signature isnt state.engineSignature
        return state.engineMode
      state.manifest = manifest
      Promise.all (instrumentPromise(ctx, key) for key in keys)
    .then (entries) ->
      if generation isnt state.engineGeneration or signature isnt state.engineSignature
        return state.engineMode
      loaded = (entry for entry in (entries ? []) when entry?)
      state.engineMode = if loaded.length > 0 or keys.length is 0 then 'samples' else 'oscillator'
      state.engineMode
    .catch (err) ->
      if generation isnt state.engineGeneration or signature isnt state.engineSignature
        return state.engineMode
      console.warn "Audio : échantillons indisponibles, repli oscillateur : #{err?.message or err}"
      state.engineMode = 'oscillator'
      'oscillator'
    state.enginePromise

  releaseEngine = ->
    state.engineGeneration += 1
    state.manifest = null
    state.instrumentPromises = {}
    state.instruments = {}
    state.enginePromise = null
    state.engineSignature = null
    state.engineMode = null
    state.programChanges = []
    state.sentPrograms = {}
    state.dispatchJitter = []
    null

  clampTime = (seconds) ->
    value = Number seconds
    value = 0 unless isFinite value
    value = 0 if value < 0
    value = state.duration if state.duration > 0 and value > state.duration
    value

  # Programme effectif d'un canal : celui de sa première piste, dont le
  # libellé porte le choix de voix éventuel. Les pistes d'une même voix
  # partagent déjà le canal et le programme.
  channelProgram = (entry) ->
    trackIndex = entry.tracks[0]
    label = state.trackMap.byTrack[trackIndex]
    effectiveTrackProgram state.tracks[trackIndex], label, state.voicePrograms, state.pianoOnly

  # Recalcule les programmes effectifs du plan, remplit la table par piste et
  # la clé d'échantillon. Retourne true si un programme a changé.
  applyPrograms = ->
    changed = false
    for entry in state.channelPlan
      program = channelProgram entry
      if program isnt entry.program
        entry.program = program
        changed = true
      percussion = !!entry.percussion
      for trackIndex in entry.tracks
        state.trackPrograms[trackIndex] = program
        state.trackSampleKeys[trackIndex] = sampleKey program, percussion
      if state.sentPrograms[entry.channel] isnt program
        state.sentPrograms[entry.channel] = program
        state.programChanges.push {channel: entry.channel, program}
    changed

  removeSource = (source) ->
    index = state.sources.indexOf source
    state.sources.splice index, 1 if index >= 0

  # Coupe toutes les sources actives ET programmées : le fondu de STOP_FADE
  # évite le clic, et stop(now + fondu) annule aussi les notes qui devaient
  # démarrer plus tard. Aucune attente n'est nécessaire avant de relancer.
  cancelSources = ->
    ctx = state.ctx
    now = if ctx then ctx.currentTime else 0
    for entry in state.sources.slice()
      try
        param = entry.gain?.gain
        if param
          param.cancelScheduledValues now
          param.setValueAtTime param.value, now
          param.linearRampToValueAtTime 0, now + STOP_FADE
        entry.source?.stop now + STOP_FADE + 0.001
      catch
        null
    state.sources = []

  cancelAll = -> cancelSources()

  trackDestination = (trackIndex) ->
    state.trackGains[trackIndex] ? state.masterGain

  # Note telle qu'elle sera jouée : seule la hauteur peut changer. La note
  # chargée reste intacte (même début, même durée, même piste).
  transposedNote = (note) ->
    return note if state.transposeSemitones is 0
    pitch = playedPitch note.pitch, state.transposeSemitones, state.percussionTracks.has note.track
    return note if pitch is note.pitch
    {start: note.start, dur: note.dur, pitch, velocity: note.velocity, track: note.track}

  # Programme l'enveloppe d'une source et renvoie l'instant où la couper.
  # `at` et `end` sont des instants de l'horloge du contexte, `duration` la
  # durée musicale de la note.
  scheduleEnvelope = (ctx, gain, zone, velocity, at, duration) ->
    param = gain.gain
    peak = zonePeakGain zone, velocity
    attack = Math.max 0.001, Number(zone.attack) ? 0.001
    hold = Math.max 0, Number(zone.hold) ? 0
    decay = Math.max 0.001, Number(zone.decay) ? 0.001
    sustain = Math.min 1, Math.max 0, Number(zone.sustain) ? 1
    end = at + Math.max 0.03, Number(duration) ? 0.03
    param.setValueAtTime 0, at
    param.linearRampToValueAtTime peak, at + attack
    afterAttack = at + attack
    if hold > 0
      param.setValueAtTime peak, afterAttack + hold
      afterAttack += hold
    if sustain < 1
      param.linearRampToValueAtTime peak * sustain, afterAttack + decay
    level = Math.max 0.0001, zoneEnvelopeLevel zone, peak, end - at
    release = zoneRelease zone
    param.cancelScheduledValues end
    param.setValueAtTime level, end
    param.exponentialRampToValueAtTime 0.0001, end + release
    end + release + 0.02

  # Crée une source d'échantillon datée. Ne l'enregistre pas : l'appelant
  # décide (lecture temps réel ou rendu hors ligne).
  createSampleSource = (ctx, destination, entry, zone, pitch, velocity, at, duration) ->
    source = ctx.createBufferSource()
    source.buffer = entry.buffer
    rate = zonePlaybackRate zone, pitch
    if source.playbackRate?.setValueAtTime?
      source.playbackRate.setValueAtTime rate, at
    else if source.playbackRate?
      source.playbackRate.value = rate
    rate = entry.rate ? entry.buffer.sampleRate
    ratio = if rate > 0 then 1 / rate else 1
    offset = Math.max(0, Number(zone.offset) ? 0) * ratio
    if zone.loop and Number(zone.loopEnd) > Number(zone.loopStart)
      source.loop = true
      source.loopStart = Number(zone.loopStart) * ratio
      source.loopEnd = Number(zone.loopEnd) * ratio
    gain = ctx.createGain()
    gain.gain.setValueAtTime 0, at
    stopAt = scheduleEnvelope ctx, gain, zone, velocity, at, duration
    source.connect gain
    gain.connect destination
    if zone.loop
      source.start at, offset
    else
      frames = Number zone.frames
      frames = entry.buffer.length - (Number(zone.offset) ? 0) unless isFinite(frames) and frames > 0
      try
        source.start at, offset, Math.max(1, frames) * ratio
      catch
        source.start at, offset
    try
      source.stop stopAt
    catch
      null
    {source, gain, stopAt}

  # Joue un échantillon et l'inscrit dans la liste des sources actives.
  playSample = (note, at) ->
    ctx = state.ctx
    return false unless ctx
    key = state.trackSampleKeys[note.track]
    entry = state.instruments[key]
    return false unless entry?.buffer
    zone = selectSampleZone entry.zones, note.pitch, note.velocity
    return false unless zone
    {source, gain} = createSampleSource ctx, trackDestination(note.track),
      entry, zone, note.pitch, note.velocity, at, note.dur
    record = {kind: 'sample', source, gain}
    state.sources.push record
    source.onended = ->
      removeSource record
      try
        gain.disconnect()
      catch
        null
    true

  playOscillator = (note, at) ->
    ctx = state.ctx
    return unless ctx
    osc = ctx.createOscillator()
    gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = 440 * Math.pow(2, (note.pitch - 69) / 12)
    peak = (Math.min(127, Math.max(0, note.velocity)) / 127) * 0.25
    end = at + Math.max(0.05, note.dur)
    gain.gain.setValueAtTime 0, at
    gain.gain.linearRampToValueAtTime peak, at + FALLBACK_ATTACK
    gain.gain.linearRampToValueAtTime peak * FALLBACK_SUSTAIN, at + FALLBACK_ATTACK + FALLBACK_DECAY
    gain.gain.setValueAtTime peak * FALLBACK_SUSTAIN, end
    gain.gain.exponentialRampToValueAtTime 0.0001, end + FALLBACK_RELEASE
    osc.connect gain
    gain.connect trackDestination(note.track)
    record = {kind: 'oscillator', source: osc, gain}
    state.sources.push record
    osc.onended = ->
      removeSource record
      try
        gain.disconnect()
      catch
        null
    osc.start at
    osc.stop end + FALLBACK_RELEASE + 0.01

  # Enregistre le retard du fil principal (0 si la note part à l'avance) pour
  # le diagnostic de régularité. Le début lui-même est exact : il est passé à
  # start()/gain.setValueAtTime() dans l'horloge du contexte.
  recordDispatch = (kind, note, intendedAt, now) ->
    return unless state.noteLog?
    late = Math.max 0, now - intendedAt
    state.dispatchJitter.push {
      kind
      start: intendedAt - state.startCtxTime
      jitter: late
      ahead: intendedAt - now
    }
    return

  scheduleNote = (note, intendedAt, now) ->
    if state.engineMode is 'samples' and playSample note, intendedAt
      recordDispatch 'noteOn', note, intendedAt, now
      return true
    return if state.sources.length >= MAX_VOICES
    at = Math.max intendedAt, now
    playOscillator note, at
    recordDispatch 'noteOn', note, at, now
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
    # Tout est daté dans le futur (start(when) de Web Audio). Un tick en
    # retard ne décale donc pas les notes déjà confiées ; il ne peut que
    # réduire l'avance restante.
    horizon = current + SCHEDULE_WINDOW
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
      scheduleNote played, intendedAt, now
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
    releaseEngine() if engineChanged
    # Un moteur retombé sur l'oscillateur (manifeste absent ou illisible) est
    # retenté au chargement suivant.
    releaseEngine() if state.engineMode is 'oscillator' and state.options.engine isnt 'oscillator'
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
    state.trackPrograms = {}
    state.trackSampleKeys = {}
    state.programChanges = []
    state.sentPrograms = {}
    applyPrograms()
    if plan.overflow > 0
      console.warn "Audio : #{plan.overflow} voix sans canal MIDI propre, programme partagé"
    state.loaded = true
    state.position = 0
    state.noteIndex = 0
    state.noteLog = null
    state.dispatchJitter = []
    buildGraph() if state.ctx
    # Préchargement systématique : l'AudioContext est créé dès le chargement de
    # la partition, et seuls les instruments de ce mouvement sont demandés.
    try
      ensureContext()
    catch err
      console.warn "Audio : contexte indisponible au chargement : #{err?.message or err}" if console?.warn?
    ensureEngine() if state.ctx
    normalized

  startClock = ->
    ctx = state.ctx
    return unless ctx
    state.startCtxTime = ctx.currentTime - state.position
    state.noteIndex = noteIndexAt state.notes, state.position
    state.clockStarted = true
    startTimer()

  # (Re)démarre la lecture à `from`, une fois le moteur prêt. Aucune purge
  # n'est attendue : cancelSources() a déjà coupé les sources précédentes.
  restartAt = (from) ->
    from = Number from
    from = 0 unless isFinite from
    from = clampTime from
    state.position = from
    state.noteIndex = noteIndexAt state.notes, from
    state.playing = true
    state.clockStarted = false
    clearTimer()
    token = ++state.playToken
    ensureEngine()
    .then ->
      return unless token is state.playToken and state.playing and state.ctx
      # `state.position` peut avoir changé (seek) pendant l'attente du moteur :
      # le départ réel se cale sur la position courante.
      startClock()
    api

  # Un changement de hauteur ou d'instrument pendant la lecture coupe tout et
  # reprend à la position courante : les notes déjà programmées (ancienne
  # hauteur ou ancien programme) ne doivent pas s'entendre après le
  # changement.
  restartIfPlaying = ->
    return false unless state.playing and state.ctx and state.clockStarted
    from = clampTime api.position()
    cancelAll()
    restartAt from
    true

  api.play = (fromSeconds = 0, options = {}) ->
    throw new Error "Aucune donnée de lecture chargée" unless state.loaded
    if options.engine? and options.engine isnt state.options.engine
      state.options.engine = options.engine
      releaseEngine()
    ensureContext()
    api.resume()
    cancelAll()
    restartAt fromSeconds

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
    if state.playing and state.ctx and state.clockStarted
      cancelAll()
      restartAt value
    else
      state.position = value
      state.noteIndex = noteIndexAt state.notes, value
    api

  api.position = ->
    return state.position unless state.playing and state.ctx and state.clockStarted
    Math.max 0, state.ctx.currentTime - state.startCtxTime

  api.isPlaying = -> state.playing

  # Diagnostic : 'samples', 'oscillator' ou null tant que rien n'est chargé.
  api.getEngineMode = -> state.engineMode

  # Diagnostic : programmes d'échantillons décodés dans cette session.
  api.getLoadedSampleKeys = -> Object.keys state.instruments

  # Diagnostic / tests : notes que le moteur va réellement programmer (débuts
  # et durées en secondes de lecture, donc déjà au tempo courant).
  api.getNotes = -> state.notes.slice()

  # Diagnostic / tests : journal des notes effectivement confiées à
  # l'ordonnanceur. `offset` est l'instant de lecture relatif au départ de la
  # lecture (secondes), aligné sur le `start` préparé.
  api.startNoteLog = ->
    state.noteLog = []
    state.dispatchJitter = []
    state.noteLogStartCtx = state.ctx?.currentTime ? 0
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

  # Transposition auditive (demi-tons). En lecture, les sources en cours et
  # programmées sont coupées et la lecture reprend immédiatement à la position
  # courante ; hors lecture, le réglage s'applique au prochain départ.
  api.setTranspose = (semitones) ->
    return api if semitones is state.transposeSemitones
    state.transposeSemitones = semitones
    restartIfPlaying()
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

  # Choix d'instrument d'une voix, appliqué immédiatement (y compris pendant la
  # lecture). `null` revient à l'instrument de la partition. L'échantillon du
  # nouveau programme est chargé à la reprise si nécessaire.
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
    restartIfPlaying() if applyPrograms()

  # « Piano seulement » : toutes les voix mélodiques passent au programme 0,
  # sans modifier les choix par voix (ils reprennent quand on décoche).
  api.setPianoOnly = (enabled) ->
    state.pianoOnly = !!enabled
    restartIfPlaying() if applyPrograms()

  # Rendu hors ligne des notes chargées (même partition, mêmes programmes,
  # même transposition), sur un OfflineAudioContext : sert aux mesures de
  # régularité et aux rendus d'écoute. Renvoie un AudioBuffer.
  api.renderOffline = (seconds = state.duration, options = {}) ->
    rate = Number options.sampleRate
    rate = 44100 unless isFinite(rate) and rate > 0
    duration = Number seconds
    duration = state.duration unless isFinite(duration) and duration > 0
    duration = Math.max 0.01, Math.min(duration, Math.max(state.duration, 0.01))
    Offline = window?.OfflineAudioContext ? window?.webkitOfflineAudioContext
    return Promise.reject new Error "OfflineAudioContext indisponible" unless Offline
    offline = new Offline 1, Math.ceil(duration * rate), rate
    decodeCtx = state.ctx ? offline
    keys = usedSampleKeys()
    manifestPromise = if state.manifest then Promise.resolve(state.manifest) else readManifest()
    manifestPromise
    .then (manifest) ->
      state.manifest = manifest
      Promise.all (instrumentPromise(decodeCtx, key) for key in keys)
    .then ->
      master = offline.createGain()
      master.gain.value = volumeToGain state.masterVolume
      master.connect offline.destination
      voiceGains = {}
      for own label, indices of state.trackMap.byLabel
        gain = offline.createGain()
        gain.gain.value = voiceGainValue(state.voiceVolumes[label] ? DEFAULT_VOICE_VOLUME, state.voiceMuted[label] ? false)
        gain.connect master
        voiceGains[label] = gain
      trackGains = {}
      for track in state.tracks
        gain = offline.createGain()
        gain.gain.value = 1
        label = state.trackMap.byTrack[track.index]
        destination = if label? and voiceGains[label] then voiceGains[label] else master
        gain.connect destination
        trackGains[track.index] = gain
      for note in state.notes
        continue if note.start >= duration
        played = transposedNote note
        entry = state.instruments[state.trackSampleKeys[played.track]]
        continue unless entry?.buffer
        zone = selectSampleZone entry.zones, played.pitch, played.velocity
        continue unless zone
        createSampleSource offline, (trackGains[played.track] ? master),
          entry, zone, played.pitch, played.velocity, played.start, played.dur
      offline.startRendering()

  api.destroy = ->
    api.stop()
    disconnectGraph()
    releaseEngine()
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

  # Diagnostic / tests : programmes effectifs appliqués par canal.
  api.getProgramChanges = ->
    for entry in state.programChanges
      {channel: entry.channel, program: entry.program}

  # Diagnostic / tests : retard du fil principal au moment de confier chaque
  # note au graphe (déclenchement effectif - échéance prévue). Les débuts
  # eux-mêmes sont exacts : Web Audio les déclenche à l'échantillon près.
  # Null sans journal.
  api.getTimingStats = ->
    log = state.dispatchJitter ? []
    return null unless log.length
    stats = (entries) ->
      return null unless entries.length
      diffs = (Number entry.jitter for entry in entries)
      {
        count: diffs.length
        max: Math.max.apply null, (Math.abs(d) for d in diffs)
        rms: Math.sqrt diffs.reduce(((sum, d) -> sum + d * d), 0) / diffs.length
        mean: diffs.reduce(((sum, d) -> sum + d), 0) / diffs.length
      }
    {
      ...stats(log)
      on: stats(entry for entry in log when entry.kind is 'noteOn')
      off: null
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
  api.sampleKey = sampleKey
  api.selectSampleZone = selectSampleZone
  api.zonePlaybackRate = zonePlaybackRate
  api.zonePeakGain = zonePeakGain
  api.zoneEnvelopeLevel = zoneEnvelopeLevel
  api.SAMPLE_LEVEL = SAMPLE_LEVEL
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
