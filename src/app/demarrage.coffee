# Démarrage : date de build, installation PWA et service worker.
# Les écouteurs sont posés dès le chargement, avant tout le reste.
buildDate = window.__musicaBuildDate ? "(non défini)"

# App — logique principale (worker-based with movement support)

console.log "Musica — Liseuse MusicXML"
console.log "Date de build : #{buildDate}"

# PWA Installation Management - CRITICAL: Must be attached immediately!
deferredPrompt = null
installButton = null

# Handle beforeinstallprompt event - MUST be attached before any other code
window.addEventListener 'beforeinstallprompt', (e) ->
  console.log "PWA: Installation prompt available"
  e.preventDefault()
  deferredPrompt = e
  console.log "PWA: Prompt event stored for later use"

# Check if we missed the event (for debugging)
setTimeout ->
  unless deferredPrompt
    console.log "PWA: No prompt event received yet - may need more visits"
  else
    console.log "PWA: Prompt event available for use"
, 1000

# Show install button when PWA installation is possible
showInstallButton = ->
  installSection = $("install-section")
  installButton = $("btn-install")

  if installSection and installButton
    installSection.classList.remove "hidden"
    installButton.addEventListener "click", installPWA
    console.log "PWA: Install button shown"

# Show install button immediately on first visit
showInstallButtonFirst = ->
  installSection = $("install-section")
  installButton = $("btn-install")

  if installSection and installButton
    installSection.classList.remove "hidden"
    installButton.addEventListener "click", installPWA
    console.log "PWA: Install button shown on first visit"

# Install PWA when button is clicked
installPWA = ->
  if deferredPrompt
    # Use the deferred prompt if available
    console.log "PWA: Showing install prompt"

    deferredPrompt.prompt()
      .then (result) ->
        {outcome} = result
        console.log "PWA: Install outcome - #{outcome}"

        if outcome is 'accepted'
          console.log "PWA: User accepted installation"
          showInstallMessage "Installation en cours...", "success"
        else
          console.log "PWA: User dismissed installation"
          showInstallMessage "Installation annulée", "info"

        # Hide install button regardless of outcome
        hideInstallButton()
        deferredPrompt = null

      .catch (error) ->
        console.error "PWA: Install prompt error:", error
        showInstallMessage "Erreur lors de l'installation", "error"
  else
    # No prompt available yet, show detailed instructions
    console.log "PWA: No install prompt available yet"

    # Check browser and provide specific instructions
    userAgent = navigator.userAgent.toLowerCase()

    if userAgent.includes('chrome') and not userAgent.includes('edg')
      # Chrome/Chromium
      showInstallMessage "Chrome: Revenez après quelques visites pour installer", "info"
      console.log "PWA: Chrome detected - prompt needs multiple visits"

    else if userAgent.includes('firefox')
      # Firefox
      showInstallMessage "Firefox: Appuyez sur l'icône d'installation dans la barre d'adresse", "info"
      console.log "PWA: Firefox detected - manual installation required"

    else if userAgent.includes('safari') and not userAgent.includes('chrome')
      # Safari
      showInstallMessage "Safari: Appuyez sur Partager > Ajouter à l'écran d'accueil", "info"
      console.log "PWA: Safari detected - manual installation required"

    else if userAgent.includes('edg')
      # Edge
      showInstallMessage "Edge: Revenez après quelques visites pour installer", "info"
      console.log "PWA: Edge detected - prompt needs multiple visits"

    else
      # Other browsers
      showInstallMessage "Utilisez le menu du navigateur pour installer", "info"
      console.log "PWA: Unknown browser - generic instructions"

# Hide install button
hideInstallButton = ->
  installSection = $("install-section")
  if installSection
    installSection.classList.add "hidden"

# Show install-related messages
showInstallMessage = (message, type = 'info') ->
  messageEl = document.getElementById 'install-message'
  unless messageEl
    messageEl = document.createElement 'div'
    messageEl.id = 'install-message'
    messageEl.style.cssText = '''
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #2196f3;
      color: white;
      padding: 12px 24px;
      border-radius: 8px;
      z-index: 10000;
      font-size: 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    '''
    document.body.appendChild messageEl

  # Set colors based on type
  colors =
    success: '#4caf50'
    error: '#f44336'
    info: '#2196f3'
    warning: '#ff9800'

  messageEl.style.background = colors[type] or colors.info
  messageEl.textContent = message
  messageEl.style.display = 'block'

  # Auto-hide after 3 seconds
  setTimeout ->
    messageEl.style.display = 'none'
  , 3000

# Check if app is already installed
checkIfInstalled = ->
  if window.navigator.standalone
    console.log "PWA: App is already installed (iOS)"
    hideInstallButton()
  else if window.matchMedia('(display-mode: standalone)').matches
    console.log "PWA: App is already installed (PWA)"
    hideInstallButton()
  else
    # Not installed, show install button immediately
    showInstallButtonFirst()

