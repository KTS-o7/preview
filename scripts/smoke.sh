#!/usr/bin/env bash
# Post-deploy checks through nginx + Cloudflare: health, CSP, xlsx upload, md2pdf.
set -euo pipefail

URL="${URL:-https://preview.shenthar.me}"
FIXTURE="$(dirname "$0")/../testdata/smoke.xlsx"
failed=0

# expect NAME ACTUAL WANT
expect() {
  if [ "$2" = "$3" ]; then
    printf '%-16s ok\n' "$1"
  else
    printf '%-16s FAIL (got %q, want %q)\n' "$1" "$2" "$3"
    failed=1
  fi
}

expect healthz "$(curl -fsS "$URL/healthz" || true)" ok
expect csp "$(curl -fsSI "$URL/" | grep -ci '^content-security-policy:' || true)" 1

id=$(curl -fsS -F "file=@$FIXTURE" "$URL/api/xlsx/upload" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' || true)
expect xlsx-upload "$([ -n "$id" ] && echo yes || echo no)" yes
expect xlsx-download "$(curl -sS -o /dev/null -w '%{http_code}' "$URL/api/xlsx/$id/download" || true)" 200

expect md2pdf "$(curl -fsS --data-binary $'# Smoke\n\nhello' -H 'Content-Type: text/markdown' "$URL/api/md2pdf" | head -c 4 || true)" "%PDF"

exit "$failed"
