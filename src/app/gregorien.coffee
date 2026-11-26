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

# Chant grégorien encodé dans un autre format : MEI neumatique (module Neumes
# MEI 5.1) ou MusicXML produit par scoretk depuis un gabc. Ces fichiers sont
# convertis en gabc à la demande (voir preparerGabcAutre dans sources.coffee) ;
# le texte obtenu est mémorisé sur la source, qui suit ensuite le chemin gabc.
GABC_AUTRE_EXT_RE = /\.(mei|xml|musicxml|mxl)$/i
# Marqueurs lus sur le texte, sans parser : un élément <neume> ou <syllable>
# (MEI neumatique), ou une <other-direction> dont le texte commence par
# « gabc: » (MusicXML produit par scoretk depuis un gabc).
MEI_NEUMES_RE = /<(?:neume|syllable)[\s>]/
MUSICXML_GABC_RE = /<other-direction\b[^>]*>\s*gabc:/

# Une source gabc se reconnaît à son extension (le partage et le lancement
# gardent le nom du fichier ; le service worker ajoute une extension de repli
# pour les types MIME qu'il connaît), ou au texte gabc obtenu par conversion
# d'un MEI neumatique / MusicXML issu de gabc.
estGabc = (source) ->
  source?.gabcTexte? or GABC_EXT_RE.test String(source?.name or '')

# Texte gabc de la source : le texte converti s'il existe, sinon le contenu
# brut (source .gabc, ou texte déjà décodé).
decoderTexteGabc = (source) ->
  return String source.gabcTexte if source?.gabcTexte?
  data = source?.data
  return String data if typeof data is 'string'
  throw new Error "contenu gabc absent" unless data?
  # UTF-8 strict : un fichier illisible est signalé plutôt que rendu de travers.
  new TextDecoder('utf-8', {fatal: true}).decode new Uint8Array data

preparerSourceGabc = (source) ->
  texte = decoderTexteGabc source
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

# --- Polices de neumes NABC ------------------------------------------------
# exsurge ne dessine les neumes NABC (Saint-Gall / Laon, après les `|` des
# notes) qu'avec une police fournie à part, sous licence OFL. Chaque police
# est un script : copié dans dist/ pour la PWA, inliné dans spa.html. Il n'est
# évalué qu'à la première ouverture d'un gabc dont l'en-tête annonce
# `nabc-lines` : un gabc sans NABC ne charge aucune de ces polices.
POLICES_NABC =
  gregall:
    fichier: 'nabc-gregall.min.js'
    global: 'exsurgeNabcGregall'
    propriete: 'gregall'
  gresgmodern:
    fichier: 'nabc-gresgmodern.min.js'
    global: 'exsurgeNabcGresgmodern'
    propriete: 'gresgmodern'
  grelaon:
    fichier: 'nabc-grelaon.min.js'
    global: 'exsurgeNabcGrelaon'
    propriete: 'grelaon'

promessesPolicesNabc = {}

# Applique le réglage « Police des neumes » : une clé inconnue revient au
# défaut (Saint-Gall), comme les autres réglages bornés.
applyNabcFont = (nom) ->
  nabcFont = if POLICES_NABC[nom]? then nom else 'gregall'
  select = $("nabc-font-select")
  select.value = nabcFont if select

# Nombre de lignes de NABC de l'en-tête gabc (0 : aucun neume NABC).
lignesNabc = (header) ->
  nombre = parseInt (header?.nabcLines ? header?['nabc-lines']), 10
  if nombre > 0 then nombre else 0

