#!/usr/bin/env bash
# Ships the last commit to a Linux server and (re)starts it with Docker Compose.
# The server needs Docker + Compose; your alerts (./data) and server .env survive redeploys.
# Usage: scripts/deploy.sh user@host [remote-dir]      (default dir: /opt/abholbereit)
set -euo pipefail

TARGET="${1:?usage: scripts/deploy.sh user@host [remote-dir]}"
DIR="${2:-/opt/abholbereit}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "note: uncommitted changes are not deployed (shipping $(git rev-parse --short HEAD))" >&2
fi

echo "→ copying $(git rev-parse --short HEAD) to $TARGET:$DIR"
git archive --format=tar HEAD | ssh "$TARGET" "mkdir -p '$DIR' && tar -x -C '$DIR'"

ssh "$TARGET" "DIR='$DIR' bash -s" <<'REMOTE'
set -euo pipefail
cd "$DIR"
mkdir -p data
chown -R 10001:10001 data   # the container runs as uid 10001 (see docker-compose.yml), which no host user has
chmod 700 data
if [ ! -f .env ]; then
  cat > .env <<'ENV'
# Server settings for Abholbereit (all options: .env.example). Apply with: docker compose up -d
# NTFY_TOPIC=
# ALLOWED_HOSTS=stock.example.com
# DASHBOARD_USER=
# DASHBOARD_PASSWORD=
ENV
  chmod 600 .env
fi
echo "→ building and starting"
docker compose up -d --build --remove-orphans
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4321/healthz >/dev/null 2>&1; then
    echo "→ running: $(docker compose ps --format '{{.Name}} {{.Status}}')"
    docker compose logs --tail 3 | cut -c1-200
    exit 0
  fi
  sleep 1
done
echo "the container did not become healthy; last logs:" >&2
docker compose logs --tail 30 >&2
exit 1
REMOTE