# Display build date in bottom-left corner. La date suit la langue courante :
# elle est régénérée à chaque changement de langue par langue.coffee.
renderBuildDate = ->
  buildDateEl = document.getElementById("build-date")
  return unless buildDateEl
  buildDateEl.title = buildDate
  try
    date = new Date(buildDate)
    locale = window.__musicaI18n?.language() ? "en"
    day = date.toLocaleDateString(locale, {day: '2-digit', month: '2-digit', year: 'numeric'})
    time = date.toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'})
    buildDateEl.textContent = t "build.version", {date: day, time: time}
  catch
    buildDateEl.textContent = buildDate

document.addEventListener "DOMContentLoaded", ->
  # Check if PWA is already installed and show button if not
  checkIfInstalled()

  renderBuildDate()

# Service Worker management - Local First PWA
setupServiceWorker = ->
  if navigator.serviceWorker?
    navigator.serviceWorker.register('./sw.js')
      .then (registration) ->
        console.log "Service Worker enregistré:", registration.scope

        # Écouter les mises à jour du service worker
        registration.addEventListener 'updatefound', ->
          newWorker = registration.installing
          console.log "Nouveau Service Worker détecté"

          newWorker.addEventListener 'statechange', ->
            if newWorker.state is 'installed' and navigator.serviceWorker.controller
              # Un nouveau SW est prêt et il y en a déjà un actif
              showUpdateNotification()

        # Écouter les messages du service worker
        navigator.serviceWorker.addEventListener 'message', handleServiceWorkerMessage

        # Vérifier les mises à jour quand l'application redevient visible
        document.addEventListener 'visibilitychange', ->
          registration.update() if document.visibilityState is 'visible'

      .catch (error) ->
        console.error "Erreur d'enregistrement du Service Worker:", error

# Gérer les messages du service worker
handleServiceWorkerMessage = (event) ->
  {type, data, timestamp} = event.data

  switch type
    when 'update'
      console.log "Mise à jour disponible:", data
      showUpdateMessage(data.message)

    when 'cache-updated'
      console.log "Cache mis à jour:", data

# Afficher une notification de mise à jour
showUpdateNotification = ->
  notification = document.createElement 'div'
  notification.className = 'update-notification'
  notification.innerHTML = '''
    <div class="update-content">
      <span>🔄 Une nouvelle version est disponible</span>
      <button id="update-btn">Mettre à jour</button>
      <button id="dismiss-btn">Plus tard</button>
    </div>
  '''

  # Style de la notification
  notification.style.cssText = '''
    position: fixed;
    top: 20px;
    right: 20px;
    background: #4CAF50;
    color: white;
    padding: 15px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 10000;
    max-width: 300px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  '''

  # Ajouter les styles pour les boutons
  style = document.createElement 'style'
  style.textContent = '''
    .update-content {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .update-content button {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: background-color 0.2s;
    }
    #update-btn {
      background: white;
      color: #4CAF50;
      font-weight: bold;
    }
    #update-btn:hover {
      background: #f0f0f0;
    }
    #dismiss-btn {
      background: transparent;
      color: white;
      border: 1px solid white;
    }
    #dismiss-btn:hover {
      background: rgba(255,255,255,0.1);
    }
  '''

  document.head.appendChild style
  document.body.appendChild notification

  # Gérer les clics
  document.getElementById('update-btn').addEventListener 'click', ->
    # Demander au nouveau service worker de s'activer
    navigator.serviceWorker.getRegistration().then (registration) ->
      if registration.waiting
        registration.waiting.postMessage {type: 'SKIP_WAITING'}
        # Recharger après un court délai
        setTimeout ->
          window.location.reload()
        , 1000

  document.getElementById('dismiss-btn').addEventListener 'click', ->
    notification.remove()

  # Auto-dismiss après 30 secondes
  setTimeout ->
    if notification.parentNode
      notification.remove()
  , 30000

# Afficher un message de mise à jour simple
showUpdateMessage = (message) ->
  messageEl = document.createElement 'div'
  messageEl.className = 'update-message'
  messageEl.textContent = message
  messageEl.style.cssText = '''
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #2196F3;
    color: white;
    padding: 10px 20px;
    border-radius: 20px;
    font-size: 14px;
    z-index: 9999;
    opacity: 0;
    transition: opacity 0.3s;
  '''

  document.body.appendChild messageEl

  # Animation d'apparition
  setTimeout ->
    messageEl.style.opacity = '1'
  , 100

  # Auto-disparition après 5 secondes
  setTimeout ->
    messageEl.style.opacity = '0'
    setTimeout ->
      if messageEl.parentNode
        messageEl.remove()
    , 300
  , 5000

# Initialiser le service worker
setupServiceWorker()

