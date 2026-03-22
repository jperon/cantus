# ROADMAP — Liseuse MusicXML PWA

Lecteur de partitions MusicXML pour liseuse Android, implémenté en Pug/CoffeeScript,
buildé en un unique `index.html` autonome (assets inline), accompagné des fichiers PWA
nécessaires pour une installation sur serveur.

---

## Stack technique

| Couche | Choix |
|---|---|
| Templates | Pug |
| Logique | CoffeeScript |
| Rendu partitions | Verovio (WASM) |
| Rendu partiel / breaks | Preprocessing XML + `breaks: "encoded"` |
| Travail arrière-plan | Web Worker (CoffeeScript compilé) |
| Build | npm scripts : `pug` + `coffeescript` + `inline-assets` (ex. `html-inline`) |
| PWA | `manifest.json` + Service Worker (Workbox CLI) |
| Cache offline | Service Worker cache-first sur assets statiques |
| Persistance fichiers | IndexedDB (bibliothèque locale de fichiers MusicXML) |

---

## Contraintes globales

- L'`index.html` final doit fonctionner **sans serveur** (ouverture directe depuis le
  système de fichiers ou via `file://`), avec le WASM Verovio et tous les scripts inline
  en base64 / blobs.
- Le Service Worker et le `manifest.json` sont des fichiers séparés, servis uniquement
  quand l'app est hébergée sur un serveur HTTPS — ils permettent l'installation PWA.
- Aucun framework JS lourd. Vanilla CoffeeScript + DOM.
- L'orientation d'écran n'est pas verrouillée (`"orientation": "any"` dans le manifest).

---

## Étape 1 — Infrastructure de build

**Objectif** : mettre en place la chaîne de compilation qui produit `index.html` et les
fichiers PWA à partir des sources Pug/CoffeeScript.

### Tâches

1. Initialiser le projet npm avec la structure de répertoires suivante :
   ```
   src/
     index.pug          # template principal
     worker.coffee      # Web Worker
     app.coffee         # logique principale
     styles.css         # styles (inlinés dans le build)
   pwa/
     manifest.json
     sw.js              # Service Worker (généré par Workbox ou écrit manuellement)
     icons/             # icônes PWA (192px, 512px)
   dist/                # sortie du build
   build.js             # script de build Node.js
   ```

2. Le script `build.js` doit :
   - Compiler `worker.coffee` → `worker.js`, puis l'encoder en base64 pour l'injecter
     comme Blob URL dans `index.html` (permet au Worker de fonctionner sans serveur).
   - Compiler `app.coffee` → `app.js`.
   - Télécharger le WASM Verovio et le JS wrapper depuis le CDN officiel (ou npm
     `verovio`), les encoder en base64, les injecter inline dans le HTML.
   - Compiler `index.pug` en passant les assets base64 comme variables locales Pug.
   - Inliner le CSS dans une balise `<style>`.
   - Copier `manifest.json`, `sw.js` et les icônes dans `dist/` sans modification.

3. Scripts npm à exposer :
   - `npm run build` — build complet vers `dist/`
   - `npm run watch` — rebuild à chaud pendant le développement
   - `npm run serve` — serveur local HTTPS minimal pour tester la PWA

### Critères de validation
- `dist/index.html` s'ouvre dans Chrome Android sans serveur et sans erreur console.
- `dist/index.html` installable comme PWA quand servi en HTTPS.
- Le Worker se charge correctement depuis le Blob URL inline.

---

## Étape 2 — Intégration Verovio dans le Worker

**Objectif** : charger Verovio dans le Web Worker et exposer une API de rendu par plages
de mesures.

### Tâches

1. Dans `worker.coffee`, implémenter l'initialisation Verovio :
   - Recevoir le WASM base64 depuis le thread principal via `postMessage` au démarrage
     (évite de le dupliquer dans le bundle Worker).
   - Instancier `verovio.toolkit` une seule fois, conserver l'instance en mémoire.

2. Implémenter la fonction `preprocessMusicXML(xmlString)` :
   - Parser le MusicXML comme DOM XML via `new DOMParser()`.
   - Parcourir toutes les `<measure>` du document.
   - Pour chaque mesure contenant une `<barline location="right">` avec
     `<bar-style>light-heavy</bar-style>` ou `<bar-style>light-light</bar-style>`,
     insérer un élément `<print new-system="yes"/>` **au début** de la mesure suivante,
     sauf si cette mesure est la dernière.
   - Gérer le cas où la mesure suivante contient déjà un `<print>` : ajouter
     l'attribut `new-system="yes"` sur l'élément existant plutôt que d'en créer un
     nouveau.
   - Retourner le XML modifié sérialisé en string.

3. Implémenter la fonction `loadScore(xmlString)` :
   - Appeler `preprocessMusicXML`.
   - Appeler `tk.loadData(processedXml)` avec les options :
     ```
     breaks: "encoded"
     adjustPageHeight: true
     pageWidth: <reçu en paramètre depuis le thread principal, en px>
     scale: 40  # valeur initiale, ajustable
     ```
   - Stocker le nombre de pages via `tk.getPageCount()`.
   - Répondre avec `{ type: "loaded", pageCount }`.

