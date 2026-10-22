#!/bin/bash
# Installe Kotak sur ce Mac, avec mises à jour automatiques depuis GitHub.
#  - l'extension (dossier à charger dans Chrome / Brave) : ~/Extension Kotak
#    (ou le dossier passé en argument — pas sur un disque externe, macOS y bloque les mises à jour)
#  - le moteur Médias : yt-dlp + ffmpeg (open source) + Python portable dans ~/Library/Application Support/Kotak
#  - une tâche de fond (LaunchAgent) qui récupère les nouvelles versions toutes les 15 min
# Rien à installer avant (ni git, ni outils de développement Apple) : curl et tar suffisent.
# Désinstallation : bash ~/Library/Application\ Support/Kotak/uninstall.sh
set -euo pipefail

REPO="${KOTAK_REPO:-adpzt/kotak}"
EXT="${1:-${KOTAK_DIR:-$HOME/Extension Kotak}}"
BASE="$HOME/Library/Application Support/Kotak"
BIN="$BASE/bin"
PY="$BASE/python"
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20241016/cpython-3.12.7+20241016"
LABEL="com.kotak.updater"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# Identifiant fixe de l'extension (clé publique du manifeste) : seul Kotak peut lancer le moteur.
EXT_ID="pgimopnhknnafkfghffffkjckckedngg"

# ---------- Ancienne version « Atelier » ----------
if [ -f "$HOME/Library/LaunchAgents/com.atelier.updater.plist" ]; then
  echo "→ Retrait de l'ancienne version (Atelier)…"
  launchctl bootout "gui/$(id -u)/com.atelier.updater" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.atelier.updater.plist"
  rm -rf "$HOME/Library/Application Support/Atelier" "$HOME/Extension Atelier"
fi

mkdir -p "$BASE" "$BIN" "$HOME/Library/LaunchAgents" "$(dirname "$EXT")"

# ---------- Extension ----------
echo "→ Téléchargement de l'extension dans : $EXT"
STAGE=$(mktemp -d)
curl -fsSL "https://github.com/$REPO/archive/refs/heads/release.tar.gz" | tar -xzf - -C "$STAGE" --strip-components 1
mkdir -p "$EXT"
rsync -a --delete "$STAGE/" "$EXT/"   # retire aussi l'ancien dossier .git des installations faites avec git
rm -rf "$STAGE"

# Python portable réservé à Kotak : celui de macOS exige les outils de développement Apple.
if [ ! -x "$PY/bin/python3" ]; then
  echo "→ Téléchargement de Python (portable, réservé à Kotak)…"
  PYARCH=$([ "$(uname -m)" = "x86_64" ] && echo "x86_64" || echo "aarch64")
  rm -rf "$PY"
  mkdir -p "$PY"
  curl -fsSL "$PY_URL-$PYARCH-apple-darwin-install_only.tar.gz" | tar -xzf - -C "$PY" --strip-components 1
fi

# ---------- Moteur Médias : yt-dlp + ffmpeg ----------
# yt-dlp en version « dossier » : décompressée une seule fois ici (la version « fichier unique »
# se décompresse à chaque lancement, ce que macOS bloque quand c'est le navigateur qui la lance).
install_ytdlp() {
  echo "→ Téléchargement de yt-dlp…"
  local tmp
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/yt-dlp.zip" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos.zip"
  rm -rf "$BIN/yt-dlp-dist"
  mkdir -p "$BIN/yt-dlp-dist"
  unzip -q "$tmp/yt-dlp.zip" -d "$BIN/yt-dlp-dist"
  chmod +x "$BIN/yt-dlp-dist/yt-dlp_macos"
  rm -rf "$tmp"
  cat > "$BIN/yt-dlp" <<'EOW'
#!/bin/bash
exec "$(dirname "$0")/yt-dlp-dist/yt-dlp_macos" "$@"
EOW
  chmod +x "$BIN/yt-dlp"
}
[ -x "$BIN/yt-dlp-dist/yt-dlp_macos" ] || install_ytdlp

ARCH=$(uname -m)
FFARCH=$([ "$ARCH" = "x86_64" ] && echo "x64" || echo "arm64")
FFREL="https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1"
for tool in ffmpeg ffprobe; do
  if [ ! -x "$BIN/$tool" ]; then
    echo "→ Téléchargement de ${tool}…"
    curl -fsSL "$FFREL/$tool-darwin-$FFARCH.gz" | gunzip > "$BIN/$tool"
    chmod +x "$BIN/$tool"
  fi
done

# Lanceur du moteur (le script Python est livré avec l'extension et se met à jour avec elle).
HOST="$BASE/kotak-engine"
cat > "$HOST" <<EOH
#!/bin/bash
exec "$PY/bin/python3" "$EXT/host/kotak_host.py" "\$@"
EOH
chmod +x "$HOST"

