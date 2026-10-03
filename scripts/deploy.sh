#!/usr/bin/env bash
# Build on this machine, ship the binary, restart, health-check, roll back on failure.
set -euo pipefail

HOST="${HOST:-personal}"
DIR=/opt/preview
URL="${URL:-https://preview.shenthar.me}"
ZONE="${ZONE:-4fadca1ad0817cd54c92fc78c28b2d16}" # shenthar.me

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
    # The HTML shell is edge-cached for 5 minutes (Cloudflare cache rule on
    # preview.shenthar.me/); purge it so the new build is served right away.
    if command -v cf >/dev/null; then
      (cd /tmp && cf cache purge -z "$ZONE" --body "{\"files\":[\"$URL/\"]}" >/dev/null) \
        && echo "purged $URL/ from Cloudflare" \
        || echo "warning: Cloudflare purge failed; the old page may be served for up to 5 minutes" >&2
    else
      echo "warning: cf CLI not found; the old page may be served for up to 5 minutes" >&2
    fi
    exit 0
  fi
  sleep 1
done

echo "health check failed, rolling back" >&2
ssh "$HOST" "set -e; cd $DIR; [ -f preview.prev ] && mv preview.prev preview && systemctl restart preview"
exit 1
