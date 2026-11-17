# timeline.coffee — manipulations purement fonctionnelles de la timeline.
#
# Aucun DOM, aucun audio : l'entrée est l'objet `timeline` produit par le
# futur adaptateur scoretk, la sortie est un objet JS pur. Ce module prépare
# la migration scoretk ; il n'est encore branché ni dans app.coffee ni dans
# worker.coffee.
#
# Contrat de la timeline d'entrée (champs figés) :
#   { expandRepeats, division, ticksPerQuarter, durationTicks, durationUs,
#     tempo: [{tick, timeUs, microsecondsPerQuarter}],
#     measures: [{measure, segment, passage, xmlId, tick, endTick,
#                 timeUs, endTimeUs, timeMs, durationTicks, durationUs,
#                 pauseBefore}],
#     pauses: [{tick, endTick, timeUs, endTimeUs, seconds}] }
#
# Règles : `measure` est l'index 0-basé de la mesure ÉCRITE, global au
# fichier. `measures[]` contient une entrée par mesure JOUÉE, dans l'ordre
# d'exécution : une mesure écrite jamais jouée n'y figure pas. Les pauses sont
# incluses dans l'axe temps (le début de la mesure suivante tient compte de la
# pause). Les ticks font foi ; les millisecondes sont exposées pour éviter de
# refaire les tempos.
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

  return result unless selected.length

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
    rel.durationTicks = endTick - tick
    rel.durationUs = endTimeUs - timeUs
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
# pour la dernière. Les pauses sont INCLUSES : si une pause suit la mesure,
# `toMs` va jusqu'à la fin de la pause, sinon on décalerait toutes les notes
# suivantes sans aucun signal. `offsetMs` est l'offset cumulé du segment dans
# la timeline du mouvement (somme des durées des segments précédents).
buildSegments = (slice, pauses) ->
  meta = if Array.isArray(slice) then {} else (slice ? {})
  entries = if Array.isArray(slice) then slice else (meta.measures ? [])
  pauseList = pauses ? meta.pauses ? []
  out = []
  return out unless entries.length

  last = entries[entries.length - 1]
  endMs = toNum meta.durationMs
  unless isFinite endMs
    endUs = toNum meta.durationUs
    endMs = if isFinite(endUs) then roundMs(endUs) else roundMs(toNum(last.endTimeUs, toNum(last.timeUs, 0)))

  offset = 0
  for entry, index in entries
    fromMs = toNum entry.timeMs, roundMs(toNum(entry.timeUs, 0))
    next = entries[index + 1]
    boundary = if next? then toNum(next.timeMs, roundMs(toNum(next.timeUs, 0))) else endMs
    boundary = Math.max boundary, fromMs

    lowerTick = toNum entry.tick, -Infinity
    upperTick = if next?
      toNum next.tick, Infinity
    else
      Math.max toNum(meta.endTick, toNum(entry.endTick, 0)), toNum(entry.endTick, 0)

    for pause in (pauseList ? [])
      tick = toNum pause.tick
      continue unless isFinite tick
      continue if tick < lowerTick
      if next?
        continue if tick >= upperTick
      else
        continue if tick > upperTick
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
module.exports = api if typeof module isnt 'undefined' and module.exports?
