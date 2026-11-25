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
STAFF_HEIGHT_MIN = 20

hauteurPorteeGabc = (scale) ->
  pct = if isFinite(scale) and scale > 0 then scale else 40
  Math.max STAFF_HEIGHT_MIN, Math.round(pct * 0.95)

largeurPageGabc = ->
  Math.max 200, Math.floor(window.innerWidth or 360)

creerContexteGabc = (scale, exsurge) ->
  ctxt = new exsurge.ChantContext()
  # Même police que le texte des partitions Verovio (embarquée dans le CSS).
  ctxt.setFont "'Cantus Serif', 'Liberation Serif', 'Times New Roman', serif",
    Math.max 11, Math.round((if isFinite(scale) and scale > 0 then scale else 40) * 0.42)
  # Noir : les thèmes sépia et sombre appliquent déjà leur filtre à la zone de
  # lecture (styles.css, body.theme-*).
  ctxt.setRubricColor '#000'
  ctxt.setStaffHeight hauteurPorteeGabc scale
  ctxt.staffLineCount = 4
  ctxt

# Défense en profondeur : le contenu du gabc vient d'un fichier partagé. Les
# nœuds sont construits par le DOM (les paroles y sont des nœuds texte, donc
# échappées par XMLSerializer) ; on retire malgré tout scripts, objets étrangers
# et gestionnaires d'événements avant l'injection par innerHTML.
neutraliserSvg = (svg) ->
  String(svg)
    .replace /<script\b[\s\S]*?<\/script\s*>/gi, ''
    .replace /<script\b[^>]*\/?>/gi, ''
    .replace /<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, ''
    .replace /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ''
    .replace /\s(?:xlink:)?href\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, ''

# Un SVG par ligne, comme createSvgNodeForEachLine(), avec en plus le titre de
# l'en-tête au-dessus de la première ligne : les titres exsurge ne font pas
# partie des SVG par ligne, on leur réserve donc leur hauteur.
construireSvgs = (score, ctxt, largeur, titre) ->
  defs = ctxt.defsNode.cloneNode true
  defs.appendChild ctxt.createStyleNode()
  titreNode = null
  titreHauteur = 0
  if titre and score.titles?.title?
    # layoutChantLines a déjà placé les titres ; ce second appel rend la même
    # hauteur et laisse les positions en place.
    titreHauteur = score.titles.layoutTitles ctxt, largeur
    titreNode = score.titles.createSvgNode ctxt
  serialiseur = new XMLSerializer()
  noeuds = []
  top = 0
  for ligne, index in score.lines
    enfants = []
    enfants.push titreNode if index is 0 and titreNode
    enfants.push ligne.createSvgNode ctxt, top
    groupe = document.createElementNS 'http://www.w3.org/2000/svg', 'g'
    groupe.appendChild defs.cloneNode true
    groupe.appendChild enfant for enfant in enfants
    hauteur = ligne.bounds.height + ctxt.staffInterval * 1.5
    hauteur += titreHauteur if index is 0
    svg = document.createElementNS 'http://www.w3.org/2000/svg', 'svg'
    svg.setAttribute 'xmlns', 'http://www.w3.org/2000/svg'
    svg.setAttribute 'version', '1.1'
    svg.setAttribute 'class', ctxt.getSvgClass()
    svg.setAttribute 'width', score.bounds.width
    svg.setAttribute 'height', hauteur
    svg.setAttribute 'viewBox', "0 0 #{score.bounds.width} #{hauteur}"
    svg.appendChild groupe
    noeuds.push neutraliserSvg serialiseur.serializeToString svg
    top += hauteur
  noeuds

# Met un gabc en page à la largeur voulue : une ligne de chant = une page.
# Résout {svgs, mode} ; rejette un gabc vide, sans note ou illisible.
miseEnPageGabc = (texte, {scale, largeur} = {}) ->
  chargerExsurge().then (exsurge) ->
    largeur ?= largeurPageGabc()
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
      score.layoutChantLines ctxt, largeur
      unless score.lines?.length
        throw new Error t 'errors.gabcInvalid'
      {svgs: construireSvgs(score, ctxt, largeur, nom), mode: 'vertical'}
    catch err
      throw err if err?.message is t 'errors.gabcInvalid'
      throw new Error "#{t 'errors.gabcInvalid'} (#{err?.message or err})"

# --- Requêtes de l'application ---------------------------------------------
mouvementGregorienAffiche = ->
  return null unless typeof getMovementForPage is 'function' and typeof displayedPage is 'function'
  getMovementForPage(displayedPage())?.movement or null

estGregorienAffiche = -> !!mouvementGregorienAffiche()?.gregorien