4. Implémenter la fonction `renderPage(pageNumber)` :
   - Appeler `tk.renderToSVG(pageNumber)`.
   - Répondre avec `{ type: "svg", pageNumber, svg: <string> }`.

5. Protocole de messages Worker ↔ thread principal :
   ```
   # Entrant
   { type: "init",    wasmBase64: string, pageWidth: number }
   { type: "load",    xml: string, pageWidth: number }
   { type: "render",  page: number }

   # Sortant
   { type: "ready" }                          # Verovio initialisé
   { type: "loaded", pageCount: number }
   { type: "svg",    page: number, svg: string }
   { type: "error",  message: string }
   ```

### Critères de validation
- Charger un fichier MusicXML de 100+ mesures avec au moins 3 doubles barres.
- Vérifier en console que `pageCount` correspond bien aux sections délimitées par les
  doubles barres.
- Le SVG rendu pour chaque page est valide et visuellement correct.

---

## Étape 3 — Interface principale et navigation

**Objectif** : afficher les pages rendues, naviguer par appui sur les côtés.

### Tâches

1. Dans `index.pug`, créer la structure HTML :
   ```pug
   #reader
     #score-container
       #page-prev.svg-slot   // page N-1 (pré-rendue, hors écran gauche)
       #page-current.svg-slot // page N (visible)
       #page-next.svg-slot   // page N+1 (pré-rendue, hors écran droit)
     #tap-left               // zone de tap gauche, 30% de largeur
     #tap-right              // zone de tap droit, 30% de largeur
   #overlay-loading          // spinner initial
   #overlay-error            // message d'erreur
   ```

2. Dans `app.coffee`, implémenter le gestionnaire de navigation :
   - `currentPage` démarre à 1.
   - Tap zone droite → `currentPage += 1` (si `< pageCount`).
   - Tap zone gauche → `currentPage -= 1` (si `> 1`).
   - La transition consiste uniquement à remplacer le contenu innerHTML des slots,
     **sans aucun effet CSS** (`transition: none`, `scroll-behavior: auto`).
   - Le défilement est géré en repositionnant `score-container` via `scrollLeft`
     instantané ou via `transform: translateX` sans animation.

3. Implémenter le préchargement :
   - Après chaque changement de page, demander immédiatement au Worker de rendre
     `currentPage + 1` et `currentPage + 2` si elles n'ont pas encore été mises en cache.
   - Conserver un cache mémoire `Map<pageNumber, svgString>` dans `app.coffee`.
   - Quand un SVG est reçu du Worker, l'insérer dans le slot approprié si c'est la page
     courante, sinon le stocker dans le cache.

4. Implémenter l'import de fichier :
   - Bouton d'import visible uniquement quand aucun fichier n'est chargé.
   - `<input type="file" accept=".xml,.musicxml">`.
   - Lire le fichier via `FileReader.readAsText`, envoyer au Worker via
     `{ type: "load", xml, pageWidth: window.innerWidth }`.

