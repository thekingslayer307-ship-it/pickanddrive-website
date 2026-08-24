#!/usr/bin/env bash
# Publishes the Android test build to https://pickanddrive.pk/download/
#
# The APK is ~101 MB, so it is copied on its own rather than bundled into the
# usual tar-over-ssh site deploy. Re-run this after every new build.
set -euo pipefail

HOST="${PD_HOST:-root@169.58.154.174}"
ROOT="/var/www/pickanddrive-website"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -f "$HERE/download/pickanddrive.apk" ] || { echo "download/pickanddrive.apk is missing"; exit 1; }

echo "==> creating $ROOT/download"
ssh "$HOST" "mkdir -p $ROOT/download"

echo "==> uploading page"
scp "$HERE/download/index.html" "$HOST:$ROOT/download/index.html"

echo "==> uploading APK (~101 MB)"
scp "$HERE/download/pickanddrive.apk" "$HOST:$ROOT/download/pickanddrive.apk"

echo "==> fixing ownership"
ssh "$HOST" "chown -R www-data:www-data $ROOT/download && chmod 644 $ROOT/download/*"

echo "==> verifying"
curl -sI https://pickanddrive.pk/download/ | head -1
curl -sI https://pickanddrive.pk/download/pickanddrive.apk | grep -i -E '^(HTTP|content-length|content-type)'

echo "==> done: https://pickanddrive.pk/download/"
