#!/bin/bash
set -euo pipefail

URL="https://www.theoutnet.com/en-us/shop/"
OUT="${2:-page.zip}"

single-file \
  --browser-executable-path /usr/bin/google-chrome \
  --browser-headless true \
  --browser-arg "--no-sandbox" \
  --browser-arg "--disable-dev-shm-usage" \
  --browser-arg "--headless=new" \
  --browser-arg "--disable-gpu" \
  --browser-arg "--user-data-dir=/tmp/chrome-singlefile" \
  --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" \
  --block-scripts false \
  --browser-wait-until networkIdle \
  --browser-wait-delay 3000 \
  --compress-content true \
  --self-extracting-archive false \
  --errors-file /tmp/sf-errors.json \
  --debug-messages-file /tmp/sf-debug.json \
  "$URL" "$OUT"

echo "Saved: $OUT"
unzip -l "$OUT" | head