# Charge (une fois) la police NABC demandée et résout son objet de glyphes,
# prêt pour ctxt.nabcFonts.
chargerPoliceNabc = (nom) ->
  config = POLICES_NABC[nom] ? POLICES_NABC.gregall
  police = window[config.global]?[config.propriete]
  return Promise.resolve police if police?
  return promessesPolicesNabc[config.global] if promessesPolicesNabc[config.global]
  promessesPolicesNabc[config.global] = new Promise (resolve, reject) ->
    echouer = (err) ->
      promessesPolicesNabc[config.global] = null
      reject err
    reussi = ->
      police = window[config.global]?[config.propriete]
      return resolve police if police?
      echouer new Error t 'errors.nabcUnavailable'
    inline = document.getElementById "nabc-#{nom}-src"
    if inline?
      try
        new Function(inline.textContent)()
      catch err
        return echouer new Error(t('errors.nabcUnavailable') + " (#{err?.message or err})")
      return reussi()
    script = document.createElement 'script'
    script.src = config.fichier
    script.onload = reussi
    script.onerror = -> echouer new Error t 'errors.nabcUnavailable'
    document.head.appendChild script
  promessesPolicesNabc[config.global]

# Police à donner au contexte pour ce gabc, ou null s'il n'a pas de NABC ou si
# la police manque : la portée reste alors lisible, sans les neumes.
chargerPoliceNabcPour = (lignes) ->
  return Promise.resolve null unless lignes > 0
  chargerPoliceNabc(nabcFont).catch (err) ->
    console.warn "Police des neumes indisponible : #{err?.message or err}"
    null

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
  # Accords lus dans les [alt:] : réécriture du gabc avant exsurge (le repère
  # source-index reste cohérent avec la vue classique, qui réécrit le même
  # texte avant scoretk).
  texte = window.__musicaAccords.reecrireTexteGabc texte,
    actif: readAltChords
    transpose: visualTranspose
  chargerExsurge().then (exsurge) ->
    header = new exsurge.GabcHeader texte
    # Neumes NABC : la police n'est chargée que si l'en-tête `nabc-lines` en
    # annonce (elle est absente de la portée d'un gabc ordinaire).
    chargerPoliceNabcPour(lignesNabc header).then (policeNabc) ->
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
          ctxt.nabcFonts = [policeNabc] if policeNabc?
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

# --- Suivi et surlignage de la note en notation carrée ---------------------
# La lecture carrée n'a pas de marqueurs Verovio : le worker fournit le début
# de chaque note et son offset source (`playback.noteMarks`). L'offset se
# traduit en `source-index` par la longueur d'en-tête mesurée par exsurge, le
# même repère que la bascule de position.
#
# Les notes rendues sont indexées par offset une seule fois par page (WeakMap
# sur l'élément de page) : le suivi et le surlignage n'ont ensuite qu'à lire
# cette table, sans reparcourir le DOM à chaque frame.

indexNotesCarrees = new WeakMap()

indexPageCarree = (pageEl) ->
  return indexNotesCarrees.get pageEl if indexNotesCarrees.has pageEl
  # Page encore en cours de rendu : ne pas figer un index vide.
  return null unless pageEl?.querySelector? "svg"
  page = parseInt pageEl.dataset.page
  mv = getMovementForPage(page)?.movement
  entete = mv?.enteteLongueur ? 0
  byPos = new Map()
  positions = []
  for el in pageEl.querySelectorAll ".note[source-index]"
    pos = positionNoteElement el, entete, true
    continue unless pos?
    continue if byPos.has pos
    byPos.set pos, el
    positions.push pos
  positions.sort (a, b) -> a - b
  index = {byPos, positions}
  indexNotesCarrees.set pageEl, index
  index

# Note carrée de position source `pos` parmi les pages rendues. Les positions
# des deux vues coïncident (offset MusicXML = en-tête + source-index), mais on
# replie sur la note précédente pour rester lisible si une note manque.
trouverNoteCarree = (pos) ->
  return null unless pos?
  slot = $ "page-current"
  return null unless slot
  avant = null
  avantPos = -Infinity
  premiere = null
  premierePos = Infinity
  for pageEl in slot.querySelectorAll ".scroll-page"
    index = indexPageCarree pageEl
    continue unless index?
    exact = index.byPos.get pos
    return exact if exact?
    for candidate in index.positions
      if candidate <= pos and candidate > avantPos
        avantPos = candidate
        avant = index.byPos.get candidate
      if candidate < premierePos
        premierePos = candidate
        premiere = index.byPos.get candidate
  avant ? premiere

