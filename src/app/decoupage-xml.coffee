# Découpage du MusicXML en mouvements et application des réglages de voix
# (masquage, tailles) au document rendu par Verovio.
# Capture the attributes in effect at each split point, in one pass per part
# Returns {splitIndex: [attributes per part]}
captureSplitAttrs = (parts, splitPoints) ->
  splitAttrs = {}
  for splitIndex in splitPoints
    splitAttrs[splitIndex] = []
  for part in parts
    state =
      staves: null
      clefs: []
      key: null
      time: null
      divisions: null
      transpose: null
    for measure, i in part.querySelectorAll("measure")
      # Snapshot the state before this measure, i.e. as it starts
      splitAttrs[i].push Object.assign({}, state) if splitAttrs[i]?
      attrs = measure.querySelector("attributes")
      if attrs
        staves = attrs.querySelector("staves")
        state.staves = staves if staves
        clefs = attrs.querySelectorAll("clef")
        state.clefs = Array.from(clefs) if clefs.length > 0
        key = attrs.querySelector("key")
        state.key = key if key
        time = attrs.querySelector("time")
        state.time = time if time
        divisions = attrs.querySelector("divisions")
        state.divisions = divisions if divisions
        transpose = attrs.querySelector("transpose")
        state.transpose = transpose if transpose
  splitAttrs

# Aligne les identifiants de mesure sur ceux de la timeline scoretk : scoretk
# nomme la mesure m d'une partie p « p{p}-m{m} » dans sa timeline, mais son
# export MusicXML simple n'écrit pas d'id. On les pose donc ici, une fois, pour
# que Verovio conserve ces ids (son measureOn) et que la jointure page↔temps
# puisse se faire par identifiant et non par position, y compris quand Verovio
# replie les mesures d'un multi-repos.
ensureMeasureIds = (doc) ->
  for part, p in Array.from doc.querySelectorAll "part"
    for measure, m in Array.from part.querySelectorAll "measure"
      continue if measure.getAttribute "id"
      id = "p#{p}-m#{m}"
      measure.setAttribute "id", id
      measure.setAttributeNS "http://www.w3.org/XML/1998/namespace", "xml:id", id
  doc

# Detect split points and capture attributes at each point (lazy approach)
# Returns {doc, splitPoints, splitAttrs, totalMeasures}
detectSplitPoints = (xmlString) ->
  doc = new DOMParser().parseFromString xmlString, "application/xml"

  # Insert system breaks once, in place: preprocessMusicXML only adds <print>
  # elements, which neither detection below nor the measure list observe.
  preprocessMusicXML doc
  ensureMeasureIds doc

  parts = doc.querySelectorAll("part")
  unless parts.length > 0
    return {doc, splitPoints: [], splitAttrs: {}, totalMeasures: 0}

  firstPartMeasures = parts[0].querySelectorAll("measure")
  totalMeasures = firstPartMeasures.length
  MAX_MEASURES_PER_MOVEMENT = 50

  splitPoints = []

  # PHASE 1: Movement metadata
  for measure, i in firstPartMeasures
    mn = measure.querySelector("movement-number")
    if mn and i > 0
      splitPoints.push i
      console.log "Mouvement déclaré à la mesure #{i}"

  # PHASE 2: Split at double barlines if needed
  if splitPoints.length is 0 and totalMeasures > MAX_MEASURES_PER_MOVEMENT
    allDoubleBarlines = []
    for measure, i in firstPartMeasures
      continue if i is 0 or i >= totalMeasures - 2
      barlines = measure.querySelectorAll('barline[location="right"]')
      for barline in Array.from(barlines)
        barStyle = barline.querySelector("bar-style")
        if barStyle
          style = barStyle.textContent.trim()
          if style is "light-heavy"
            hasDS = measure.querySelector('sound[dalsegno]')
            hasDC = measure.querySelector('sound[dacapo]')
            unless hasDS or hasDC
              nextMeasure = firstPartMeasures[i + 1]
              if nextMeasure and nextMeasure.querySelector("note")
                allDoubleBarlines.push i + 1

    prevSplit = 0
    for sp in allDoubleBarlines
      segmentSize = sp - prevSplit
      if segmentSize >= MAX_MEASURES_PER_MOVEMENT
        splitPoints.push sp
        prevSplit = sp

    lastSplit = if splitPoints.length > 0 then splitPoints[splitPoints.length - 1] else 0
    remainingMeasures = totalMeasures - lastSplit

    while remainingMeasures > MAX_MEASURES_PER_MOVEMENT
      foundSplit = false
      for sp in allDoubleBarlines
        if sp > lastSplit and sp - lastSplit >= MAX_MEASURES_PER_MOVEMENT
          splitPoints.push sp
          lastSplit = sp
          remainingMeasures = totalMeasures - lastSplit
          foundSplit = true
          break
      break unless foundSplit

    console.log "Double barres trouvées: #{allDoubleBarlines.join(', ')}" if allDoubleBarlines.length > 0

  splitPoints = [...new Set(splitPoints)].sort((a, b) -> a - b)
  console.log "Points de découpage: #{splitPoints.join(', ')}" if splitPoints.length > 0

  # Capture attributes at each split point
  splitAttrs = captureSplitAttrs parts, splitPoints

  {doc, splitPoints, splitAttrs, totalMeasures}

