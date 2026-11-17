# midi.coffee — Parseur minimal de fichiers MIDI standard (SMF)
#
# Aucun DOM : l'entrée est un Uint8Array (ou ArrayBuffer), la sortie est un
# objet JS pur. Le moteur audio et la synchronisation consomment ce module.
#
# API exportée (window.__musicaMidi dans le navigateur, module.exports en
# CommonJS pour les tests Node) :
#   parse(data)             -> { format, division, ticksPerQuarter, smpte,
#                                tempos, tracks, duration }
#   parseBase64(b64)        -> même objet, à partir d'une chaîne base64
#   durationSeconds(data)   -> durée en secondes (Uint8Array ou base64)
#   decodeBase64(b64)       -> Uint8Array (accepte préfixe data: et URL-safe)
#
# Les temps (start/dur/duration) sont en secondes, calculés via une carte de
# tempo globale fusionnée sur toutes les pistes et tous les canaux.

DEFAULT_TEMPO = 500000  # microsecondes par noire (120 BPM)

# --- Utilitaires octets ----------------------------------------------------

toBytes = (data) ->
  return data if data instanceof Uint8Array
  if data instanceof ArrayBuffer
    return new Uint8Array data
  if Array.isArray data
    return Uint8Array.from data
  throw new Error "Données MIDI invalides : Uint8Array ou ArrayBuffer attendu"

# Petit lecteur séquentiel avec messages d'erreur contextualisés
makeReader = (bytes, label) ->
  pos = 0
  fail = (msg) ->
    throw new Error "#{label} : #{msg} (offset #{pos})"
  reader =
    pos: -> pos
    remaining: -> bytes.length - pos
    seek: (p) -> pos = p
    u8: ->
      fail("fin de fichier inattendue") if pos >= bytes.length
      b = bytes[pos]
      pos += 1
      b
    u16: ->
      ((reader.u8() << 8) | reader.u8()) & 0xffff
    u32: ->
      reader.u8() * 0x1000000 +
        ((reader.u8() << 16) | (reader.u8() << 8) | reader.u8())
    bytes: (n) ->
      fail("lecture de #{n} octet(s) au-delà de la fin des données") if n < 0 or pos + n > bytes.length
      out = bytes.subarray pos, pos + n
      pos += n
      out
  reader

# Delta-time / longueur à longueur variable (VLQ, 1 à 4 octets)
readVarInt = (r, label) ->
  value = 0
  count = 0
  loop
    b = r.u8()
    value = (value << 7) | (b & 0x7f)
    count += 1
    break if (b & 0x80) is 0
    if count >= 4
      throw new Error "#{label} : valeur à longueur variable invalide (plus de 4 octets, offset #{r.pos()})"
  value

decodeText = (bytes) ->
  return '' unless bytes and bytes.length
  if typeof TextDecoder isnt 'undefined'
    try
      return (new TextDecoder 'utf-8').decode bytes
    catch
      null
  text = ''
  text += String.fromCharCode b for b in bytes
  text

# --- Analyse d'une piste ---------------------------------------------------

