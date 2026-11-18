# Stratégie "Local First" pour la PWA Liseuse MusicXML

## Vue d'ensemble

Cette PWA implémente une stratégie "Local First" complète pour garantir une expérience hors-ligne optimale tout en maintenant les mises à jour automatiques en arrière-plan.

## Architecture du Cache

### Deux types de caches
- **STATIC_CACHE** (`musica-static-v2`): Assets essentiels qui changent peu
- **DYNAMIC_CACHE** (`musica-dynamic-v2`): Ressources dynamiques et fichiers utilisateur

### Assets statiques pré-cachés
- Page principale (`index.html`)
- Worker Verovio (`worker.js`, `verovio.js`, `verovio-toolkit-wasm.js`)
- Manifest PWA et icônes
- Favicon
- Échantillons audio (`soundfonts/piano-fluidr3-13notes.js`), en optionnel non
  bloquant : sans eux, la lecture se rabat sur l'oscillateur.

### Caches de rendu préservés

Trois caches distincts contiennent les documents de l'utilisateur et ne sont
jamais supprimés lors d'une mise à jour du service worker :

- `musica-svg-cache-v1` — pages SVG compressées (largeur, hauteur, variante de
  voix) ;
- `musica-playback-cache-v1` — MIDI + `syncMarks` compressés, clé fichier,
  mouvement, largeur, hauteur, échelle et variante de voix ;
- `musica-structure-cache-v1` — ancien cache de structure, conservé pour
  compatibilité.

Le bouton « Vider le cache » des réglages purge les caches SVG et de lecture,
sans toucher aux fichiers importés (IndexedDB).

## Stratégies de mise en cache

### 1. Cache First avec mise à jour en arrière-plan
**Pour**: Assets statiques (JS, CSS, images, Verovio)

```javascript
// 1. Servir immédiatement depuis le cache
// 2. Mettre à jour en arrière-plan si disponible
// 3. Notifier l'utilisateur des mises à jour importantes
```

**Avantages**:
- Démarrage instantané
- Fonctionnement hors-ligne garanti
- Mises à jour transparentes

### 2. Network First
**Pour**: Navigations principales (`index.html`)

```javascript
// 1. Essayer le réseau en premier
// 2. Utiliser le cache en cas d'échec
// 3. Mettre en cache les réponses réussies
```

**Avantages**:
- Toujours la dernière version de l'interface
- Fallback sur le cache si hors-ligne

### 3. Stale While Revalidate
**Pour**: Ressources dynamiques et fichiers externes

```javascript
// 1. Servir depuis le cache immédiatement
// 2. Mettre à jour en parallèle
// 3. Les prochaines requêtes bénéficient de la mise à jour
```

**Avantages**:
- Performance optimale
- Données toujours fraîches après la première visite

## Cycle de vie du Service Worker

### Installation
1. Télécharge et cache tous les assets statiques
2. Passe immédiatement à l'étape d'activation (`skipWaiting()`)

### Activation
1. Nettoie les anciens caches
2. Prend le contrôle de toutes les pages ouvertes (`clients.claim()`)

### Mises à jour
1. Détection automatique des nouvelles versions
2. Notification utilisateur avec option de mise à jour immédiate
3. Rechargement transparent de l'application

## Interface utilisateur

### Notifications de mise à jour
- **Notification complète**: Nouvelle version disponible avec boutons d'action
- **Message simple**: Mises à jour de cache en arrière-plan

### Comportement utilisateur
- **Mettre à jour**: Recharge immédiat avec nouvelle version
- **Plus tard**: Continue avec version actuelle, notification réapparaîtra plus tard
- **Auto-dismiss**: Notifications disparaissent après timeout

## Gestion des erreurs

### Échecs réseau
- Fallback systématique sur le cache
- Messages d'erreur dans la console
- Interface utilisateur reste fonctionnelle

### Corruptions de cache
- Nettoyage automatique lors des activations
- Reconstruction progressive des caches
- Pas d'interruption de service

## Performance

### Métriques cibles
- **First Contentful Paint**: < 1s (cache)
- **Time to Interactive**: < 2s (cache)
- **Cache hit rate**: > 90% pour assets statiques

### Optimisations
- Compression des réponses en cache
- Mise en cache agressive des ressources Verovio
- Préchargement des pages suivantes

## Sécurité

### Restrictions
- Cache uniquement pour les ressources same-origin
- Validation des réponses avant mise en cache
- Nettoyage automatique des données sensibles

### Bonnes pratiques
- HTTPS obligatoire pour le service worker
- Scope limité au domaine de l'application
- Pas de stockage de données personnelles sans consentement

## Développement et Debug

### Logs du Service Worker
- Installation et activation
- Stratégies de cache utilisées
- Mises à jour en arrière-plan
- Erreurs réseau et cache

### Outils de développement
- Chrome DevTools > Application > Service Workers
- Cache Storage inspection
- Network throttling pour tests hors-ligne

## Maintenance

### Versioning
- Numérotation des caches (v1, v2, etc.)
- Migration automatique lors des mises à jour
- Compatibilité descendante préservée

### Monitoring
- Taux de hits de cache
- Performance hors-ligne
- Fréquence des mises à jour

## Partage depuis Android

Le manifeste déclare un `share_target` POST `multipart/form-data` vers
`./share`, avec une seule entrée `files` (Android ne partage qu'un fichier à
la fois). Le service worker intercepte ce POST avant les stratégies de cache,
lit `formData()`, écrit les sources brutes dans le magasin IndexedDB `files`
(même structure que `src/storage.coffee`), puis répond par une redirection
`303` vers `./?shared=<jeton>`. L'application consomme le jeton au démarrage
avec son pipeline d'import habituel, puis retire le paramètre de l'URL
(`history.replaceState`) : un rechargement ne réimporte donc pas.

Les fichiers sont acceptés quelle que soit leur extension ; l'application
applique ensuite `isCompatibleFile` et signale proprement un refus. Les
formats `.mscz`/`.mscx` n'ont pas de type MIME standard : selon le fournisseur
Android, ils arrivent en `application/octet-stream`, `application/zip` ou
`application/x-musescore`, d'où leur présence dans `accept`. LilyPond
(`.ly`, `.lilypond`) et ABC (`.abc`) arrivent en `text/x-lilypond`,
`text/vnd.abc` ou `text/plain` selon la source du partage.

## Cas d'usage spécifiques

### Musicien en tournée
- Téléchargement initial avant le départ
- Accès instantané à toutes les partitions
- Mises à jour lors des connexions occasionnelles

### École de musique
- Installation sur les tablettes des élèves
- Synchronisation des nouvelles partitions
- Fonctionnement garanti en salle sans internet

### Usage personnel
- Rapidité d'accès aux partitions favorites
- Sauvegarde automatique des annotations
- Disponibilité même pendant les pannes réseau
