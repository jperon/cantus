# Initialisation : câblage des modules au DOMContentLoaded et démarrage.
# Init
document.addEventListener "DOMContentLoaded", ->
  applyLanguagePreference()
  applyAllSettings()
  setupLanguage()
  setupNavigation()
  setupTransport()
  setupImport()
  setupLibrary()
  setupSettings()
  setupResize()

  # Request increased storage quota for MusicXML files
  requestStorageQuota()

  # Handle protocol handlers and file parameters
  handleProtocolParameters()

  # Vertical scroll listener: one alignment/indicator pass per frame
  $("page-current").addEventListener "scroll", ->
    return if scrollScheduled
    scrollScheduled = true
    requestAnimationFrame ->
      scrollScheduled = false
      applyVerticalAlignment()
      # Défilement manuel : seule une page affichée différente déclenche la
      # cale (après debounce), pas chaque frame du geste. fromScroll distingue
      # ce cas asynchrone des sauts explicites : pendant la lecture avec suivi,
      # une mesure périmée ne doit pas faire reculer la tête (voir
      # schedulePageSeek).
      noteDisplayedPage true
      if scrollMode is "vertical"
        showIndicator()
        prefetch()
        # Native scrolling also changes the memorised page
        savePositionDebounced()
  # Worker will send "ready" when initialized
  worker.postMessage {type: "init"}
