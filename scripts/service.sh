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
  unload
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "Installed $LABEL (node: $node)"

  local port="${PORT:-$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2)}"
  port="${port:-4321}"
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:$port/api/status" >/dev/null 2>&1; then
      echo "Running. Dashboard: http://127.0.0.1:$port  ·  Logs: $LOG"
      return 0
    fi
    sleep 1
  done
  echo "The service did not answer on port $port. Last log lines:" >&2
  tail -n 20 "$LOG" >&2 || true
  exit 1
}

# Stops the job and waits until launchd has really let go of it (bootstrap fails otherwise).
unload() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 10); do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
}

uninstall() {
  unload
  rm -f "$PLIST"
  echo "Removed $LABEL"
}

case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  restart) launchctl kickstart -k "$DOMAIN/$LABEL" && echo "Restarted $LABEL" ;;
  logs) tail -n 100 -f "$LOG" ;;
  status) (launchctl print "$DOMAIN/$LABEL" || true) | head -20 ;;
  *)
    echo "usage: $0 install|uninstall|restart|logs|status" >&2
    exit 1
    ;;
esac
