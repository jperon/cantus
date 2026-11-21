# Intégration : stockage et quota, protocole, URL, partage système et
# messages d’erreur affichés à l’utilisateur.
# Request increased storage quota for MusicXML files
requestStorageQuota = ->
  if navigator.storage?.estimate?
    # Check current usage
    navigator.storage.estimate().then (estimate) ->
      console.log "Storage usage: #{(estimate.usage / 1024 / 1024).toFixed(2)}MB / #{(estimate.quota / 1024 / 1024).toFixed(2)}MB"

      # Request more storage if needed (limit to 200MB)
      if estimate.quota < 200 * 1024 * 1024 # 200MB
        if navigator.storage.persist?
          navigator.storage.persist().then (persistent) ->
            if persistent
              console.log "✅ Storage persistence granted - extended quota available"
              showStorageMessage t("storage.extended"), "success"
            else
              console.log "⚠️ Storage persistence denied"
              currentQuotaMB = (estimate.quota / 1024 / 1024).toFixed(0)
              showStorageMessage t("storage.limited", {mb: currentQuotaMB}), "warning"
        else
          console.log "Storage persistence not supported"
      else
        console.log "✅ Sufficient storage quota available (200MB or more)"

# Show storage-related messages
showStorageMessage = (message, type = 'info') ->
  messageEl = document.getElementById 'storage-message'
  unless messageEl
    messageEl = document.createElement 'div'
    messageEl.id = 'storage-message'
    messageEl.style.cssText = '''
      position: fixed;
      bottom: 60px;
      right: 20px;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      z-index: 1000;
      max-width: 300px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    '''
    document.body.appendChild messageEl

  # Set colors based on type
  colors =
    success: '#4caf50'
    warning: '#ff9800'
    error: '#f44336'
    info: '#2196f3'

  messageEl.style.background = colors[type] or colors.info
  messageEl.style.color = 'white'
  messageEl.textContent = message
  messageEl.style.display = 'block'

  # Auto-hide after 4 seconds
  setTimeout ->
    messageEl.style.display = 'none'
  , 4000

# Handle protocol handlers and URL parameters
handleProtocolParameters = ->
  urlParams = new URLSearchParams window.location.search

  # Handle file parameter from protocol handlers or share target
  fileParam = urlParams.get('file')
  if fileParam
    console.log "Protocol handler: Opening file #{fileParam}"

    # Handle different URL schemes
    if fileParam.startsWith('http://') or fileParam.startsWith('https://')
      # Remote file - fetch and load
      fetchFileFromUrl fileParam
    else if fileParam.startsWith('file://')
      # Local file (limited browser support)
      console.warn "Local file protocol not supported in browsers"
    else
      # Direct file path or base64 data
      loadFileFromParameter fileParam

  # Fichier(s) partagé(s) via Android : le service worker a écrit l'entrée
  # dans IndexedDB puis redirigé vers ?shared=<jeton>.
  sharedToken = urlParams.get('shared')
  if sharedToken
    console.log "Shared file detected: #{sharedToken}"
    importSharedEntry sharedToken

# Lancement par « Ouvrir avec Cantus » : Chromium confie au consumer les
# fichiers ouverts via les file_handlers du manifeste. Les lancements sont mis
# en file d'attente tant qu'aucun consumer n'est enregistré.
setupLaunchQueue = ->
  return unless 'launchQueue' of window
  window.launchQueue.setConsumer (params) ->
    files = params?.files or []
    return unless files.length > 0
    try
      imported = await Promise.all files.map (handle) -> handle.getFile()
      handleImportFiles imported
    catch error
      console.error "Launch file read error:", error
      showError t("errors.launchRead", {error: error?.message or error})

# Fetch file from remote URL
fetchFileFromUrl = (url) ->
  console.log "Fetching remote file: #{url}"
  fetch url
    .then (response) ->
      if response.ok
        response.text()
      else
        throw new Error "HTTP #{response.status}: #{response.statusText}"
    .then (xmlContent) ->
      # Load the fetched MusicXML content
      loadMusicXMLContent xmlContent, url
    .catch (error) ->
      console.error "Failed to fetch remote file:", error
      showError t("errors.remoteLoad", {error: error.message})

# Load file from URL parameter
loadFileFromParameter = (fileData) ->
  try
    if fileData.startsWith('data:') or fileData.startsWith('blob:')
      # Data URL or Blob URL
      loadFileFromDataUrl fileData
    else if fileData.includes('<') and fileData.includes('musicxml')
      # Direct XML content
      loadMusicXMLContent fileData, 'protocol-handler'
    else
      # Assume it's a filename that needs to be resolved
      console.warn "Unsupported file format in protocol handler"
  catch error
    console.error "Error loading file from parameter:", error
    showError t("errors.fileLoad", {error: error.message})

