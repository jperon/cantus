# i18n.coffee — internationalisation : dictionnaires par langue et fonction t.
#
# Les dictionnaires sont un fichier par langue dans src/i18n/ ; build.js les
# concatène à la suite de ce module (comme APP_SOURCES) et l'ensemble est
# injecté avant l'application dans les deux pages. Chaque dictionnaire
# s'enregistre avec registerLanguage(code, nom, messages).
#
# L'anglais (en) est la langue de référence : une clé absente d'une autre
# langue y est lue, et une clé absente de l'anglais est une erreur visible en
# console, la clé elle-même étant affichée (le test unitaire garantit que les
# dictionnaires ont exactement les mêmes clés et les mêmes {paramètres}).
#
# Pluriel : une clé `x` avec `{count}` est cherchée sous `x_<forme>` (règle
# Intl.PluralRules de la langue), puis `x_other`, puis `x`. Les dictionnaires
# n'ont donc que les formes réellement utilisées (`_one`, `_other`).
#
# API exposée (window.__musicaI18n dans la page, self.__musicaI18n dans le
# worker, module.exports en CommonJS pour build.js et les tests Node) :
#   t(key, params)            texte traduit, {nom} interpolé
#   language()                code de la langue courante
#   setLanguage(code)         change la langue (false si aucun dictionnaire)
#   languages()               [{code, name}] des dictionnaires présents
#   registerLanguage(code, name, messages)  enregistre un dictionnaire
#   messages(code)            dictionnaire brut (tests de cohérence)

FALLBACK_LANGUAGE = 'en'

DICTIONARIES = {}
currentLanguage = FALLBACK_LANGUAGE

registerLanguage = (code, name, messages) ->
  DICTIONARIES[code] = {name, messages}

language = -> currentLanguage

languages = ->
  ({code, name: entry.name} for own code, entry of DICTIONARIES)

messages = (code) -> DICTIONARIES[code]?.messages

setLanguage = (code) ->
  return false unless DICTIONARIES[code]
  currentLanguage = code
  if typeof document isnt 'undefined' and document.documentElement
    document.documentElement.lang = code
  true

# Forme du pluriel pour `count` dans la langue courante ; sans Intl.PluralRules
# (environnement ancien), repli sur la règle anglais une/autre.
pluralForm = (count) ->
  try
    return new Intl.PluralRules(currentLanguage).select count
  catch
    return if count is 1 then 'one' else 'other'

# Valeur d'une clé dans un dictionnaire : formes plurielles d'abord quand un
# compte est fourni, puis la clé simple. `undefined` si absente.
resolve = (dict, key, count) ->
  return undefined unless dict
  if count?
    form = pluralForm count
    value = dict["#{key}_#{form}"] ? dict["#{key}_other"]
    return value if value?
  dict[key]

interpolate = (text, params) ->
  return text unless params
  text.replace /\{(\w+)\}/g, (match, name) ->
    if params[name]? then String(params[name]) else match

t = (key, params = {}) ->
  count = params.count
  value = resolve DICTIONARIES[currentLanguage]?.messages, key, count
  value ?= resolve DICTIONARIES[FALLBACK_LANGUAGE]?.messages, key, count
  unless value?
    console.error "[i18n] clé absente de l'anglais : #{key}"
    return key
  interpolate String(value), params

api = {
  t
  language
  setLanguage
  languages
  registerLanguage
  messages
  FALLBACK_LANGUAGE
}

window.__musicaI18n = api if typeof window isnt 'undefined'
self.__musicaI18n = api if typeof self isnt 'undefined'
module.exports = api if typeof module isnt 'undefined' and module.exports?