# Déclaration auprès des navigateurs (Native Messaging) : uniquement pour l'extension Kotak.
ORIGINS="\"chrome-extension://$EXT_ID/\""
for id in ${KOTAK_EXTRA_IDS:-}; do ORIGINS="$ORIGINS, \"chrome-extension://$id/\""; done
MANIFEST="{
  \"name\": \"com.kotak.engine\",
  \"description\": \"Moteur local Kotak (yt-dlp + ffmpeg)\",
  \"path\": \"$HOST\",
  \"type\": \"stdio\",
  \"allowed_origins\": [$ORIGINS]
}"
for dir in "Google/Chrome" "BraveSoftware/Brave-Browser" "Chromium" "Microsoft Edge" "Vivaldi" "Arc/User Data"; do
  if [ -d "$HOME/Library/Application Support/$dir" ]; then
    mkdir -p "$HOME/Library/Application Support/$dir/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST" > "$HOME/Library/Application Support/$dir/NativeMessagingHosts/com.kotak.engine.json"
  fi
done

# ---------- Mises à jour automatiques ----------
cat > "$BASE/update.sh" <<EOS
#!/bin/bash
# Appelé par launchd toutes les 15 min : nouvelle version de Kotak, et de yt-dlp une fois par jour.
EXT="$EXT"
BIN="$BIN"
version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1; }
REMOTE=\$(curl -fsSL "https://raw.githubusercontent.com/$REPO/release/manifest.json" | version)
LOCAL=\$(version < "\$EXT/manifest.json" 2>/dev/null)
if [ -n "\$REMOTE" ] && [ "\$REMOTE" != "\$LOCAL" ]; then
  TMP=\$(mktemp -d)
  if curl -fsSL "https://github.com/$REPO/archive/refs/heads/release.tar.gz" | tar -xzf - -C "\$TMP" --strip-components 1 \\
     && [ -f "\$TMP/manifest.json" ]; then
    rsync -a --delete "\$TMP/" "\$EXT/"
    echo "\$(date '+%Y-%m-%d %H:%M') Kotak : \$LOCAL → \$REMOTE"
  fi
  rm -rf "\$TMP"
fi
# yt-dlp suit les changements des sites : vérification quotidienne de la dernière version.
STAMP="$BASE/.ytdlp-check"
if [ -z "\$(find "\$STAMP" -mtime -1 2>/dev/null)" ]; then
  touch "\$STAMP"
  LATEST=\$(curl -fsSL https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
  CURRENT=\$("\$BIN/yt-dlp" --version 2>/dev/null)
  if [ -n "\$LATEST" ] && [ "\$LATEST" != "\$CURRENT" ]; then
    TMP=\$(mktemp -d)
    if curl -fsSL -o "\$TMP/y.zip" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos.zip" && unzip -q "\$TMP/y.zip" -d "\$TMP/d"; then
      rm -rf "\$BIN/yt-dlp-dist" && mv "\$TMP/d" "\$BIN/yt-dlp-dist" && chmod +x "\$BIN/yt-dlp-dist/yt-dlp_macos"
      echo "\$(date '+%Y-%m-%d %H:%M') yt-dlp : \$CURRENT → \$LATEST"
    fi
    rm -rf "\$TMP"
  fi
fi
EOS
chmod +x "$BASE/update.sh"

cat > "$PLIST" <<EOP
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$BASE/update.sh</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$BASE/update.log</string>
  <key>StandardErrorPath</key><string>$BASE/update.log</string>
</dict>
</plist>
EOP
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

cat > "$BASE/uninstall.sh" <<EOU
#!/bin/bash
launchctl bootout "gui/\$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
find "\$HOME/Library/Application Support" -maxdepth 4 -name com.kotak.engine.json -path '*NativeMessagingHosts*' -delete 2>/dev/null
rm -rf "$EXT" "$BASE"
echo "Kotak désinstallé. Retire aussi l'extension dans chrome://extensions (ou brave://extensions)."
EOU
chmod +x "$BASE/uninstall.sh"

VERSION=$(grep '"version"' "$EXT/manifest.json" | tr -d ' ",' | cut -d: -f2)
printf '%s' "$EXT" | pbcopy
cat <<EOM

✅ Kotak v$VERSION installé, mises à jour automatiques activées.
   Moteur Médias : yt-dlp $("$BIN/yt-dlp" --version) · ffmpeg $("$BIN/ffmpeg" -hide_banner -version | head -1 | cut -d' ' -f3)

Dernière étape (une seule fois) dans Chrome ou Brave :
  1. Ouvre chrome://extensions (ou brave://extensions) et active le « Mode développeur »
  2. Clique « Charger l'extension non empaquetée »
  3. Choisis ce dossier (⌘⇧G puis colle le chemin, déjà copié dans ton presse-papier) :
     $EXT

Laisse le Mode développeur activé : c'est ce qui permet les mises à jour automatiques.
Forcer une mise à jour : bash "$BASE/update.sh"
Désinstaller : bash "$BASE/uninstall.sh"
EOM
