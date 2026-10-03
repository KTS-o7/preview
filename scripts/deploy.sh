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
    # cf exits 0 even when it aborts, so check the served page for the new build.
    build=$(ssh "$HOST" "curl -fsS http://127.0.0.1:8092/" | sed -n 's|.*src="/v/\([^/]*\)/app.js".*|\1|p')
    if command -v cf >/dev/null; then
      (cd /tmp && cf cache purge --force -z "$ZONE" --body "{\"files\":[\"$URL/\"]}" >/dev/null 2>&1)
    fi
    if curl -fsS "$URL/" | grep -q "/v/$build/app.js"; then
      echo "serving build $build"
    else
      echo "warning: Cloudflare still serves an older page (purge failed?); it expires within 5 minutes" >&2
    fi
    # Every deploy changes all /v/<build>/ URLs. Fetch each file once so the
    # nearest Cloudflare edge has them before the first real visit.
    (cd static && find . -type f ! -name VERSIONS | sed 's|^\./||') |
      xargs -P 8 -I{} curl -fsS -o /dev/null -H 'Accept-Encoding: gzip' "$URL/v/$build/{}" &&
      echo "warmed Cloudflare edge for build $build"
    exit 0
  fi
  sleep 1
done

echo "health check failed, rolling back" >&2
ssh "$HOST" "set -e; cd $DIR; [ -f preview.prev ] && mv preview.prev preview && systemctl restart preview"
exit 1
