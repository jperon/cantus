# App — logique principale
# Sera compilé et injecté dans index.html

console.log "Musica — Liseuse MusicXML"

# Placeholder — sera étoffé à l'étape 3
document.addEventListener "DOMContentLoaded", ->
  loading = document.getElementById "overlay-loading"
  loading?.classList.add "hidden"
  console.log "App initialisée"