# Load file from Data URL
loadFileFromDataUrl = (dataUrl) ->
  try
    # Extract base64 content from data URL
    matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
    if matches and matches[2]
      decodedContent = atob matches[2]
      loadMusicXMLContent decodedContent, 'data-url'
    else
      throw new Error "Invalid data URL format"
  catch error
    console.error "Error parsing data URL:", error
    showError t("errors.invalidFormat")

# Load MusicXML content into the app
loadMusicXMLContent = (xmlContent, source = 'unknown') ->
  console.log "Loading MusicXML content from #{source}"

  # Create a temporary File object for the import system
  try
    # Parse XML to validate it's MusicXML
    parser = new DOMParser()
    xmlDoc = parser.parseFromString xmlContent, 'text/xml'

    if xmlDoc.getElementsByTagName('parsererror').length > 0
      throw new Error "Invalid XML format"

    # Check if it's MusicXML
    rootElement = xmlDoc.documentElement
    unless rootElement.tagName in ['score-partwise', 'score-timewise']
      throw new Error "Not a valid MusicXML file"

    # Create a File-like object
    filename = if source.includes('url') then 'remote.musicxml' else 'protocol-handler.musicxml'
    file = new File [xmlContent], filename, { type: 'application/vnd.recordare.musicxml+xml' }

    # Use existing import system
    handleFileImport file

  catch error
    console.error "Error processing MusicXML:", error
    showError t("errors.invalidMusicXml", {error: error.message})

# Un MIDI ne porte pas de notation : la partition affichée est une
# transcription. Indication discrète, non bloquante, sur le même principe que
# showError (toast fixe) mais en neutre et affichée plus longtemps.
showTranscriptionNotice = ->
  noticeEl = document.getElementById 'transcription-notice'
  unless noticeEl
    noticeEl = document.createElement 'div'
    noticeEl.id = 'transcription-notice'
    noticeEl.setAttribute 'role', 'status'
    noticeEl.style.cssText = '''
      position: fixed;
      top: 20px;
      right: 20px;
      background: #37474f;
      color: white;
      padding: 10px 16px;
      border-radius: 8px;
      z-index: 10000;
      max-width: 300px;
      font-size: 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    '''
    document.body.appendChild noticeEl
  noticeEl.textContent = t "notice.midiTranscription"
  noticeEl.style.display = 'block'
  clearTimeout transcriptionNoticeTimer if transcriptionNoticeTimer
  transcriptionNoticeTimer = setTimeout ->
    noticeEl.style.display = 'none'
  , 12000

# Show error message to user
showError = (message) ->
  # Create or update error notification
  errorEl = document.getElementById 'protocol-error'
  unless errorEl
    errorEl = document.createElement 'div'
    errorEl.id = 'protocol-error'
    errorEl.style.cssText = '''
      position: fixed;
      top: 20px;
      right: 20px;
      background: #f44336;
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      z-index: 10000;
      max-width: 300px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    '''
    document.body.appendChild errorEl

  errorEl.textContent = message
  errorEl.style.display = 'block'

  # Auto-hide after 5 seconds
  setTimeout ->
    errorEl.style.display = 'none'
  , 5000

# Retire le jeton de partage de l'URL : un rechargement ne doit pas réimporter
removeSharedParam = ->
  url = new URL window.location.href
  url.searchParams.delete 'shared'
  history.replaceState null, '', url.pathname + url.search + url.hash

# Consomme une entrée déposée par le share_target (POST multipart du service
# worker). Les fichiers sont relus depuis IndexedDB puis confiés au pipeline
# d'import habituel (handleImportFiles : bouton d'import, glisser-déposer).
# L'entrée temporaire est supprimée : l'import crée sa propre entrée.
importSharedEntry = (token) ->
  storage.getFile(token).then (entry) ->
    unless entry?.files?.length
      removeSharedParam()
      showError t("errors.sharedNotFound")
      return

    files = for source in entry.files
      new File [source.data], source.name or "#{entry.name}.musicxml"

    storage.deleteFile(token).catch (err) ->
      console.warn "Entrée de partage non supprimée : #{err?.message or err}"

    removeSharedParam()
    handleImportFiles files
  .catch (error) ->
    removeSharedParam()
    showError t("errors.sharedRead", {error: error?.message or error})

