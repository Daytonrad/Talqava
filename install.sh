#!/bin/sh
# Talqava: one-line install for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/Talqava/Talqava/main/install.sh | sh
#
# Puts the app in ~/.talqava, adds a `talqava` command, and opens the app in
# your browser. Running it again updates the app. Your data (chats, memory,
# bots, quests) lives in ~/.talqava/data and is never touched by an update.
#
# Settings: TALQAVA_HOME (where it goes), TALQAVA_BIN (where the command goes),
# TALQAVA_REPO (where to get it), TALQAVA_NO_START=1 (install without starting).
set -eu

REPO="${TALQAVA_REPO:-https://github.com/Talqava/Talqava.git}"
HOME_DIR="${TALQAVA_HOME:-$HOME/.talqava}"
APP="$HOME_DIR/app"
BIN="${TALQAVA_BIN:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
need() {
  command -v "$1" >/dev/null 2>&1 || { say "Talqava needs $1. $2"; exit 1; }
}

need git "Install it from https://git-scm.com, then run this again."
need node "Install Node.js 22.18 or newer from https://nodejs.org, then run this again."
need npm "It comes with Node.js: install Node.js 22.18 or newer from https://nodejs.org, then run this again."
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; then
  say "Talqava needs Node.js 22.18 or newer; this computer has $(node -v). Update it from https://nodejs.org, then run this again."
  exit 1
fi

if [ -d "$APP/.git" ]; then
  say "Updating Talqava in $APP…"
  git -C "$APP" pull --ff-only --quiet
else
  say "Installing Talqava in $APP…"
  mkdir -p "$HOME_DIR"
  git clone --quiet --depth 1 "$REPO" "$APP"
fi

say "Installing what it needs (a minute the first time)…"
(cd "$APP" && npm install --omit=dev --omit=optional --no-audit --no-fund --loglevel=error >/dev/null)

mkdir -p "$BIN" "$HOME_DIR/data"
cat > "$BIN/talqava" <<LAUNCHER
#!/bin/sh
# Starts Talqava Agents and opens it in the browser. Stop it with Ctrl C.
export TALQAVA_DATA_DIR="\${TALQAVA_DATA_DIR:-$HOME_DIR/data}"
exec node "$APP/src/local/main.ts" --open "\$@"
LAUNCHER
chmod +x "$BIN/talqava"

say ""
say "Talqava is installed. Start it any time with: talqava"
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say "(Add $BIN to your PATH to use that command, or run $BIN/talqava.)" ;;
esac

if [ "${TALQAVA_NO_START:-}" != "1" ]; then
  say "Starting it now. Stop it with Ctrl C."
  exec "$BIN/talqava"
fi