# Libellé de chaque voix d'un document : part-name, sinon part-abbreviation,
# sinon id (la règle d'affichage du panneau). Les voix sont identifiées par ce
# libellé et non par leur id : chaque fichier d'une entrée renumérote ses
# parties à partir de P1. Un même libellé répété dans le document est suffixé
# « #2 », « #3 »... dans l'ordre du part-list.
partLabels = (doc) ->
  labels = {}
  used = new Set()
  for part in Array.from doc.querySelectorAll "score-part"
    id = part.getAttribute "id"
    name = part.querySelector("part-name")?.textContent.trim()
    name = part.querySelector("part-abbreviation")?.textContent.trim() unless name
    base = name or id
    label = base
    n = 1
    while used.has label
      n += 1
      label = "#{base} ##{n}"
    used.add label
    labels[id] = label
  labels

# Retire d'un document les parties masquées et leur entrée de <part-list>
removeHiddenParts = (doc, hidden, labels = partLabels doc) ->
  return doc unless hidden.size > 0
  for el in Array.from doc.querySelectorAll("part, score-part")
    id = el.getAttribute "id"
    el.parentNode.removeChild el if labels[id]? and hidden.has labels[id]
  doc

# Taille des voix : <staff-details><staff-size>N</staff-size></staff-details>
# Réutilise (et met à l'échelle) les staff-details existants de la partie :
# Verovio ignore un second staff-details. La taille choisie est relative à
# leur staff-size d'origine (100 s'il est absent).
applyPartSizes = (doc, labels = partLabels doc) ->
  return doc if Object.keys(partSizes).length is 0
  for part in Array.from doc.querySelectorAll "part"
    size = partSizes[labels[part.getAttribute "id"]]
    continue unless size? and size isnt 100
    measure = part.querySelector "measure"
    continue unless measure
    attrs = measure.querySelector "attributes"
    unless attrs
      attrs = doc.createElement "attributes"
      measure.insertBefore attrs, measure.firstChild
    staves = parseInt attrs.querySelector("staves")?.textContent ? "1"
    staves = 1 unless staves > 1
    # staff-details sans number : toutes les portées ; avec number : une portée
    existing = Array.from part.querySelectorAll "staff-details"
    covers = (details, n) ->
      num = details.getAttribute "number"
      not num? or parseInt(num) is n
    # staff-details se place après les clefs, avant transpose et suivants
    anchor = null
    for child in attrs.children
      if child.tagName in ["transpose", "for-part", "directive", "measure-style"]
        anchor = child
        break
    # Taille relative à la valeur d'origine de chaque staff-details
    setSize = (details) ->
      sizeEl = details.querySelector "staff-size"
      origin = if sizeEl then parseFloat(sizeEl.textContent) else 100
      unless sizeEl
        sizeEl = doc.createElement "staff-size"
      # staff-size est le dernier enfant prévu par le schéma
      details.appendChild sizeEl
      sizeEl.textContent = String Math.round(origin * size) / 100
    # Tous les staff-details de la partie, quelle que soit la mesure
    setSize details for details in existing
    # Portée sans staff-details : en créer un dans la première mesure
    for n in [1..staves]
      continue if existing.some (el) -> covers el, n
      details = doc.createElement "staff-details"
      details.setAttribute "number", String(n) if staves > 1
      attrs.insertBefore details, anchor
      setSize details
  doc