### Critères de validation
- Navigation fluide et instantanée (pas de flash, pas d'animation parasite).
- Les pages N+1 et N+2 sont déjà dans le cache avant qu'on en ait besoin.
- Fonctionne correctement en portrait et en paysage après rotation.

---

## Étape 4 — Gestion du `pageWidth` et redimensionnement

**Objectif** : adapter le rendu Verovio à la taille réelle de l'écran, et réagir aux
rotations.

### Tâches

1. Calculer `pageWidth` comme `window.innerWidth` en pixels, converti en millimètres
   pour Verovio (qui travaille en mm par défaut) :
   `pageWidthMm = Math.round(window.innerWidth / devicePixelRatio * 25.4 / 96)`
   Passer cette valeur dans `{ type: "load" }` et `{ type: "init" }`.

2. Écouter `window.addEventListener("resize", ...)` avec un debounce de 300 ms.
   En cas de changement significatif de `innerWidth` (> 5%) :
   - Relancer `{ type: "load" }` avec le nouveau `pageWidth` (Verovio recalcule
     tous les breaks).
   - Invalider le cache mémoire.
   - Ré-afficher la page courante.

3. Conserver le `currentPage` à travers le rechargement si la partition reste la même.

### Critères de validation
- Rotation portrait ↔ paysage : la partition se réaffiche correctement dans la nouvelle
  orientation sans rechargement manuel.

---

## Étape 5 — Persistance et bibliothèque de fichiers

**Objectif** : mémoriser les fichiers ouverts et la position de lecture.

### Tâches

1. Implémenter un module `storage.coffee` utilisant IndexedDB (via l'API native ou la
   micro-librairie `idb` encodée inline) :
   - Store `files` : `{ id, name, xml, addedAt }` — les fichiers MusicXML complets.
   - Store `positions` : `{ fileId, page, savedAt }` — dernière page lue par fichier.

2. À l'ouverture d'un fichier via l'input, le sauvegarder dans IndexedDB.

3. Au démarrage de l'app, charger la liste des fichiers depuis IndexedDB et afficher
   une bibliothèque simple (liste de noms cliquables).

4. À chaque changement de page, sauvegarder la position (debounce 1 s).

5. À l'ouverture d'un fichier déjà connu, reprendre à la dernière page mémorisée.

6. Permettre la suppression d'un fichier de la bibliothèque (swipe ou bouton).

### Critères de validation
- Fermer et rouvrir l'app : la bibliothèque est intacte, la lecture reprend à la bonne
  page.

---

## Étape 6 — PWA : manifest et Service Worker

**Objectif** : permettre l'installation de l'app sur Android et le fonctionnement
offline complet.

### Tâches

1. `pwa/manifest.json` :
   ```json
   {
     "name": "Liseuse MusicXML",
     "short_name": "Partitions",
     "start_url": "./index.html",
     "display": "standalone",
     "background_color": "#ffffff",
     "theme_color": "#ffffff",
     "orientation": "any",
     "icons": [
       { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
       { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
     ]
   }
   ```

2. `pwa/sw.js` — Service Worker minimal (ou généré par Workbox CLI) :
   - Précache de `index.html` et des icônes à l'installation.
   - Stratégie cache-first pour tous les assets statiques.
   - Pas de cache réseau pour les fichiers MusicXML (gérés par IndexedDB).

 3. Dans le template (index.pug), enregistrer le Service Worker conditionnellement :
    ```javascript
    if ('serviceWorker' in navigator) {
      const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      const isSecure = location.protocol === 'https:' || isLocalhost;
      
      if (isSecure) {
        navigator.serviceWorker.register('./sw.js');
      }
    }
    ```
    Le SW est enregistré en HTTPS ou en local (localhost/127.0.0.1) mais pas en
    mode `file://` ni sur HTTP non-local (pour des raisons de sécurité du navigateur).

4. Générer deux icônes PNG (192×192 et 512×512) représentant une portée musicale
   simple — un script Node ou un SVG converti suffit.

### Critères de validation
- Chrome Android affiche le bandeau "Ajouter à l'écran d'accueil".
- Une fois installée, l'app se lance en mode standalone.
- Après installation, couper le réseau : l'app reste fonctionnelle.

---

## Étape 7 — Réglages utilisateur

**Objectif** : exposer les paramètres de lecture utiles sur liseuse.

### Tâches

1. Panneau de réglages accessible via un bouton discret (icône engrenage), superposé
   en overlay sans quitter la partition.

2. Paramètres à exposer :
   - **Zoom** (`scale` Verovio, de 30 à 80, pas de 5) — modifie `tk.setOptions` et
     relance le rendu de la page courante + invalidation du cache.
   - **Thème** : blanc / sépia / noir — appliqué via une classe CSS sur `<body>`, avec
     filtre CSS `invert(1)` ou `sepia(0.3)` sur `#score-container`.
   - **Taille de la zone de tap** : petite (20%) / normale (30%) / grande (40%).

3. Sauvegarder les réglages dans `localStorage` (synchrone, suffisant pour des
   préférences légères).

4. Appliquer les réglages sauvegardés au démarrage avant le premier rendu.

### Critères de validation
- Le zoom modifie visiblement la taille des notes sans rechargement de page.
- Le thème sépia est agréable à l'œil sur l'écran d'une liseuse.

---

## Étape 8 — Tests et optimisations finales

**Objectif** : valider la tenue en charge sur de gros fichiers et polir l'expérience.

### Tâches

1. Tester avec des fichiers de référence :
   - Petite pièce (< 50 mesures, 1 voix).
   - Pièce moyenne (100–200 mesures, 2 voix).
   - Gros fichier (400+ mesures, quatuor à cordes — 4 portées).

2. Mesurer et optimiser :
   - Temps de chargement initial (parsing + rendu page 1) : cible < 2 s sur CPU mobile
     moyen.
   - Consommation mémoire : le cache mémoire SVG doit être borné (garder au maximum
     les 5 pages autour de la page courante, purger les autres).

3. Mettre en place un indicateur de chargement visible uniquement si le rendu de la
   page suivante n'est pas encore prêt au moment du tap (cas de fichier très lourd).

4. Vérifier l'absence d'erreurs en mode `file://` (pas de SW, pas d'IndexedDB cross-origin).

5. Vérifier l'absence de fuites mémoire sur une session longue (100 changements de page).

---

## Livrables finaux

```
dist/
  index.html       ← fichier autonome, tout inline (WASM, JS, CSS)
  manifest.json    ← PWA manifest
  sw.js            ← Service Worker
  icons/
    icon-192.png
    icon-512.png
```

L'`index.html` seul suffit pour une utilisation locale.
Les cinq fichiers ensemble constituent une PWA installable sur serveur HTTPS.
