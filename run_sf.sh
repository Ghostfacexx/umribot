#!/bin/bash
set -e
OUT="$1"
shift
rm -f "$OUT"
export SF_LOG_DIR=/tmp/sf-logs
mkdir -p "$SF_LOG_DIR"
ts=$(date +%s)
single-file "$@" "$OUT" \
  --browser-executable-path /usr/bin/google-chrome \
  --browser-headless true \
  --browser-arg "--headless=new" \
  --browser-arg "--no-sandbox" \
  --browser-arg "--disable-dev-shm-usage" \
  --browser-arg "--disable-gpu" \
  --browser-arg "--user-data-dir=/tmp/chrome-singlefile" \
  --self-extracting-archive false \
  --block-scripts false 2> "$SF_LOG_DIR/err-$ts.log" || echo "SingleFile exit code: $?"
ls -l "$OUT" || echo "No output produced."
echo "Err log: $SF_LOG_DIR/err-$ts.log"
tail -n 40 "$SF_LOG_DIR/err-$ts.log"
