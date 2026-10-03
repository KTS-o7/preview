#!/usr/bin/env bash
# Build on this machine, ship the binary, restart, health-check, roll back on failure.
set -euo pipefail

HOST="${HOST:-personal}"
DIR=/opt/preview
URL="${URL:-https://preview.shenthar.me}"

cd "$(dirname "$0")/.."
mkdir -p dist
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o dist/preview .
echo "built dist/preview ($(du -h dist/preview | cut -f1))"

scp -q dist/preview "$HOST:$DIR/preview.new"
ssh "$HOST" "set -e
  cd $DIR
  chown deploy:deploy preview.new && chmod 755 preview.new
  [ -f preview ] && cp -p preview preview.prev
  mv preview.new preview
  systemctl restart preview"

for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 5 "$URL/healthz" >/dev/null; then
    echo "healthy after deploy"
    exit 0
  fi
  sleep 1
done

echo "health check failed, rolling back" >&2
ssh "$HOST" "set -e; cd $DIR; [ -f preview.prev ] && mv preview.prev preview && systemctl restart preview"
exit 1
