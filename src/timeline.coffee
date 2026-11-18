# timeline.coffee — manipulations purement fonctionnelles de la timeline.
#
# Aucun DOM, aucun audio : l'entrée est l'objet `timeline` produit par
# l'adaptateur scoretk, la sortie est un objet JS pur. Il est branché dans
# worker.coffee (slices, segments, marqueurs) et dans app.coffee (gel du suivi
# pendant une pause).
#
# Champs RÉELLEMENT produits par scoretk (scoretk-wasm 0.1.0), et seuls
# consommés ici :
#   timeline : { division, ticks, tempo: [{tick, timeUs,
#                microsecondsPerQuarter}], measures, pauses }
#   measures[i] : { measure, ordinal, segment, passage, tick, endTick,
#                   timeUs, endTimeUs, xmlId? }
#   pauses[i]   : { tick, endTick, timeUs, endTimeUs, seconds }
# Il n'y a PAS de `pauseBefore`, `ticksPerQuarter`, `durationTicks` ni
# `durationUs` à la racine, ni de durée dans `measures[i]` : la durée totale se
# dérive de `measures[dernier].endTimeUs` (repli sur `ticks` converti par la
# carte de tempo quand `measures` est vide).
#
# Les pauses n'ont pas de champ d'attachement : elles sont détectées par
# COÏNCIDENCE de `pause.tick` avec la fin (`endTick`) d'une mesure du slice
# (ou son début pour une pause initiale). La position dans `measures[]` et
# `segment` font foi ; `passage` n'est jamais un discriminant (le D.C. donne
# par exemple `segment=1` avec `passage=2`).
#
# Règles : `measure` est l'index 0-basé de la mesure ÉCRITE, global au
# fichier. `measures[]` contient une entrée par mesure JOUÉE, dans l'ordre
# d'exécution : une mesure écrite jamais jouée n'y figure pas, une mesure
# reprise y figure plusieurs fois. Les pauses sont incluses dans l'axe temps
# (le début de la mesure suivante tient compte de la pause). Les ticks font
# foi ; les millisecondes sont exposées pour éviter de refaire les tempos.
#
# API exposée (window.__musicaTimeline dans le navigateur, module.exports en
# CommonJS pour les tests Node) :
#   movementSlice(timeline, measureStart, measureEnd)
#       -> { measures, pauses, measureStart, measureEnd,
#            offsetUs, offsetMs, offsetTick, durationUs, durationMs, endTick }
#   buildSegments(slice, pauses)
#       -> [{measure, fromMs, toMs, offsetMs}]
#   buildSyncMarks(slice, pageByWrittenIndex, measureStart)
#       -> {marks: [{t, page, id}], unresolved}
#   pauseAt(pauses, tMs) -> pause active ou null
#
# Le remappage des notes sur les segments reste dans audio.coffee
# (`remapNotesToSegments`) : aucun doublon n'est créé ici.
#
# Arrondi : les µs sont entiers et font foi. `timeMs` vaut Math.round(µs /
# 1000), arrondi au plus proche (les .5 montent). Les millisecondes relatives
# sont recalculées depuis les µs relatives, jamais par différence de deux
# arrondis, pour ne pas cumuler le décalage.

roundMs = (us) ->
  Math.round(us / 1000)

toNum = (value, fallback = NaN) ->
  n = Number value
  if isFinite(n) then n else fallback

copyObject = (source) ->
  out = {}
  out[key] = value for own key, value of source
  out

# Conversion ticks -> µs avec la carte de tempo. Sert uniquement de repli
# quand une durée en µs manque (timeline sans `measures`).
tickToUs = (source, tick) ->
  target = toNum tick
  return NaN unless isFinite target
  tempo = source?.tempo
  return NaN unless Array.isArray(tempo) and tempo.length
  division = toNum source.division, 480
  return NaN unless isFinite(division) and division > 0
  best = null
  for entry in tempo
    entryTick = toNum entry.tick
    continue unless isFinite entryTick
    best = entry if entryTick <= target and (not best? or entryTick >= toNum(best.tick))
  best ?= tempo[0]
  baseTick = toNum best.tick, 0
  baseUs = toNum best.timeUs, 0
  mpq = toNum best.microsecondsPerQuarter, 500000
  baseUs + (target - baseTick) * mpq / division

# Durée totale en µs d'une timeline : dernier `endTimeUs` des mesures jouées,
# sinon `ticks` converti par la carte de tempo.
timelineEndUs = (source) ->
  all = if Array.isArray(source) then source else (source?.measures ? [])
  if all.length
    last = all[all.length - 1]
    endUs = toNum last.endTimeUs
    return endUs if isFinite endUs
    endTick = toNum last.endTick, toNum(last.tick, 0)
    return tickToUs source, endTick
  tickToUs source, (toNum source?.ticks, 0)

