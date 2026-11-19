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

  # Un défilement manuel (molette, tactile) est le seul à pouvoir charger la
  # page précédente : la navigation programme elle aussi des `scroll`. En haut
  # du défilement, aucune place ne reste pour un `scroll` : la molette et le
  # geste tactile appellent donc la vérification directement.
  slot = $("page-current")
  slot.addEventListener "wheel", (e) ->
    manualScrollAt = Date.now()
    checkAndLoadPreviousPage() if e.deltaY < 0
  slot.addEventListener "touchmove", ->
    manualScrollAt = Date.now()
    checkAndLoadPreviousPage()

  # Vertical scroll listener: one alignment/indicator pass per frame
  $("page-current").addEventListener "scroll", ->
    return if scrollScheduled
    scrollScheduled = true
    requestAnimationFrame ->
      scrollScheduled = false
      applyVerticalAlignment()
      if scrollMode is "vertical"
        # Défilement manuel vers le haut : rendre la page précédente avant que
        # le haut de la fenêtre rendue ne soit atteint.
        checkAndLoadPreviousPage()
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