# Applique masquage et tailles à un mouvement. Les voix sont identifiées par
# leur libellé (partLabels), pas par leur id renuméroté dans chaque fichier.
# Un mouvement dont toutes les voix sont masquées est affiché sans masquage :
# il ne doit jamais devenir vide.
applyPartsSettings = (doc) ->
  labels = partLabels doc
  hidden = hiddenParts
  parts = Array.from doc.querySelectorAll "score-part"
  if parts.length > 0 and parts.every((part) -> hiddenParts.has labels[part.getAttribute "id"])
    hidden = new Set()
  removeHiddenParts doc, hidden, labels
  applyPartSizes doc, labels
  doc

# Extract a single movement by index (lazy extraction)
# movementIndex: 0-based, where 0 is first movement
extractMovement = (splitInfo, movementIndex) ->
  {doc, splitPoints, splitAttrs, totalMeasures} = splitInfo
  serializer = new XMLSerializer()

  # No splits: the whole document is movement 0
  if splitPoints.length is 0
    return null unless movementIndex is 0
    clone = doc.cloneNode true
    applyPartsSettings clone
    return serializer.serializeToString clone

  # Calculate start and end measure indices for this movement
  allPoints = [0, ...splitPoints, totalMeasures]
  startMeasure = allPoints[movementIndex]
  endMeasure = allPoints[movementIndex + 1]

  unless startMeasure? and endMeasure?
    return null

  # Work on a copy: the split document stays intact for the other movements
  clone = doc.cloneNode true

  for part, pIdx in clone.querySelectorAll("part")
    # Remove measures outside this movement
    for measure, i in Array.from(part.querySelectorAll("measure")) when i < startMeasure or i >= endMeasure
      measure.parentNode.removeChild measure

    # Insert attributes at start if not first movement
    if startMeasure > 0 and splitAttrs[startMeasure]?[pIdx]
      attrs = splitAttrs[startMeasure][pIdx]
      firstMeasure = part.querySelector("measure")
      if firstMeasure
        existingAttrs = firstMeasure.querySelector("attributes")

        newAttrsEl = clone.createElement("attributes")
        if attrs.divisions
          newAttrsEl.appendChild attrs.divisions.cloneNode(true)
        if attrs.key
          newAttrsEl.appendChild attrs.key.cloneNode(true)
        if attrs.time
          newAttrsEl.appendChild attrs.time.cloneNode(true)
        if attrs.staves
          newAttrsEl.appendChild attrs.staves.cloneNode(true)
        for clef in attrs.clefs or []
          newAttrsEl.appendChild clef.cloneNode(true)
        if attrs.transpose
          newAttrsEl.appendChild attrs.transpose.cloneNode(true)

        if existingAttrs
          for child in Array.from(newAttrsEl.children)
            # Pour les clefs, vérifier par numéro de portée
            if child.tagName is "clef"
              staffNum = child.getAttribute("number")
              existingClef = existingAttrs.querySelector("clef[number=\"#{staffNum}\"]")
              unless existingClef
                existingAttrs.insertBefore child.cloneNode(true), existingAttrs.firstChild
            else if child.tagName is "staves"
              unless existingAttrs.querySelector("staves")
                existingAttrs.insertBefore child.cloneNode(true), existingAttrs.firstChild
            else
              unless existingAttrs.querySelector(child.tagName)
                existingAttrs.insertBefore child.cloneNode(true), existingAttrs.firstChild
        else if newAttrsEl.children.length > 0
          firstMeasure.insertBefore newAttrsEl, firstMeasure.firstChild

  applyPartsSettings clone
  serializer.serializeToString clone

# Preprocess MusicXML: insert system breaks after double barlines (in place)
preprocessMusicXML = (doc) ->
  measures = Array.from doc.querySelectorAll("measure")
  for measure, i in measures
    barlines = measure.querySelectorAll('barline[location="right"]')
    hasBreak = false
    for barline in Array.from(barlines)
      barStyle = barline.querySelector("bar-style")
      if barStyle
        style = barStyle.textContent.trim()
        if style is "light-heavy" or style is "light-light"
          hasBreak = true
          break
    if hasBreak and i < measures.length - 1
      nextMeasure = measures[i + 1]
      existingPrint = nextMeasure.querySelector("print")
      if existingPrint
        existingPrint.setAttribute "new-system", "yes"
      else
        printEl = doc.createElementNS(
          nextMeasure.namespaceURI or "http://www.w3.org/1999/xhtml",
          "print"
        )
        printEl.setAttribute "new-system", "yes"
        nextMeasure.insertBefore printEl, nextMeasure.firstChild
  doc

