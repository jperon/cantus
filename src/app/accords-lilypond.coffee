# accords-lilypond.coffee — noms d'accords LilyPond (chordmode, langue
# nederlands) rencontrés dans les [alt:…] du gabc.
#
# Le réglage « Lire les accords dans [alt:] » est opt-in : un [alt:] dont le
# contenu est un nom d'accord valide est réécrit en symbole usuel (notation
# anglaise, la seule que Cantus emploie pour les accords) et transposé avec la
# transposition visuelle. Tout le reste est laissé intact, sans erreur.
#
# L'API est exposée dans window.__musicaAccords et module.exports (tests).

# Lettres de la notation anglaise, dans l'ordre des degrés (0 = do).
LETTRES = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
# Hauteur naturelle de chaque lettre, en demi-tons depuis do.
NATURELS = [0, 2, 4, 5, 7, 9, 11]

# Noms nederlands de LilyPond (scm/lily/define-note-names.scm) : lettre et
# altération en demi-tons. Les alias ees/eeses (mi bémol) et aes/aeses (la
# bémol) sont aussi acceptés par LilyPond.
NOTES = {
  c: [0, 0], cis: [0, 1], cisis: [0, 2], ces: [0, -1], ceses: [0, -2],
  d: [1, 0], dis: [1, 1], disis: [1, 2], des: [1, -1], deses: [1, -2],
  e: [2, 0], eis: [2, 1], eisis: [2, 2],
  es: [2, -1], eses: [2, -2], ees: [2, -1], eeses: [2, -2],
  f: [3, 0], fis: [3, 1], fisis: [3, 2], fes: [3, -1], feses: [3, -2],
  g: [4, 0], gis: [4, 1], gisis: [4, 2], ges: [4, -1], geses: [4, -2],
  a: [5, 0], ais: [5, 1], aisis: [5, 2],
  as: [5, -1], ases: [5, -2], aes: [5, -1], aeses: [5, -2],
  b: [6, 0], bis: [6, 1], bisis: [6, 2], bes: [6, -1], beses: [6, -2]
}

# Noms les plus longs d'abord : « beses » avant « bes », « isis » avant « is ».
triNoms = ->
  noms = (nom for nom of NOTES)
  noms.sort (a, b) -> b.length - a.length
NOMS_TRIES = triNoms()

# Modificateurs nommés de LilyPond, les plus longs d'abord (« maj » avant
# « m », « sus4 » avant « sus »).
MODIFICATEURS = ['sus2', 'sus4', 'maj', 'dim', 'aug', 'min', 'sus', 'm']

# Une note nederlands à la position `debut`, ou null.
lireNote = (texte, debut) ->
  for nom in NOMS_TRIES
    continue unless texte.substr(debut, nom.length) is nom
    [lettre, alteration] = NOTES[nom]
    return {lettre, alteration, fin: debut + nom.length}
  null

# Lit les modificateurs après « : ». Retourne la position de fin, ou -1 si le
# texte n'est pas une suite de modificateurs LilyPond.
lireModificateurs = (texte, depart, accord) ->
  pos = depart
  vu = false
  loop
    saut = 0
    while texte.charAt(pos) is '.'
      pos += 1
      saut += 1
    if pos >= texte.length or texte.charAt(pos) is '/'
      # Un point ne peut pas terminer les modificateurs, ni se répéter.
      return -1 if saut
      break
    return -1 if saut > 1
    caractere = texte.charAt pos
    if caractere is '^'
      # Retrait d'une étape : « c:7^3 ».
      pos += 1
      m = /^(\d{1,2})/.exec texte.slice pos
      return -1 unless m
      degre = parseInt m[1], 10
      return -1 unless degre >= 1 and degre <= 13
      accord.retraits.push degre
      pos += m[0].length
      vu = true
      continue
    nom = (mod for mod in MODIFICATEURS when texte.substr(pos, mod.length) is mod)[0]
    if nom?
      pos += nom.length
      switch nom
        when 'm', 'min' then accord.mineur = true
        when 'dim' then accord.dimine = true
        when 'aug' then accord.augmente = true
        when 'maj' then accord.majSept = true
        when 'sus', 'sus4' then accord.sus = 4
        when 'sus2' then accord.sus = 2
      vu = true
      continue
    # Étape numérique (6, 7, 9, 13…) et ses altérations (+/-).
    m = /^(\d{1,2})/.exec texte.slice pos
    return -1 unless m
    degre = parseInt m[1], 10
    return -1 unless degre >= 1 and degre <= 13
    pos += m[0].length
    alteration = 0
    while texte.charAt(pos) is '+' or texte.charAt(pos) is '-'
      alteration += if texte.charAt(pos) is '+' then 1 else -1
      pos += 1
    accord.etapes.push {degre, alteration}
    vu = true
  if vu then pos else -1

