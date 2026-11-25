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
  {gregorien: true, texte: decoderTexteGabc source?.data}

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

tailleTexteGabc = (scale) ->
  pct = if isFinite(scale) and scale > 0 then scale else 40
  Math.max 12, Math.round(pct * 0.55)

largeurPageGabc = ->
  Math.max 200, Math.floor(window.innerWidth or 360)

creerContexteGabc = (scale, exsurge) ->
  ctxt = new exsurge.ChantContext()
  # Même police que le texte des partitions Verovio (embarquée dans le CSS).
  ctxt.setFont "'Cantus Serif', 'Liberation Serif', 'Times New Roman', serif",
    tailleTexteGabc scale
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
miseEnPageGabc = (texte, {scale, largeur} = {}) ->
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
        ctxt = creerContexteGabc scale, exsurge
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
        {svgs: construireSvgs(score, ctxt, largeurMiseEnPage, nom), mode: 'vertical'}
      catch err
        throw err if err?.message is t 'errors.gabcInvalid'
        throw new Error "#{t 'errors.gabcInvalid'} (#{err?.message or err})"

# --- Requêtes de l'application ---------------------------------------------
mouvementGregorienAffiche = ->
  return null unless typeof getMovementForPage is 'function' and typeof displayedPage is 'function'
  getMovementForPage(displayedPage())?.movement or null

estGregorienAffiche = -> !!mouvementGregorienAffiche()?.gregorien
