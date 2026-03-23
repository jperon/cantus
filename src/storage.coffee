# storage.coffee — IndexedDB persistence for files and reading positions

DB_NAME = "musica"
DB_VERSION = 1
db = null

openDB = ->
  new Promise (resolve, reject) ->
    req = indexedDB.open DB_NAME, DB_VERSION
    req.onupgradeneeded = (e) ->
      d = e.target.result
      unless d.objectStoreNames.contains "files"
        d.createObjectStore "files", { keyPath: "id" }
      unless d.objectStoreNames.contains "positions"
        d.createObjectStore "positions", { keyPath: "fileId" }
    req.onsuccess = ->
      db = req.result
      resolve db
    req.onerror = ->
      reject req.error

ensureDB = ->
  if db then Promise.resolve(db) else openDB()

generateId = ->
  Date.now().toString(36) + Math.random().toString(36).substr(2, 5)

# Files store
saveFile = (name, xml) ->
  ensureDB().then (d) ->
    new Promise (resolve, reject) ->
      id = generateId()
      tx = d.transaction "files", "readwrite"
      tx.objectStore("files").put { id, name, xml, addedAt: Date.now() }
      tx.oncomplete = ->
        console.log "IndexedDB écriture: fichier '#{name}' (id: #{id})"
        resolve id
      tx.onerror = -> reject tx.error

listFiles = ->
  ensureDB().then (d) ->
    new Promise (resolve, reject) ->
      tx = d.transaction "files", "readonly"
      req = tx.objectStore("files").getAll()
      req.onsuccess = ->
        files = req.result.sort (a, b) -> b.addedAt - a.addedAt
        console.log "IndexedDB lecture: liste fichiers (#{files.length} fichiers)"
        resolve files
      req.onerror = -> reject req.error

getFile = (id) ->
  ensureDB().then (d) ->
    new Promise (resolve, reject) ->
      tx = d.transaction "files", "readonly"
      req = tx.objectStore("files").get id
      req.onsuccess = ->
        if req.result
          console.log "IndexedDB lecture: fichier '#{req.result.name}' (id: #{id})"
        resolve req.result
      req.onerror = -> reject req.error

deleteFile = (id) ->
  ensureDB().then (d) ->
    new Promise (resolve, reject) ->
      tx = d.transaction ["files", "positions"], "readwrite"
      tx.objectStore("files").delete id
      tx.objectStore("positions").delete id
      tx.oncomplete = ->
        console.log "IndexedDB suppression: fichier id #{id}"
        resolve()
      tx.onerror = -> reject tx.error

# Positions store
savePosition = (fileId, page) ->
  ensureDB().then (d) ->
    new Promise (resolve, reject) ->
      tx = d.transaction "positions", "readwrite"
      tx.objectStore("positions").put { fileId, page, savedAt: Date.now() }
      tx.oncomplete = ->
        console.log "IndexedDB écriture: position fichier #{fileId} page #{page}"
        resolve()
      tx.onerror = -> reject tx.error

getPosition = (fileId) ->
  ensureDB().then (d) ->
    new Promise (resolve, reject) ->
      tx = d.transaction "positions", "readonly"
      req = tx.objectStore("positions").get fileId
      req.onsuccess = ->
        page = req.result?.page or 1
        console.log "IndexedDB lecture: position fichier #{fileId} page #{page}"
        resolve page
      req.onerror = -> reject req.error

# Export as global
window.__musicaStorage = {
  saveFile
  listFiles
  getFile
  deleteFile
  savePosition
  getPosition
}
