# gregorien.coffee — import et mise en page des fichiers gabc en notation
# carrée, sans scoretk ni Verovio.
#
# exsurge lit le gabc et produit un SVG par ligne de chant. Chaque ligne
# devient une « page » du lecteur, sans passer par le worker : la mise en page
# se fait dans la page (exsurge mesure les paroles avec le DOM), les SVG sont
# gardés en mémoire sur le mouvement et requestPage les rend directement.
#
# exsurge n'est évalué qu'au premier gabc : script externe `exsurge.min.js`
# dans la PWA (précaché pour l'hors-ligne), source inlinée dans `spa.html`.

GABC_EXT_RE = /\.gabc$/i

# Une source gabc se reconnaît à son extension (le partage et le lancement
# gardent le nom du fichier ; le service worker ajoute une extension de repli
# pour les types MIME qu'il connaît).
estGabc = (source) -> GABC_EXT_RE.test String(source?.name or '')

decoderTexteGabc = (data) ->
  return String data if typeof data is 'string'
  throw new Error "contenu gabc absent" unless data?
  # UTF-8 strict : un fichier illisible est signalé plutôt que rendu de travers.
  new TextDecoder('utf-8', {fatal: true}).decode new Uint8Array data

preparerSourceGabc = (source) ->
  texte = decoderTexteGabc source?.data
  {gregorien: true, gabc: true, notation: "square", texte}

# --- Chargement paresseux d'exsurge ---------------------------------------
promesseExsurge = null

chargerExsurge = ->
  return Promise.resolve window.exsurge if window.exsurge?.ChantContext?
  return promesseExsurge if promesseExsurge
  promesseExsurge = new Promise (resolve, reject) ->
    echouer = (err) ->
      promesseExsurge = null
      reject err
    reussi = ->
      if window.exsurge?.ChantContext?
        resolve window.exsurge
      else
        echouer new Error t 'errors.gabcUnavailable'
    inline = document.getElementById 'exsurge-src'
    if inline?
      try
        new Function(inline.textContent)()
      catch err
        return echouer new Error t('errors.gabcUnavailable') + " (#{err?.message or err})"
      return reussi()
    script = document.createElement 'script'
    script.src = 'exsurge.min.js'
    script.onload = reussi
    script.onerror = -> echouer new Error t 'errors.gabcUnavailable'
    document.head.appendChild script
  promesseExsurge

# --- Mise en page -----------------------------------------------------------
# currentScale (30 à 80) est le zoom du lecteur : il règle la hauteur de la
# portée, donc la taille des neumes et des paroles. La largeur reste celle de
# l'écran : la ligne est refaite à chaque changement de zoom.
#
# Hauteur de portée : à 40 %, une portée Verovio mesure 50,05 px dans
# l'application (g.staff à 360 px) ; 40 × 1,25 = 50 px pour la portée grégorienne
# (écart entre la première et la dernière ligne de la portée).
STAFF_HEIGHT_MIN = 24
STAFF_HEIGHT_PAR_ZOOM = 1.25
# Marge ajoutée autour de l'encombrement réel : elle laisse respirer le titre,
# la clef, le custos et les paroles descendantes, sans les rogner.
MARGE_GABC = 8

hauteurPorteeGabc = (scale) ->
  pct = if isFinite(scale) and scale > 0 then scale else 40
  Math.max STAFF_HEIGHT_MIN, Math.round(pct * STAFF_HEIGHT_PAR_ZOOM)

tailleTexteGabc = (scale, textSize) ->
  pct = if isFinite(scale) and scale > 0 then scale else 40
  # Taille de base à 100 % : la taille du texte suit le zoom.
  base = Math.max 12, Math.round(pct * 0.55)
  # Réglage « Taille du texte » appliqué APRÈS le calcul de base, sans
  # toucher à la hauteur de portée.
  facteur = if isFinite(textSize) and textSize > 0 then textSize else 100
  Math.round base * facteur / 100