# Fin d'une pause en millisecondes, avec replis successifs si certains champs
# de temps manquent (les tests synthétiques peuvent n'en fournir qu'une partie).
pauseEndMs = (pause) ->
  endUs = toNum pause.endTimeUs
  return roundMs(endUs) if isFinite endUs
  startUs = toNum pause.timeUs
  seconds = toNum pause.seconds
  if isFinite(startUs) and isFinite(seconds)
    return roundMs(startUs + seconds * 1000000)
  endMs = toNum pause.endTimeMs
  return endMs if isFinite endMs
  startMs = toNum pause.timeMs
  if isFinite(startMs) and isFinite(seconds)
    return startMs + seconds * 1000
  null

pauseStartMs = (pause) ->
  startUs = toNum pause.timeUs
  return startUs / 1000 if isFinite startUs
  startMs = toNum pause.timeMs
  return startMs if isFinite startMs
  seconds = toNum pause.seconds
  endUs = toNum pause.endTimeUs
  return (endUs / 1000 - seconds * 1000) if isFinite(endUs) and isFinite(seconds)
  null

# Sous-ensemble d'un mouvement : entrées dont `measure` appartient à
# [measureStart, measureEnd), dans l'ordre du tableau. Les temps sont ramenés
# au début de la première entrée retenue ; les pauses de l'intervalle suivent
# le même décalage. Un slice vide reste un objet bien formé.
movementSlice = (timeline, measureStart = 0, measureEnd = null) ->
  source = timeline ? {}
  all = if Array.isArray(source) then source else (source.measures ? [])
  start = toNum(measureStart, 0)
  stop = if measureEnd? then toNum(measureEnd, Infinity) else Infinity
  stop = Infinity unless isFinite stop
  selected = []
  for entry in all
    measure = toNum entry.measure
    continue unless isFinite measure
    selected.push entry if measure >= start and measure < stop

  result =
    measures: []
    pauses: []
    measureStart: start
    measureEnd: stop
    offsetUs: 0
    offsetMs: 0
    offsetTick: 0
    durationUs: 0
    durationMs: 0
    endTick: 0

  unless selected.length
    # Repli : timeline sans mesures, mais avec `ticks` et une carte de tempo.
    if not all.length and Array.isArray(source.measures)
      endUs = timelineEndUs source
      if isFinite endUs
        result.durationUs = Math.max 0, endUs
        result.durationMs = roundMs result.durationUs
        result.endTick = Math.max 0, toNum(source.ticks, 0)
    return result

  first = selected[0]
  baseTick = toNum(first.tick, 0)
  baseUs = toNum(first.timeUs, 0)
  baseMs = roundMs baseUs
  result.offsetUs = baseUs
  result.offsetMs = baseMs
  result.offsetTick = baseTick

  endTickAbs = 0
  endUsAbs = 0
  for entry in selected
    tick = toNum entry.tick, 0
    endTick = toNum entry.endTick, tick
    endTickAbs = endTick if endTick > endTickAbs
    timeUs = toNum entry.timeUs, 0
    endTimeUs = toNum entry.endTimeUs, timeUs
    endUsAbs = endTimeUs if endTimeUs > endUsAbs
    rel = copyObject entry
    rel.measure = toNum entry.measure, 0
    rel.tick = tick - baseTick
    rel.endTick = endTick - baseTick
    rel.timeUs = timeUs - baseUs
    rel.endTimeUs = endTimeUs - baseUs
    rel.timeMs = roundMs rel.timeUs
    rel.endTimeMs = roundMs rel.endTimeUs
    # Décalage absolu appliqué à cette entrée (le même pour tout le slice).
    rel.offsetUs = baseUs
    rel.offsetMs = baseMs
    rel.offsetTick = baseTick
    result.measures.push rel

  # Pauses dont le début tombe dans l'intervalle [première mesure, fin de la
  # dernière mesure retenue]. Une pause qui commence exactement à la fin de la
  # dernière mesure fait partie du mouvement.
  lastEndTick = 0
  for entry in selected
    tick = toNum entry.tick, 0
    lastEndTick = Math.max lastEndTick, toNum(entry.endTick, tick)
  for pause in (source.pauses ? [])
    tick = toNum pause.tick
    continue unless isFinite tick
    continue if tick < toNum(selected[0].tick, 0) or tick > lastEndTick
    timeUs = toNum pause.timeUs
    continue unless isFinite timeUs
    endTimeUs = toNum pause.endTimeUs, timeUs
    endUsAbs = endTimeUs if endTimeUs > endUsAbs
    rel = copyObject pause
    rel.tick = tick - baseTick
    rel.endTick = toNum(pause.endTick, tick) - baseTick
    rel.timeUs = timeUs - baseUs
    rel.endTimeUs = endTimeUs - baseUs
    rel.timeMs = roundMs rel.timeUs
    rel.endTimeMs = roundMs rel.endTimeUs
    rel.offsetUs = baseUs
    rel.offsetMs = baseMs
    rel.offsetTick = baseTick
    result.pauses.push rel

  result.durationUs = Math.max(0, endUsAbs - baseUs)
  result.durationMs = roundMs result.durationUs
  result.endTick = Math.max(0, endTickAbs - baseTick)
  result

