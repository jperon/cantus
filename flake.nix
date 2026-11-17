{
  description = "Cantus — liseuse MusicXML PWA (site, tests Playwright, APK TWA)";

  # NixOS 26.05 : même canal que la machine de développement, binaires en cache,
  # Node 24 / Chromium / JDK 17 / androidenv disponibles. Pas de flake-utils :
  # deux systèmes suffisent et une fonction locale évite une dépendance.
  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);

      # Android : composeAndroidPackages exige les paquets SDK marqués unfree
      # (cmdline-tools) ; on accepte explicitement la licence au niveau du SDK.
      mkPkgs =
        system:
        import nixpkgs {
          inherit system;
          config = {
            allowUnfree = true;
            android_sdk.accept_license = true;
          };
        };

      androidFor =
        pkgs:
        let
          composition = pkgs.androidenv.composeAndroidPackages {
            # compileSdk 36 / targetSdk 35 lus dans apk/app/build.gradle.
            platformVersions = [ "36" ];
            # Version par défaut d'AGP 8.9.1.
            buildToolsVersions = [ "35.0.0" ];
            includeEmulator = false;
            includeSystemImages = false;
            useGoogleAPIs = false;
            includeNDK = false;
          };
        in
        {
          sdk = composition.androidsdk;
          # Chemin conventionnel du SDK composé par androidenv.
          home = "${composition.androidsdk}/libexec/android-sdk";
        };

      # Script de construction du site. Ce n'est PAS une dérivation hermétique :
      # build.js lit ../partitura/verovio-toolkit-wasm.js et
      # ../musescore/result-wasm/classic, et écrit dans dist/ du dépôt courant.
      # On expose donc honnêtement un script, pas un artefact figé.
      siteBuild =
        pkgs:
        pkgs.writeShellApplication {
          name = "cantus-site-build";
          runtimeInputs = [ pkgs.nodejs_24 ];
          text = ''
            if [ ! -f build.js ] || [ ! -f package.json ]; then
              echo "cantus : lancer depuis la racine du dépôt (build.js introuvable)" >&2
              exit 1
            fi
            export MSCZ2XML_PKG="''${MSCZ2XML_PKG:-$PWD/../musescore/result-wasm}"
            exec node build.js "$@"
          '';
        };

      # Application qui ré-entre dans le devShell : garantit Chromium, JDK,
      # SDK Android et les variables du shellHook sans dupliquer la config.
      mkApp = pkgs: name: description: command: {
        type = "app";
        meta.description = description;
        program = "${
          pkgs.writeShellApplication {
            inherit name;
            runtimeInputs = [ pkgs.nix ];
            text = ''
              if [ ! -f flake.nix ] || [ ! -f package.json ]; then
                echo "cantus : lancer depuis la racine du dépôt" >&2
                exit 1
              fi
              exec nix develop --command ${command} "$@"
            '';
          }
        }/bin/${name}";
      };
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = mkPkgs system;
          android = androidFor pkgs;
          gradle = pkgs.gradle_8;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24 # fournit npm et npx
              # Navigateur utilisé par Playwright (tests/lib.js lit CHROMIUM).
              pkgs.chromium
              # APK : AGP 8.9.1 demande JDK 17, wrapper Gradle 8.11.1.
              pkgs.jdk17
              gradle
              pkgs.android-tools
              android.sdk
              pkgs.git
              pkgs.gnumake
              pkgs.python3
              pkgs.pkg-config
              pkgs.which
            ];

            shellHook = ''
              # Chromium de nixpkgs : reproductible et hors ligne (pas de
              # téléchargement des navigateurs Playwright).
              export CHROMIUM="${pkgs.chromium}/bin/chromium"
              export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$CHROMIUM"

              export JAVA_HOME="${pkgs.jdk17}"
              export ANDROID_HOME="${android.home}"
              export ANDROID_SDK_ROOT="$ANDROID_HOME"
              # androidenv est en lecture seule : Gradle et l'émulateur doivent
              # écrire ailleurs, dans le cache utilisateur.
              export GRADLE_USER_HOME="''${XDG_CACHE_HOME:-$HOME/.cache}/cantus/gradle"
              export ANDROID_USER_HOME="''${XDG_CACHE_HOME:-$HOME/.cache}/cantus/android"
              mkdir -p "$GRADLE_USER_HOME" "$ANDROID_USER_HOME"

              # Outils du SDK absents du PATH par défaut (zipalign, apksigner).
              if [ -d "$ANDROID_HOME/build-tools" ]; then
                export PATH="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -n1):$PATH"
              fi
              export PATH="$ANDROID_HOME/platform-tools:$PATH"

              # Paquet mscz2xml attendu par build.js (import MuseScore).
              export MSCZ2XML_PKG="''${MSCZ2XML_PKG:-$PWD/../musescore/result-wasm}"

              echo "Cantus : node $(node --version), java $(java -version 2>&1 | head -n1), gradle $(gradle --version 2>/dev/null | awk '/^Gradle/{print $2}')"
              echo "  build   : nix run .#build  (ou node build.js)"
              echo "  tests   : nix run .#test   (tests/run.sh, Chromium fourni)"
              echo "  apk     : nix run .#apk    (nécessite apk/ et le keystore local)"
            '';
          };
        }
      );

      packages = forAllSystems (
        system:
        let
          pkgs = mkPkgs system;
          site = siteBuild pkgs;
        in
        {
          # Alias explicite : script de build, pas un site figé (voir flake.nix).
          default = site;
          site = site;
        }
      );

      apps = forAllSystems (
        system:
        let
          pkgs = mkPkgs system;
        in
        {
          build = mkApp pkgs "build" "Construit le site dans dist/ (build.js)" "node build.js";
          build-spa =
            mkApp pkgs "build-spa" "Construit le SPA autonome dans dist/spa.html"
              "node build.js --spa";
          test =
            mkApp pkgs "test" "Lance les tests unitaires et Playwright (Chromium fourni)"
              "bash tests/run.sh";
          serve = mkApp pkgs "serve" "Sert dist/ en HTTPS via http-server" "npm run serve";
          apk = mkApp pkgs "apk" "Construit et signe l'APK TWA dans apk/" "bash scripts/build-apk.sh";
        }
      );

      formatter = forAllSystems (system: (mkPkgs system).nixfmt);

      checks = forAllSystems (
        system:
        let
          pkgs = mkPkgs system;
        in
        {
          # Uniquement des vérifications hors ligne.
          formatting =
            pkgs.runCommand "cantus-check-formatting"
              {
                nativeBuildInputs = [ pkgs.nixfmt ];
              }
              ''
                nixfmt --check ${./flake.nix}
                touch $out
              '';
          shellcheck =
            pkgs.runCommand "cantus-check-shellcheck"
              {
                nativeBuildInputs = [ pkgs.shellcheck ];
              }
              ''
                shellcheck ${./scripts/build-apk.sh}
                touch $out
              '';
        }
      );
    };
}