# Analyse un nom d'accord LilyPond (chordmode). Retourne un objet ou null.
# La durée éventuelle est acceptée puis ignorée.
analyserAccord = (texte) ->
  return null unless typeof texte is 'string'
  texteAccord = texte.trim()
  return null if texteAccord is ''
  racine = lireNote texteAccord, 0
  return null unless racine
  pos = racine.fin
  if /^\d/.test texteAccord.charAt(pos)
    m = /^\d+\.*(?:\*\d+(?:\/\d+)?)?/.exec texteAccord.slice pos
    return null unless m
    pos += m[0].length
  accord = {
    lettre: racine.lettre
    alteration: racine.alteration
    mineur: false
    diminue: false
    augmente: false
    sus: null
    majSept: false
    etapes: []
    retraits: []
    basse: null
  }
  if texteAccord.charAt(pos) is ':'
    pos = lireModificateurs texteAccord, pos + 1, accord
    return null if pos < 0
  if texteAccord.charAt(pos) is '/'
    pos += 1
    pos += 1 if texteAccord.charAt(pos) is '+'
    basse = lireNote texteAccord, pos
    return null unless basse
    pos = basse.fin
    accord.basse = {lettre: basse.lettre, alteration: basse.alteration}
  return null unless pos is texteAccord.length
  accord

# --- Affichage --------------------------------------------------------------
alterationTexte = (alteration) ->
  return '' unless alteration
  if alteration > 0 then '♯'.repeat(alteration) else '♭'.repeat(-alteration)

afficherNote = (lettre, alteration) ->
  LETTRES[lettre] + alterationTexte(alteration)

# Ordre usuel des extensions après la septième : sixte, neuvième, onzième,
# treizième ; les autres degrés suivent, par ordre croissant.
ORDRE_EXTENSIONS = [6, 9, 11, 13]
rangExtension = (degre) ->
  index = ORDRE_EXTENSIONS.indexOf degre
  if index >= 0 then index else 100 + degre

# Symbole usuel d'un accord analysé : « F♯m7/A », « B♭maj7 », « C7♭9 ».
afficherAccord = (accord) ->
  texte = afficherNote accord.lettre, accord.alteration
  # Qualité : la suspension remplace la tierce, donc pas de « m » avec elle.
  qualite = ''
  unless accord.sus?
    if accord.dimine then qualite = 'dim'
    else if accord.augmente then qualite = 'aug'
    else if accord.mineur then qualite = 'm'
  texte += qualite
  etapes = accord.etapes
  septieme = etapes.find (etape) -> etape.degre is 7
  if accord.majSept
    # « maj » fixe la septième majeure ; « m.maj » donne mMaj7. Avec une
    # neuvième, onzième ou treizième, le 7 est sous-entendu (Cmaj9).
    etendue = etapes.some (etape) -> etape.degre in [9, 11, 13]
    if etendue
      texte += if accord.mineur then 'Maj' else 'maj'
    else
      texte += if accord.mineur then 'Maj7' else 'maj7'
  else if septieme?
    texte += alterationTexte(septieme.alteration) + '7'
  cinquieme = etapes.find (etape) -> etape.degre is 5
  if cinquieme? and cinquieme.alteration isnt 0
    texte += alterationTexte(cinquieme.alteration) + '5'
  autres = etapes.filter (etape) -> etape.degre isnt 5 and etape.degre isnt 7
  autres.sort (a, b) -> rangExtension(a.degre) - rangExtension(b.degre)
  for etape in autres
    texte += alterationTexte(etape.alteration) + etape.degre
  # Accord de quinte seule (« c:5 ») : pas de tierce ni d'extension.
  if cinquieme?.alteration is 0 and etapes.length is 1 and qualite is '' and
      not accord.majSept and not accord.sus?
    texte += '5'
  texte += "sus#{accord.sus}" if accord.sus?
  if accord.retraits.length
    retraits = accord.retraits.slice().sort (a, b) -> a - b
    texte += '(' + ("no#{degre}" for degre in retraits).join(', ') + ')'
  if accord.basse?
    texte += '/' + afficherNote accord.basse.lettre, accord.basse.alteration
  texte