# Segments de lecture linéaire d'un slice. Le paramètre `pauses` est optionnel :
# à défaut, on reprend slice.pauses. Chaque segment couvre la mesure depuis son
# `timeMs` jusqu'au début de la mesure suivante, ou jusqu'à la fin du mouvement
# pour la dernière. Les pauses sont INCLUSES : une pause qui coïncide avec la
# fin d'une mesure étend `toMs` jusqu'à la FIN de la pause, sinon on décalerait
# toutes les notes suivantes sans aucun signal. `offsetMs` est l'offset cumulé
# du segment dans la timeline du mouvement (somme des durées des segments
# précédents).
buildSegments = (slice, pauses) ->
  meta = if Array.isArray(slice) then {} else (slice ? {})
  entries = if Array.isArray(slice) then slice else (meta.measures ? [])
  pauseList = pauses ? meta.pauses ? []
  out = []
  return out unless entries.length

  last = entries[entries.length - 1]
  endUs = toNum last.endTimeUs
  unless isFinite endUs
    endUs = tickToUs meta, (toNum last.endTick, toNum(last.tick, 0))
  endMs = if isFinite endUs then roundMs(endUs) else roundMs(toNum(last.timeUs, 0))

  offset = 0
  for entry, index in entries
    fromMs = toNum entry.timeMs, roundMs(toNum(entry.timeUs, 0))
    next = entries[index + 1]
    boundary = if next? then toNum(next.timeMs, roundMs(toNum(next.timeUs, 0))) else endMs
    boundary = Math.max boundary, fromMs

    entryTick = toNum entry.tick, 0
    entryEndTick = toNum entry.endTick, entryTick

    # Détection par coïncidence : la pause commence exactement à la fin de
    # cette mesure (ou à son début pour la toute première). Aucun champ
    # d'attachement n'est utilisé.
    for pause in (pauseList ? [])
      tick = toNum pause.tick
      continue unless isFinite tick
      afterMeasure = tick is entryEndTick
      leadingPause = index is 0 and tick is entryTick
      continue unless afterMeasure or leadingPause
      pauseEnd = pauseEndMs pause
      boundary = Math.max boundary, pauseEnd if isFinite pauseEnd

    toMs = Math.max boundary, fromMs
    out.push
      measure: entry.measure
      fromMs: fromMs
      toMs: toMs
      offsetMs: offset
    offset += toMs - fromMs
  out

# Marqueurs de synchronisation d'un slice. `pageByWrittenIndex` est la carte
# page par index écrit LOCAL au slice (index = measure - measureStart), comme
# dans le futur adaptateur. Une page non résolue n'est pas ignorée en silence :
# elle incrémente `unresolved`. Les marqueurs sont triés par t et les doublons
# consécutifs de même (page, id) sont fusionnés.
buildSyncMarks = (slice, pageByWrittenIndex, measureStart) ->
  meta = if Array.isArray(slice) then {} else (slice ? {})
  entries = if Array.isArray(slice) then slice else (meta.measures ? [])
  start = toNum measureStart
  unless isFinite start
    start = toNum meta.measureStart, 0
  start = 0 unless isFinite start

  marks = []
  unresolved = 0
  for entry in entries
    measure = toNum entry.measure
    unless isFinite measure
      unresolved += 1
      continue
    localIndex = measure - start
    page = null
    if Array.isArray pageByWrittenIndex
      page = pageByWrittenIndex[localIndex]
    else if pageByWrittenIndex? and typeof pageByWrittenIndex is 'object'
      # Repli : carte indexée globalement, puis localement.
      page = if pageByWrittenIndex[measure]? then pageByWrittenIndex[measure] else pageByWrittenIndex[localIndex]
    page = Number page
    unless isFinite(page) and page > 0
      unresolved += 1
      continue
    t = toNum entry.timeMs, roundMs(toNum(entry.timeUs, 0))
    id = entry.xmlId ? entry.id ? "m#{measure}"
    marks.push {t, page, id: String(id)}

  marks.sort (a, b) -> a.t - b.t
  deduped = []
  for mark in marks
    prev = deduped[deduped.length - 1]
    continue if prev and prev.page is mark.page and prev.id is mark.id
    deduped.push mark
  {marks: deduped, unresolved}

# Pause active à l'instant tMs : intervalle semi-ouvert [début, fin). Retourne
# l'objet de la liste tel quel, ou null avant, après, ou hors de toute pause.
pauseAt = (pauses, tMs) ->
  return null unless Array.isArray pauses
  t = Number tMs
  return null unless isFinite t
  for pause in pauses
    startMs = pauseStartMs pause
    endMs = pauseEndMs pause
    continue unless isFinite(startMs) and isFinite(endMs)
    return pause if t >= startMs and t < endMs
  null

api = {movementSlice, buildSegments, buildSyncMarks, pauseAt}

window.__musicaTimeline = api if typeof window isnt 'undefined'
self.__musicaTimeline = api if typeof self isnt 'undefined'
module.exports = api if typeof module isnt 'undefined' and module.exports?