# Les notes sont appariées par (canal, hauteur) : une pile FIFO par couple,
# ce qui gère les répétitions et les accords de même hauteur.
parseTrack = (bytes, index) ->
  label = "Piste #{index}"
  r = makeReader bytes, label
  tick = 0
  running = null
  name = null
  channel = null
  program = null
  notes = []
  open = {}
  tempos = []
  lastTick = 0

  # Lit n octets de données (en réutilisant l'octet déjà lu en running status)
  readData = (n, first) ->
    out = []
    out.push first if first?
    while out.length < n
      d = r.u8()
      if d >= 0x80
        throw new Error "#{label} : octet de données attendu, 0x#{d.toString 16} trouvé (offset #{r.pos() - 1})"
      out.push d
    out

  closeNote = (ch, pitch, atTick) ->
    key = "#{ch}:#{pitch}"
    stack = open[key]
    return unless stack and stack.length
    n = stack.shift()
    delete open[key] unless stack.length
    n.endTick = if atTick > n.startTick then atTick else n.startTick
    notes.push n

  stop = false
  while r.remaining() > 0 and not stop
    delta = readVarInt r, label
    tick += delta
    lastTick = tick if tick > lastTick

    b = r.u8()
    first = null
    if b >= 0x80
      status = b
      # Le running status ne vaut que pour les messages de canal ; les
      # méta-événements et sysex l'annulent.
      running = if status < 0xF0 then status else null
    else
      unless running?
        throw new Error "#{label} : running status sans statut précédent (offset #{r.pos() - 1})"
      status = running
      first = b

    if status < 0xF0
      type = status >> 4
      ch = status & 0x0f
      channel = ch unless channel?
      if type is 0x8                                   # noteOff
        [pitch, vel] = readData 2, first
        closeNote ch, pitch, tick
      else if type is 0x9                               # noteOn (vélocité 0 = noteOff)
        [pitch, vel] = readData 2, first
        if vel is 0
          closeNote ch, pitch, tick
        else
          key = "#{ch}:#{pitch}"
          (open[key] ?= []).push { startTick: tick, pitch, velocity: vel }
      else if type is 0xC                               # programChange
        [p] = readData 1, first
        program = p unless program?
      else if type is 0xA or type is 0xB or type is 0xE  # aftertouch, CC, pitch bend
        readData 2, first
      else                                              # 0xD channel pressure
        readData 1, first
    else if status is 0xFF
      metaType = r.u8()
      len = readVarInt r, label
      mdata = r.bytes len
      if metaType is 0x2F                               # endOfTrack
        stop = true
      else if metaType is 0x51                          # setTempo
        if len < 3
          throw new Error "#{label} : setTempo invalide (longueur #{len}, 3 attendu)"
        us = (mdata[0] << 16) | (mdata[1] << 8) | mdata[2]
        tempos.push { tick, usPerQuarter: us } if us > 0
      else if metaType is 0x03                          # trackName
        name = decodeText mdata unless name?
      # Les autres méta-événements sont ignorés
    else if status is 0xF0 or status is 0xF7            # sysex
      len = readVarInt r, label
      r.bytes len
    else
      throw new Error "#{label} : événement système non pris en charge (0x#{status.toString 16})"

  { index, name, channel, program, notes, open, tempos, lastTick }

# --- Analyse du fichier ----------------------------------------------------