# --- Transposition ----------------------------------------------------------
# Écart diatonique (en degrés de gamme) pour chaque déplacement de 0 à 12
# demi-tons : une seconde pour 1-2, une tierce pour 3-4, etc. Le tritone monte
# d'une quarte augmentée.
DIATONIE = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6, 7]

modulo = (n, m) -> ((n % m) + m) % m

# Transpose une note en choisissant, parmi les orthographes diatoniques
# voisines, celle qui demande le moins d'altérations. À égalité, une
# transposition montante prend les dièses et une descendante les bémols
# (do +1 → do♯, si −1 → si♭), ce qui donne des altérations usuelles.
transposerNote = (lettre, alteration, demiTons) ->
  return {lettre, alteration} unless demiTons
  # Une octave (ou douze octaves) garde l'orthographe : c'est la même note.
  return {lettre, alteration} if demiTons % 12 is 0
  nominal = if demiTons >= 0 then DIATONIE[demiTons] else -DIATONIE[-demiTons]
  hauteur = modulo NATURELS[lettre] + alteration + demiTons, 12
  meilleur = null
  for diatonie in [nominal - 1 .. nominal + 1]
    nouvelleLettre = modulo lettre + diatonie, 7
    alterationCible = hauteur - NATURELS[nouvelleLettre]
    # Rester près de l'altération naturelle (au-delà du tritone, c'est
    # l'enharmonique qui se lit le mieux).
    alterationCible -= 12 if alterationCible > 6
    alterationCible += 12 if alterationCible < -6
    if not meilleur? or Math.abs(alterationCible) < Math.abs(meilleur.alteration) or
        (Math.abs(alterationCible) is Math.abs(meilleur.alteration) and
          (if demiTons > 0 then diatonie < meilleur.diatonie else diatonie > meilleur.diatonie))
      meilleur = {diatonie, alteration: alterationCible}
  lettre: modulo(lettre + meilleur.diatonie, 7)
  alteration: meilleur.alteration

# Transpose la fondamentale et la basse ; les modificateurs sont inchangés.
transposerAccord = (accord, demiTons) ->
  return accord unless demiTons
  resultat = Object.assign {}, accord
  racine = transposerNote accord.lettre, accord.alteration, demiTons
  resultat.lettre = racine.lettre
  resultat.alteration = racine.alteration
  if accord.basse?
    basse = transposerNote accord.basse.lettre, accord.basse.alteration, demiTons
    resultat.basse = {lettre: basse.lettre, alteration: basse.alteration}
  resultat

# --- Réécriture du gabc -----------------------------------------------------
# Remplace le contenu des [alt:…] reconnus par leur symbole, transposé.
# `options` : {actif, transpose}. Inactif, le texte est rendu tel quel.
reecrireTexteGabc = (texte, options = {}) ->
  return texte unless options.actif
  return texte unless typeof texte is 'string'
  transpose = options.transpose ? 0
  texte.replace /\[alt:([^\]]*)\]/g, (tout, contenu) ->
    accord = analyserAccord contenu
    return tout unless accord?
    accord = transposerAccord accord, transpose
    "[alt:#{afficherAccord accord}]"

apiAccords = {analyserAccord, transposerAccord, afficherAccord, afficherNote, reecrireTexteGabc}

window.__musicaAccords = apiAccords if typeof window isnt 'undefined'
module.exports = apiAccords if typeof module isnt 'undefined' and module.exports?