largeurPageGabc = ->
  Math.max 200, Math.floor(window.innerWidth or 360)

creerContexteGabc = (scale, textSize, exsurge) ->
  ctxt = new exsurge.ChantContext()
  # Même police que le texte des partitions Verovio (embarquée dans le CSS).
  ctxt.setFont "'Cantus Serif', 'Liberation Serif', 'Times New Roman', serif",
    tailleTexteGabc scale, textSize
  # Noir : les thèmes sépia et sombre appliquent déjà leur filtre à la zone de
  # lecture (styles.css, body.theme-*).
  ctxt.setRubricColor '#000'
  ctxt.setStaffHeight hauteurPorteeGabc scale
  ctxt.staffLineCount = 4
  ctxt

# Filtre sur le DOM avant sérialisation, au lieu d'expressions régulières sur
# le SVG déjà écrit (contournables et capables d'abîmer un texte comme « on x=1 »).
# Les paroles et le titre sont des nœuds texte : ils ne sont jamais interprétés
# comme des balises par ce filtre.
SVG_NS = 'http://www.w3.org/2000/svg'
# Éléments réellement produits par exsurge (relevé dans
# node_modules/exsurge-ts/src/Exsurge.Drawing.ts : createNode/createFragment/
# output.element, et Exsurge.Chant.ts createSvgNodeForEachLine) : g, defs,
# style, line, path, rect, polygon, text, tspan, use, dans le svg racine.
ELEMENTS_SVG_GABC = ['svg', 'g', 'defs', 'style', 'line', 'path', 'rect', 'polygon', 'text', 'tspan', 'use']

