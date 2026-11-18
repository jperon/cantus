# playback.coffee — logique pure du suivi de partition pendant la lecture.
#
# Aucun DOM, aucun audio : l'entrée est la liste des marqueurs de
# synchronisation produite par le worker (syncMarks : {t, page, id}, triés par
# t croissant), la sortie est un objet JS pur. La page et le système cibles
# sont ensuite appliqués par `src/app/transport-suivi.coffee`.
#
# API exposée (window.__musicaPlayback dans le navigateur, module.exports en
# CommonJS pour les tests Node) :
#   markAt(marks, tMs)             -> dernier marqueur dont t <= tMs, ou null
#   firstMarkOfPage(marks, page)   -> premier marqueur d'une page, ou null
#   planFollow(marks, tMs, opts)   -> {page, id} ou null
#
# `opts.scrollUnit` vaut "system" ou "page" (défaut). En mode page, l'id choisi
# est celui du premier marqueur de la page : la cible ne dépend pas des
# marqueurs intermédiaires. En mode système, l'id du marqueur courant désigne
# le système à amener en haut de l'écran.

markAt = (marks, tMs) ->
  return null unless Array.isArray(marks) and marks.length
  t = Number tMs
  return null unless isFinite t
  # Dernier marqueur dont le temps est <= t (recherche dichotomique)
  lo = 0
  hi = marks.length
  while lo < hi
    mid = (lo + hi) >> 1
    if (Number(marks[mid].t) or 0) <= t then lo = mid + 1 else hi = mid
  return null if lo is 0
  marks[lo - 1]

firstMarkOfPage = (marks, page) ->
  return null unless Array.isArray(marks) and marks.length
  target = Number page
  return null unless isFinite target
  for mark in marks when Number(mark.page) is target
    return mark
  null

planFollow = (marks, tMs, options = {}) ->
  return null unless Array.isArray(marks) and marks.length
  base = markAt(marks, tMs) ? marks[0]
  page = Number base.page
  return null unless isFinite page
  if options.scrollUnit is "system"
    {page, id: base.id}
  else
    first = firstMarkOfPage marks, page
    {page, id: (first ? base).id}

api = {markAt, firstMarkOfPage, planFollow}

window.__musicaPlayback = api if typeof window isnt 'undefined'
module.exports = api if typeof module isnt 'undefined' and module.exports?