# Index complet des notes d'un mouvement carré (offset -> page locale),
# construit une fois à la demande depuis les SVG gardés en mémoire : il permet
# d'atteindre une page que la fenêtre rendue ne contient pas encore (saut de
# lecture lointain).
indexMouvementCarre = (mv) ->
  return mv.indexNotesCarree if mv.indexNotesCarree?
  byPos = new Map()
  positions = []
  entete = mv?.enteteLongueur ? 0
  for svg, i in (mv?.gregorienSvgs ? [])
    continue unless typeof svg is "string" and svg
    try
      doc = new DOMParser().parseFromString svg, "image/svg+xml"
      for el in doc.querySelectorAll ".note[source-index]"
        pos = positionNoteElement el, entete, true
        continue unless pos?
        continue if byPos.has pos
        byPos.set pos, i + 1
        positions.push pos
    catch
      continue
  positions.sort (a, b) -> a - b
  mv.indexNotesCarree = {byPos, positions}
  mv.indexNotesCarree

# Page locale de la note à `pos` : exacte, sinon la dernière position ≤ pos,
# sinon la première note du mouvement.
pageNoteCarree = (mv, pos) ->
  index = indexMouvementCarre mv
  return null unless index?.positions.length
  return index.byPos.get pos if index.byPos.has pos
  lo = 0
  hi = index.positions.length
  while lo < hi
    mid = (lo + hi) >> 1
    if index.positions[mid] <= pos then lo = mid + 1 else hi = mid
  found = if lo > 0 then index.positions[lo - 1] else index.positions[0]
  index.byPos.get found

# Marge (px) autour de la zone de lecture : une note déjà visible n'entraîne
# pas de défilement à chaque frame.
MARGE_SUIVI_CARRE = 16

# Suivi carré : amène la page de la note courante si elle n'est pas rendue,
# puis défile seulement quand la note sort de la zone visible. Renvoie la page
# globale visée, ou null si la vue n'a pas bougé.
applyFollowScrollCarre = ->
  marks = playback.noteMarks
  return null unless Array.isArray(marks) and marks.length
  api = window.__musicaPlayback
  mark = if api?.markAt? then api.markAt marks, followPosition() else null
  return null unless mark?.offset?
  slot = $ "page-current"
  el = trouverNoteCarree mark.offset
  unless el?
    mv = mouvementAffiche()
    page = if mv? then pageNoteCarree mv, mark.offset else null
    return null unless page?
    target = getGlobalPage mv.id, page
    return null unless target >= 1
    # Éviter de relancer le saut à chaque frame tant que la page n'est pas
    # rendue ; dès qu'elle l'est, `trouverNoteCarree` la trouve.
    key = "page:#{target}"
    return null if playback.followKey is key
    goToPage target
    playback.followKey = key
    return target
  pageEl = el.closest? ".scroll-page"
  return null unless pageEl?
  target = parseInt pageEl.dataset.page
  rect = el.getBoundingClientRect()
  slotRect = slot.getBoundingClientRect()
  if rect.top < slotRect.top + MARGE_SUIVI_CARRE or
      rect.bottom > slotRect.bottom - MARGE_SUIVI_CARRE
    top = rect.top - slotRect.top + slot.scrollTop
    slot.scrollTo top: Math.max(0, top - slot.clientHeight * 0.35), behavior: "instant"
    showIndicator?()
    savePositionDebounced?()
    playback.followKey = "note:#{mark.offset}"
    return target
  null

# Surlignage de la note jouée : rectangle de fond sous le glyphe, même style
# que `.measure-highlight`, et classe `note-playing` sur la note pour que les
# tests et l'inspection retrouvent la note exacte.
noteHighlightRect = null
noteHighlightElement = null
noteHighlightUpdates = 0
noteHighlightT = null
noteHighlightNextT = null