nettoyerAttributsSvg = (element) ->
  for attribut in Array.from element.attributes
    nom = attribut.name.toLowerCase()
    valeur = attribut.value
    if /^on/.test nom
      element.removeAttribute attribut.name
    else if (nom is 'href' or nom is 'xlink:href') and not /^\s*#/.test valeur
      element.removeAttribute attribut.name
    else if nom is 'style' and /url\s*\(|@import|expression\s*\(|javascript:/i.test valeur
      element.removeAttribute attribut.name

neutraliserSvg = (racine) ->
  nettoyerAttributsSvg racine
  for element in Array.from racine.children
    if element.namespaceURI isnt SVG_NS or element.localName not in ELEMENTS_SVG_GABC
      racine.removeChild element
      continue
    nettoyerAttributsSvg element
    if element.localName is 'style'
      # Le CSS vient de ctxt.createStyleCss() (exsurge), jamais du gabc ; on
      # retire tout de même les chargements externes s'il en apparaissait.
      element.textContent = element.textContent
        .replace /@import[^;]*;?/gi, ''
        .replace /url\s*\([^)]*\)/gi, 'none'
    neutraliserSvg element
  return

# Un SVG par ligne, comme createSvgNodeForEachLine(), avec en plus le titre de
# l'en-tête au-dessus de la première ligne. Le viewBox est calculé sur le
# getBBox() réel du dessin (titre, clef, custos, notes hautes, paroles
# descendantes inclus), puis élargi de MARGE_GABC : min-x/min-y peuvent être
# négatifs, et rien n'est rogné par le viewport.
construireSvgs = (score, ctxt, largeur, titre) ->
  defs = ctxt.defsNode.cloneNode true
  defs.appendChild ctxt.createStyleNode()
  titreNode = if titre and score.titles?.title? then score.titles.createSvgNode ctxt else null
  serialiseur = new XMLSerializer()
  # getBBox() exige un document rendu : hôte hors écran, jamais visible.
  hote = document.createElement 'div'
  hote.setAttribute 'style', 'position:absolute;left:-100000px;top:0;width:1px;height:1px;overflow:hidden'
  document.body.appendChild hote
  noeuds = []
  try
    for ligne, index in score.lines
      groupe = document.createElementNS SVG_NS, 'g'
      groupe.appendChild defs.cloneNode true
      groupe.appendChild titreNode if index is 0 and titreNode
      # La première ligne descend sous le titre ; les suivantes repartent de
      # leur propre origine.
      top = if index is 0 then 0 else ligne.bounds.y
      groupe.appendChild ligne.createSvgNode ctxt, top
      svg = document.createElementNS SVG_NS, 'svg'
      svg.setAttribute 'xmlns', SVG_NS
      svg.setAttribute 'version', '1.1'
      svg.setAttribute 'class', ctxt.getSvgClass()
      svg.setAttribute 'width', largeur
      svg.setAttribute 'height', 1
      svg.setAttribute 'viewBox', "0 0 #{largeur} 1"
      svg.appendChild groupe
      neutraliserSvg svg
      hote.appendChild svg
      box = svg.getBBox()
      hote.removeChild svg
      x = box.x - MARGE_GABC
      y = box.y - MARGE_GABC
      largeurSvg = Math.max 1, box.width + 2 * MARGE_GABC
      hauteurSvg = Math.max 1, box.height + 2 * MARGE_GABC
      svg.setAttribute 'width', largeurSvg
      svg.setAttribute 'height', hauteurSvg
      svg.setAttribute 'viewBox', "#{x} #{y} #{largeurSvg} #{hauteurSvg}"
      noeuds.push serialiseur.serializeToString svg
  finally
    document.body.removeChild hote if hote.parentNode?
  noeuds

# Met un gabc en page à la largeur voulue : une ligne de chant = une page.
# Résout {svgs, mode} ; rejette un gabc vide, sans note ou illisible.
miseEnPageGabc = (texte, {scale, textSize, largeur} = {}) ->
  chargerExsurge().then (exsurge) ->
    # Mesurer après le chargement de la police évite un viewBox calculé sur une
    # police de repli plus large ou plus haute.
    attendrePolices = if document.fonts?.ready? then document.fonts.ready else Promise.resolve()
    attendrePolices.then ->
      largeur ?= largeurPageGabc()
      # Le texte est mis en page entre les deux marges ; le viewBox les reprend
      # ensuite autour de l'encombrement réel.
      largeurMiseEnPage = Math.max 200, Math.floor(largeur - 2 * MARGE_GABC)
      try
        ctxt = creerContexteGabc scale, textSize, exsurge
        header = new exsurge.GabcHeader texte
        mappings = exsurge.Gabc.createMappingsFromSource ctxt, texte
        unless mappings?.length
          throw new Error t 'errors.gabcInvalid'
        score = new exsurge.ChantScore ctxt, mappings, true
        # `notes` contient aussi clés et barres : il faut au moins une vraie note.
        unless score.notes?.some((element) -> element instanceof exsurge.Note)
          throw new Error t 'errors.gabcInvalid'
        nom = String(header.name or '').trim()
        score.titles?.setTitle ctxt, nom if nom
        # initial-style (initiale) et mode/annotation, comme Gregorio.
        exsurge.Gabc.applyHeader score, ctxt, header, {legacy: true}
        score.performLayout ctxt
        score.layoutChantLines ctxt, largeurMiseEnPage
        unless score.lines?.length
          throw new Error t 'errors.gabcInvalid'
        {svgs: construireSvgs(score, ctxt, largeurMiseEnPage, nom), mode: 'vertical',
          enteteLongueur: exsurge.GabcHeader.getLength texte}
      catch err
        throw err if err?.message is t 'errors.gabcInvalid'
        throw new Error "#{t 'errors.gabcInvalid'} (#{err?.message or err})"

# --- Requêtes de l'application ---------------------------------------------
mouvementAffiche = ->
  return null unless typeof getMovementForPage is 'function' and typeof displayedPage is 'function'
  getMovementForPage(displayedPage())?.movement or null

estGregorienAffiche = -> !!mouvementAffiche()?.gregorien

# --- Bascule carré / classique ---------------------------------------------
# La vue classique est le MusicXML converti par scoretk : même découpage, même
# worker, même transport et même export qu'un MusicXML ordinaire. Le choix est
# propre au fichier (notationView, réglages-voix.coffee) et commun à toutes ses
# sources gabc. Une bascule recharge par startLoad, en gardant les sources et
# le jeton loadToken : les chargements remplacés sont ignorés.

# Restauration de position en cours : tant qu'elle n'a pas abouti, le bouton
# et les tests savent qu'une bascule n'est pas terminée.
positionBascule = null
derniereCibleBascule = null
dernierRepereGabc = null
dernierMouvementGabc = null

# Position source (unités UTF-16 depuis le début du fichier) d'un élément de
# note : source-index relatif au corps en carré, -o absolu dans l'id MusicXML.
positionNoteElement = (el, enteteLongueur, carre) ->
  if carre
    index = el.getAttribute 'source-index'
    return null unless index?
    classes = " #{(el.getAttribute('class') or '')} "
    return null unless classes.includes " note "
    value = enteteLongueur + Number index
    return if isFinite(value) then value else null
  match = (el.getAttribute('id') or '').match /-o(\d+)-e\d+$/
  if match then Number(match[1]) else null

# Première note visible par position source dans la vue courante. Sert de
# repère avant la bascule : la cible sera la dernière note de position ≤ ce
# repère dans la nouvelle vue.
positionPremiereNoteVisible = ->
  mv = mouvementAffiche()
  return null unless mv?.gabc
  carre = notationView is "square"
  selector = if carre then ".note[source-index]" else "[id]"
  slot = $ "page-current"
  rect = slot.getBoundingClientRect()
  best = null
  for el in slot.querySelectorAll ".scroll-page svg #{selector}"
    pos = positionNoteElement el, (mv.enteteLongueur ? 0), carre
    continue unless pos?
    box = el.getBoundingClientRect()
    continue unless box.bottom > rect.top and box.top < rect.bottom and
      box.right > rect.left and box.left < rect.right
    best = pos if best is null or pos < best
  best

rafraichirBasculeNotation = ->
  btn = $ "notation-toggle"
  return unless btn
  mv = mouvementAffiche()
  dernierMouvementGabc = mv if mv?.gabc
  visible = !!mv?.gabc and fileLoaded
  btn.classList.toggle "hidden", not visible
  btn.setAttribute "aria-pressed", if notationView is "square" then "true" else "false"
  btn.disabled = false

# Bascule demandée par le bouton. Le choix est enregistré avant le
# rechargement ; la position est mémorisée pour la restaurer à l'arrivée.
basculerVueNotation = ->
  mv = mouvementAffiche()
  mv = dernierMouvementGabc unless mv?.gabc
  return unless mv?.gabc
  cible = if notationView is "square" then "classic" else "square"
  if cible is "classic" and not window.__musicaScoretkAvailable
    showError t "errors.notationNeedsScoretk"
    rafraichirBasculeNotation()
    return
  pos = positionPremiereNoteVisible()
  dernierRepereGabc = {sourceIndex: mv.sourceIndex, pos} if pos?
  repere = if dernierRepereGabc?.sourceIndex is mv.sourceIndex then dernierRepereGabc else null
  notationView = cible
  saveNotationView()
  rafraichirBasculeNotation()
  # Les XML/découpages en cache valent pour l'ancienne vue : les reconvertir.
  sourceCache.clear()
  startLoad 1, true
  # startLoad relit la préférence enregistrée ; si localStorage est
  # indisponible, le choix courant doit quand même s'appliquer à ce
  # chargement (la conversion commence dans une microtâche).
  notationView = cible
  positionBascule = if repere? then {
    sourceIndex: repere.sourceIndex
    pos: repere.pos
    token: loadToken
  } else null

# Positions source des notes d'une page rendue, triées et dédoublonnées.
positionsPage = (movement, page, carre) ->
  requestPage(movement.id, page).then (svg) ->
    return [] unless svg
    try
      doc = new DOMParser().parseFromString svg, "image/svg+xml"
      selector = if carre then ".note[source-index]" else "[id]"
      positions = []
      for el in doc.querySelectorAll selector
        pos = positionNoteElement el, (movement.enteteLongueur ? 0), carre
        positions.push pos if pos?
      positions.sort (a, b) -> a - b
      Array.from new Set positions
    catch
      []

# Dernière note de position ≤ repere, dans les mouvements de la source. Les
# positions sont croissantes : parcours linéaire des pages, arrêt à la
# première page dont la première note dépasse le repère.
trouverPageCible = (sourceIndex, repere, carre) ->
  cibles = movements.filter (m) ->
    m.sourceIndex is sourceIndex and m.loaded and (m.pageCount ? 0) > 0
  index = 0
  page = 1
  candidat = null
  etape = ->
    return Promise.resolve candidat if index >= cibles.length
    m = cibles[index]
    unless page <= m.pageCount
      index += 1
      page = 1
      return etape()
    positionsPage(m, page, carre).then (positions) ->
      if positions.length and positions[0] > repere
        return candidat ? {movementId: m.id, page, pos: positions[0]}
      pos = null
      for candidate in positions when candidate <= repere
        pos = candidate
      candidat = {movementId: m.id, page, pos} if pos?
      # La page suivante commence au-delà du repère : la cible est ici.
      return Promise.resolve candidat if positions.length and
        positions[positions.length - 1] > repere
      page += 1
      etape()
  etape()

trouverNoteCible = (cible) ->
  carre = notationView is "square"
  selector = if carre then ".note[source-index]" else "[id]"
  mv = movements.find (m) -> m.id is cible.movementId
  entete = mv?.enteteLongueur ? 0
  for el in $("page-current").querySelectorAll ".scroll-page svg #{selector}"
    return el if positionNoteElement(el, entete, carre) is cible.pos
  null

# Amène la note cible dans la zone visible (la page est déjà rendue par le
# balayage ou arrive au frame suivant).
defilerVersNote = (cible) ->
  essai = (n) ->
    el = trouverNoteCible cible
    if el?
      slot = $ "page-current"
      top = el.getBoundingClientRect().top - slot.getBoundingClientRect().top + slot.scrollTop
      slot.scrollTop = Math.max 0, top - 8
      showIndicator()
      savePositionDebounced()
      return Promise.resolve()
    return Promise.resolve() if n > 120
    new Promise((resolve) -> requestAnimationFrame resolve).then -> essai n + 1
  essai 0

restaurerPositionApresBascule = (cible) ->
  carre = notationView is "square"
  trouverPageCible(cible.sourceIndex, cible.pos, carre).then (target) ->
    return unless cible.token is loadToken and target?
    derniereCibleBascule = target
    goToPage getGlobalPage target.movementId, target.page
    defilerVersNote target

# Appelée par finishLoad : restaure la position de la bascule une fois toutes
# les sources converties et les mouvements connus.
restaurerPositionBascule = ->
  cible = positionBascule
  return unless cible? and cible.token is loadToken
  restaurerPositionApresBascule cible
    .catch (err) ->
      console.warn "Restauration de position impossible : #{err?.message or err}"
    .then ->
      positionBascule = null if positionBascule is cible
      rafraichirBasculeNotation()

# Nouvelle entrée : aucune position de bascule à conserver.
reinitialiserBascule = ->
  positionBascule = null
  derniereCibleBascule = null
  dernierRepereGabc = null
  dernierMouvementGabc = null

setupNotationToggle = ->
  $("notation-toggle")?.addEventListener "click", basculerVueNotation

# Sonde de debug pour les tests : vue courante, restauration en cours, cible.
window.__musicaNotationProbe = ->
  {view: notationView, restore: positionBascule, target: derniereCibleBascule}