parse = (data) ->
  bytes = toBytes data
  label = "SMF"

  if bytes.length < 14
    throw new Error "Fichier MIDI trop court : #{bytes.length} octet(s), en-tête MThd de 14 octets minimum attendu"

  headerId = String.fromCharCode bytes[0], bytes[1], bytes[2], bytes[3]
  unless headerId is 'MThd'
    throw new Error "En-tête MIDI invalide : 'MThd' attendu, '#{headerId}' trouvé"

  r = makeReader bytes, label
  r.seek 4
  headerLen = r.u32()
  if headerLen < 6
    throw new Error "En-tête MThd invalide : longueur #{headerLen}, 6 octets attendus"
  if 8 + headerLen > bytes.length
    throw new Error "En-tête MThd tronqué : longueur #{headerLen} annoncée, #{bytes.length - 8} octet(s) disponible(s)"

  format = r.u16()
  ntrks = r.u16()
  division = r.u16()
  unless format in [0, 1, 2]
    throw new Error "Format MIDI non pris en charge : #{format}, 0, 1 ou 2 attendu"
  if ntrks is 0
    throw new Error "Fichier MIDI sans piste : ntrks = 0"

  # Division : ticks par noire, ou SMPTE (noirs par seconde)
  smpte = null
  ticksPerQuarter = null
  if division & 0x8000
    fps = 256 - ((division >> 8) & 0xff)
    ticksPerFrame = division & 0xff
    if fps <= 0 or ticksPerFrame <= 0
      throw new Error "Division SMPTE invalide : 0x#{division.toString 16}"
    smpte = { fps, ticksPerFrame, ticksPerSecond: fps * ticksPerFrame }
  else
    ticksPerQuarter = division
    throw new Error "Division invalide : 0 tick par noire" if ticksPerQuarter is 0

  r.seek 8 + headerLen

  rawTracks = []
  while r.remaining() > 0
    if r.remaining() < 8
      throw new Error "Chunk MIDI tronqué : en-tête de 8 octets attendu, #{r.remaining()} octet(s) restant(s)"
    chunkId = String.fromCharCode r.u8(), r.u8(), r.u8(), r.u8()
    chunkLen = r.u32()
    if chunkLen > r.remaining()
      throw new Error "Chunk '#{chunkId}' tronqué : #{chunkLen} octet(s) annoncé(s), #{r.remaining()} disponible(s)"
    chunkBytes = r.bytes chunkLen
    # Les chunks inconnus sont ignorés, conformément à la spécification SMF
    rawTracks.push parseTrack chunkBytes, rawTracks.length if chunkId is 'MTrk'

  throw new Error "Aucun chunk MTrk trouvé dans le fichier MIDI" if rawTracks.length is 0
  if rawTracks.length < ntrks
    throw new Error "Fichier MIDI incohérent : en-tête ntrks = #{ntrks}, #{rawTracks.length} piste(s) MTrk trouvée(s)"

  # Carte de tempo globale : événements de toutes les pistes, triés par tick
  # puis par ordre de déclaration (à tick égal, le dernier déclaré gagne).
  tempoEvents = [{ tick: 0, seq: 0, usPerQuarter: DEFAULT_TEMPO }]
  seq = 1
  for t in rawTracks
    for e in t.tempos
      tempoEvents.push { tick: e.tick, seq: seq++, usPerQuarter: e.usPerQuarter }
  tempoEvents.sort (a, b) -> (a.tick - b.tick) or (a.seq - b.seq)

  if smpte
    toSeconds = (tick) -> tick / smpte.ticksPerSecond
  else
    toSeconds = (tick) ->
      sec = 0
      prevTick = 0
      tempo = DEFAULT_TEMPO
      for e in tempoEvents
        break if e.tick > tick
        sec += (e.tick - prevTick) * tempo / ticksPerQuarter / 1000000
        prevTick = e.tick
        tempo = e.usPerQuarter
      sec += (tick - prevTick) * tempo / ticksPerQuarter / 1000000
      sec

  maxTick = 0
  for t in rawTracks
    maxTick = t.lastTick if t.lastTick > maxTick

  # Notes restées ouvertes : fermées à la fin globale du morceau
  for t in rawTracks
    for key, stack of t.open
      for n in stack
        n.endTick = maxTick
        t.notes.push n
    t.open = null
    t.notes.sort (a, b) -> a.startTick - b.startTick

  tracks = (t for t in rawTracks).map (t) ->
    index = t.index
    {
      index
      name: t.name or null
      channel: t.channel
      program: t.program
      notes: t.notes.map (n) ->
        start = toSeconds n.startTick
        stop = toSeconds (if n.endTick > n.startTick then n.endTick else n.startTick)
        { start, dur: stop - start, pitch: n.pitch, velocity: n.velocity }
    }

  # Fusion des tempos par tick pour l'export (le dernier déclaré gagne)
  mergedTempos = []
  for e in tempoEvents
    if mergedTempos.length and mergedTempos[mergedTempos.length - 1].tick is e.tick
      mergedTempos[mergedTempos.length - 1] = e
    else
      mergedTempos.push e

  tempos = mergedTempos.map (e) ->
    { tick: e.tick, seconds: toSeconds(e.tick), microsecondsPerQuarter: e.usPerQuarter }

  {
    format
    division
    ticksPerQuarter
    smpte
    tempos
    tracks
    duration: toSeconds(maxTick)
  }

# --- Base64 et helpers -----------------------------------------------------

decodeBase64 = (b64) ->
  unless typeof b64 is 'string'
    throw new Error "Décodage base64 : chaîne attendue"
  str = b64.replace /\s+/g, ''
  m = str.match /^data:[^,]*;base64,(.*)$/
  str = m[1] if m
  str = str.replace(/-/g, '+').replace(/_/g, '/')
  pad = str.length % 4
  throw new Error "Chaîne base64 invalide (longueur #{str.length})" if pad is 1
  str += '='.repeat 4 - pad if pad
  if typeof Buffer isnt 'undefined' and Buffer.from
    new Uint8Array Buffer.from str, 'base64'
  else if typeof atob is 'function'
    bin = atob str
    out = new Uint8Array bin.length
    for i in [0...bin.length]
      out[i] = bin.charCodeAt i
    out
  else
    throw new Error "Décodage base64 indisponible dans cet environnement"

parseBase64 = (b64) -> parse decodeBase64 b64

durationSeconds = (data) ->
  parse(if typeof data is 'string' then decodeBase64(data) else data).duration

api = { parse, parseBase64, durationSeconds, decodeBase64 }

window.__musicaMidi = api if typeof window isnt 'undefined'
module.exports = api if typeof module isnt 'undefined' and module.exports?
