#!/usr/bin/env bash
# Manages the per-user LaunchAgent that keeps the stock checker running on this Mac.
# Usage: scripts/service.sh install|uninstall|restart|logs|status
set -euo pipefail

LABEL="local.apple-stock-ch"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/apple-stock-ch.log"
DOMAIN="gui/$(id -u)"

install() {
  cd "$PROJECT_DIR"
  npm run build
  local node
  node="$(node -p 'process.execPath')"
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <!-- caffeinate -s: keep the Mac awake while on AC power; on battery it sleeps normally -->
    <string>/usr/bin/caffeinate</string>
    <string>-s</string>
    <string>$node</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>$PROJECT_DIR/dist/main.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "Installed $LABEL (node: $node)"
  echo "Dashboard: http://127.0.0.1:${PORT:-4321}  ·  Logs: $LOG"
}

uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
}

case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  restart) launchctl kickstart -k "$DOMAIN/$LABEL" && echo "Restarted $LABEL" ;;
  logs) tail -n 100 -f "$LOG" ;;
  status) launchctl print "$DOMAIN/$LABEL" | head -20 ;;
  *)
    echo "usage: $0 install|uninstall|restart|logs|status" >&2
    exit 1
    ;;
esac
