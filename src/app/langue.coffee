# Langue de l'interface : préférence enregistrée, choix dans les réglages et
# application des textes statiques (data-i18n) et dynamiques.
LANGUAGE_KEY = "musica-language"

# Raccourci vers le module i18n injecté avant l'application.
t = (key, params) -> window.__musicaI18n.t key, params

storedLanguage = ->
  try
    localStorage.getItem LANGUAGE_KEY
  catch
    null

# Code supporté à partir d'une étiquette de navigateur (« fr-CA » -> « fr »).
supportedLanguage = (code) ->
  base = String(code or "").toLowerCase().split("-")[0]
  return null unless base
  return base if window.__musicaI18n.languages().some (lang) -> lang.code is base
  null

# Préférence enregistrée, puis langues du navigateur, puis anglais.
detectLanguage = ->
  saved = supportedLanguage storedLanguage()
  return saved if saved
  candidates = Array.from navigator.languages or []
  candidates = [navigator.language] if candidates.length is 0 and navigator.language
  for code in candidates
    found = supportedLanguage code
    return found if found
  window.__musicaI18n.FALLBACK_LANGUAGE

# Textes présents dans le HTML source, marqués par data-i18n*.
applyStaticTexts = ->
  i18n = window.__musicaI18n
  for el in document.querySelectorAll "[data-i18n]"
    el.textContent = i18n.t el.getAttribute "data-i18n"
  for el in document.querySelectorAll "[data-i18n-title]"
    el.title = i18n.t el.getAttribute "data-i18n-title"
  for el in document.querySelectorAll "[data-i18n-aria-label]"
    el.setAttribute "aria-label", i18n.t el.getAttribute "data-i18n-aria-label"
  for el in document.querySelectorAll "[data-i18n-placeholder]"
    el.setAttribute "placeholder", i18n.t el.getAttribute "data-i18n-placeholder"
  for el in document.querySelectorAll "[data-i18n-content]"
    el.setAttribute "content", i18n.t el.getAttribute "data-i18n-content"
  document.title = i18n.t "app.title"

# Textes générés par le code : les régénérer dans la nouvelle langue.
refreshDynamicTexts = ->
  for el in document.querySelectorAll ".loading-placeholder"
    el.textContent = t "loading"
  renderBuildDate()
  renderTransport()
  rafraichirBasculeNotation?()
  updateCommandBarSpace()
  renderHomeTexts?()
  renderRecentFiles?()
  unless $("settings-overlay")?.classList.contains "hidden"
    renderPartsList()
    renderTempoUi()
  unless $("library-overlay")?.classList.contains "hidden"
    renderLibrary()

# Change la langue à chaud (aucun rechargement). `persist` enregistre le choix ;
# l'absence de préférence laisse la détection au navigateur au prochain départ.
applyLanguage = (code, persist = false) ->
  return false unless window.__musicaI18n.setLanguage code
  if persist
    try
      localStorage.setItem LANGUAGE_KEY, code
  applyStaticTexts()
  refreshDynamicTexts()
  select = $("language-select")
  select.value = code if select
  true

applyLanguagePreference = ->
  applyLanguage detectLanguage()

# Liste dérivée des dictionnaires présents (aucune langue en dur ici).
setupLanguage = ->
  select = $("language-select")
  return unless select
  select.innerHTML = ""
  for lang in window.__musicaI18n.languages()
    option = document.createElement "option"
    option.value = lang.code
    option.textContent = lang.name
    select.appendChild option
  select.value = window.__musicaI18n.language()
  select.addEventListener "change", ->
    applyLanguage select.value, true
