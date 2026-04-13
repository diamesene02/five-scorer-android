# Five Scorer — Android APK

App Android (sideload, pas Play Store) pour saisir les scores et buteurs
des matchs de Five hebdo. Marche **100 % offline** pendant un match,
synchronise vers Supabase quand le WiFi est dispo.

## Stack
- WebView (Capacitor 7) + HTML/CSS/JS vanilla
- Dexie (IndexedDB) pour le stockage local + outbox
- @supabase/supabase-js pour la sync
- esbuild pour bundler `www/src/*` → `www/app.bundle.js`

## Build local (Mac)

Prérequis : Node 22, JDK 21, Android Studio (ou juste cmdline-tools + SDK 35).

```bash
cd mobile
npm install
npm run build:apk
# → android/app/build/outputs/apk/debug/app-debug.apk
```

## Build via GitHub Actions

Le workflow `.github/workflows/build-apk.yml` (à la racine du repo) build
l'APK à chaque push sur `main` et l'attache automatiquement comme asset
de release. URL : `https://github.com/diamesene02/diamesene02/releases`.

## Layout

```
mobile/
├── package.json
├── capacitor.config.json
├── scripts/customize-android.mjs   # patch manifest + icons après cap sync
└── www/
    ├── index.html
    ├── app.css
    ├── icons/                       # icônes PWA + source SVG
    └── src/
        ├── entry.js                 # point d'entrée (importé par esbuild)
        ├── config.js                # Supabase URL + ANON KEY + PIN
        ├── db.js                    # Dexie schema + actions locales
        ├── sync.js                  # outbox drain vers Supabase REST
        └── ui.js                    # logique UI (state machine)
```

## Sync DB (Supabase)

- Project ID : `zdymczdhchjfjijyhfiy`
- Tables : `Player`, `Match`, `MatchPlayer`, `Goal` (créées via Prisma migration)
- 14 joueurs déjà seedés : Christophe, Halim, Philippe, Thierry, Olivier,
  Marc, Hicham, Diame, Erkan, Oussama, Petit Nico, Antoine, Nicolas, Benjamin
- RLS : OFF (anon role a tous les droits — single-user perso)

## Sécurité

La anon key est embarquée dans l'APK (config.js). Si on distribue plus
largement un jour : activer RLS + policy "PIN-based" via header custom.