clearNoteHighlight = ->
  playback.highlightNoteKey = null
  playback.highlightNoteOffset = null
  noteHighlightT = null
  noteHighlightNextT = null
  noteHighlightElement?.classList.remove "note-playing"
  noteHighlightElement = null
  noteHighlightRect?.remove() if noteHighlightRect?.parentNode?
  noteHighlightRect = null

placerSurlignageNote = (el) ->
  try
    box = el.getBBox()
  catch
    return false
  return false unless box.width > 0 and box.height > 0
  parent = el.parentNode
  return false unless parent?
  unless noteHighlightRect?.parentNode is parent
    noteHighlightRect?.remove() if noteHighlightRect?.parentNode?
    rect = document.createElementNS SVG_NS, "rect"
    rect.setAttribute "class", "note-highlight"
    rect.setAttribute "aria-hidden", "true"
    rect.setAttribute "pointer-events", "none"
    parent.insertBefore rect, el
    noteHighlightRect = rect
  rect = noteHighlightRect
  padX = Math.max 1, box.width * 0.12
  padY = Math.max 1, box.height * 0.12
  rect.setAttribute "x", String box.x - padX
  rect.setAttribute "y", String box.y - padY
  rect.setAttribute "width", String box.width + 2 * padX
  rect.setAttribute "height", String box.height + 2 * padY
  true

mettreAJourSurlignageNote = ->
  unless highlightMeasureEnabled and estGregorienAffiche()
    clearNoteHighlight()
    return
  marks = playback.noteMarks
  unless Array.isArray(marks) and marks.length
    clearNoteHighlight()
    return
  api = window.__musicaPlayback
  mark = if api?.markAt? then api.markAt marks, followPosition() else null
  unless mark?.offset?
    clearNoteHighlight()
    return
  key = String mark.offset
  if key is playback.highlightNoteKey and noteHighlightElement?.isConnected and
      noteHighlightRect?.isConnected
    return
  el = trouverNoteCarree mark.offset
  unless el?
    clearNoteHighlight()
    return
  if noteHighlightElement isnt el
    noteHighlightElement?.classList.remove "note-playing"
    noteHighlightElement = el
    el.classList.add "note-playing"
  unless placerSurlignageNote el
    clearNoteHighlight()
    return
  playback.highlightNoteKey = key
  playback.highlightNoteOffset = mark.offset
  position = marks.indexOf mark
  noteHighlightT = mark.t
  noteHighlightNextT = if position >= 0 then marks[position + 1]?.t ? null else null
  noteHighlightUpdates += 1

# Sonde de test : note carrée surlignée, sa position source et son rectangle.
window.__musicaNoteHighlightState = ->
  el = noteHighlightElement
  connected = el?.isConnected is true
  pageEl = if connected then el.closest? ".scroll-page" else null
  page = if pageEl? then parseInt(pageEl.dataset.page) else null
  mv = if page? then getMovementForPage(page)?.movement else null
  index = if connected then Number el.getAttribute "source-index" else null
  rect = noteHighlightRect
  rectOk = rect?.isConnected is true
  position = if typeof followPosition is "function" then followPosition() else null
  {
    enabled: highlightMeasureEnabled
    key: playback.highlightNoteKey
    updates: noteHighlightUpdates
    offset: playback.highlightNoteOffset ? null
    sourceIndex: if isFinite(index) then index else null
    headerLen: mv?.enteteLongueur ? 0
    page: page
    displayed: if typeof displayedPage is "function" then displayedPage() else null
    position: if isFinite(position) then position else null
    t: noteHighlightT
    nextT: noteHighlightNextT
    rect: if rectOk then {
      x: Number rect.getAttribute "x"
      y: Number rect.getAttribute "y"
      width: Number rect.getAttribute "width"
      height: Number rect.getAttribute "height"
    } else null
  }

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
