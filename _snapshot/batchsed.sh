#!/bin/bash
set -euo pipefail

: "${URLS_FILE:=/root/SingleFile/single-file-cli/seeds.txt}"
OUTPUT_ROOT="/var/www/outnet-archive"
LOG="/tmp/sf-batch-fixed.log"
ERR="/tmp/sf-batch-fixed.err"

: >"$LOG"; : >"$ERR"
mkdir -p "$OUTPUT_ROOT"

i=0
total=$(grep -cve '^[[:space:]]*$' "$URLS_FILE" || echo 0)
echo "Total URLs: $total"

while IFS= read -r url; do
  url="${url//$'\r'/}"
  [[ -z "$url" ]] && continue
  [[ ! "$url" =~ theoutnet\.com ]] && continue
  ((i++))
  echo "[$i/$total] $url" | tee -a "$LOG"

  rel="${url#https://www.theoutnet.com/}"
  rel="${rel%%\?*}"
  rel="${rel%/}"
  [[ -z "$rel" ]] && rel="index"
  folder=$(dirname "$rel"); file=$(basename "$rel"); [[ "$folder" == "." ]] && folder=""
  outdir="$OUTPUT_ROOT/$folder"
  zippath="$outdir/${file}.zip"
  extracted="$outdir/${file}"
  mkdir -p "$outdir"

  if single-file \
      --extract-data-from-page false \
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
      "$url" "$zippath" >>"$LOG" 2>>"$ERR"; then
        if [[ -f "$zippath" ]]; then
          rm -rf "$extracted"
            mkdir -p "$extracted"
            if unzip -q "$zippath" -d "$extracted" 2>>"$ERR"; then
              rm -f "$zippath"
              echo "  OK -> $extracted/index.html" | tee -a "$LOG"
            else
              echo "  UNZIP FAIL" | tee -a "$LOG"
            fi
        else
          echo "  NO ZIP" | tee -a "$LOG"
        fi
  else
    echo "  FAIL (single-file exit)" | tee -a "$LOG"
  fi
  sleep 2
done < "$URLS_FILE"

echo "Done. See $LOG / $ERR"
