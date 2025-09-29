#!/bin/bash
#
# Robust SingleFile archiver
# - Pure ZIP output (no self-extracting HTML) -> extracted to folder/index.html
# - Root-safe Chrome launch (no-sandbox, disable-dev-shm-usage)
# - Proxy rotation, cookies, link rewriting
# - Honors external URLS_FILE env override or --one URL argument
# - Strong post-run validation and diagnostics
#
# Usage examples:
#   ./sed.sh --debug
#   URLS_FILE=/tmp/one.txt ./sed.sh --debug
#   ./sed.sh --one "https://www.theoutnet.com/en-us/shop/clothing/dresses" --debug
#
# Toggle to store zipped HTML instead of ZIP+extract (future):
#   Set OUTPUT_FORMAT=html (not default). Currently unused (always ZIP).
#

########################################
# CONFIG (default values – env can override URLS_FILE)
########################################
: "${URLS_FILE:=/root/SingleFile/single-file-cli/seeds.txt}"
OUTPUT_ROOT="/var/www/outnet-archive"
COOKIES_FILE="/root/SingleFile/SingleFile/cookies.txt"
PROXY_FILE="/root/SingleFile/SingleFile/proxies.json"

ERROR_LOG="/tmp/singlefile-errors.log"
RUN_LOG="/tmp/singlefile-run.log"
VERIFY_LOG="/tmp/singlefile-verify.log"

REQUEST_DELAY=2
WRITE_LINK_TRAILING_SLASH=1
OUTPUT_FORMAT="zip"   # (future: html | zip) zip = pure ZIP then extract
DEBUG=0
ONE_URL=""

########################################
# ARG PARSE
########################################
while (( $# )); do
  case "$1" in
    --debug) DEBUG=1 ;;
    --one)
      shift
      ONE_URL="$1"
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

########################################
# LOGGING HELPERS
########################################
log() { echo -e "$*" | tee -a "$RUN_LOG"; }
dbg() { (( DEBUG )) && echo "[DEBUG] $*" | tee -a "$RUN_LOG"; }
err() { echo "[ERROR] $*" | tee -a "$RUN_LOG" >>"$ERROR_LOG"; }

########################################
# SAFE EXIT ON SIGNAL
########################################
trap 'log "[INTERRUPT] Stopping..."; verify_archive; exit 130' INT TERM

########################################
# PREP
########################################
: > "$RUN_LOG"
: > "$ERROR_LOG"
mkdir -p "$OUTPUT_ROOT"

if [[ -n "$ONE_URL" ]]; then
  tmp_one=$(mktemp)
  printf "%s\n" "$ONE_URL" > "$tmp_one"
  URLS_FILE="$tmp_one"
  log "[ONE] Single URL mode: $ONE_URL"
fi

if [[ ! -f "$URLS_FILE" ]]; then
  err "Seeds file missing: $URLS_FILE"
  exit 1
fi
if [[ ! -x ./single-file ]]; then
  err "single-file CLI (./single-file) not found or not executable"
  exit 1
fi

########################################
# PROXY SUPPORT
########################################
if [[ -f "$PROXY_FILE" ]]; then
  PROXY_COUNT=$(jq 'length' "$PROXY_FILE" 2>/dev/null || echo 0)
else
  PROXY_COUNT=0
fi
dbg "Proxy count: $PROXY_COUNT"

get_proxy_opts() {
  local idx="$1"
  if (( PROXY_COUNT == 0 )); then
    echo ""
    return 0
  fi
  local server user pass
  server=$(jq -r ".[$idx].server" "$PROXY_FILE" 2>/dev/null)
  user=$(jq -r ".[$idx].username" "$PROXY_FILE" 2>/dev/null)
  pass=$(jq -r ".[$idx].password" "$PROXY_FILE" 2>/dev/null)
  if [[ -n "$server" && "$server" != "null" ]]; then
    echo "--http-proxy-server \"$server\" --http-proxy-username \"$user\" --http-proxy-password \"$pass\""
  else
    echo ""
  fi
}

########################################
# BUILD PATH LIST FOR LINK REWRITE
########################################
build_path_regex() {
  PATHS=()
  while IFS= read -r seed; do
    seed="${seed//$'\r'/}"
    [[ -z "$seed" ]] && continue
    [[ ! "$seed" =~ https?://(www\.)?theoutnet\.com/ ]] && continue
    local p="${seed#https://www.theoutnet.com/}"
    p="${p#http://www.theoutnet.com/}"
    p="${p%%\?*}"
    p="${p%%#*}"
    p="${p%/}"
    [[ -z "$p" ]] && continue
    PATHS+=("$p")
  done < "$URLS_FILE"

  IFS=$'\n' PATHS=($(printf "%s\n" "${PATHS[@]}" | awk '!seen[$0]++' | awk '{print length,$0}' | sort -rn | cut -d" " -f2-))
  unset IFS

  local first=1
  PATH_REGEX=""
  for p in "${PATHS[@]}"; do
    local esc
    esc=$(printf "%s" "$p" | sed -E 's/[][\.^$|?*()+{}]/\\&/g')
    if (( first )); then PATH_REGEX="$esc"; first=0; else PATH_REGEX="$PATH_REGEX|$esc"; fi
  done
  dbg "Built PATH_REGEX with ${#PATHS[@]} entries"
}

rewrite_links_in_file() {
  local html_file="$1"
  [[ ! -f "$html_file" ]] && return 0
  [[ -z "$PATH_REGEX" ]] && return 0
  perl -0777 -i -pe "s|https?://www\\.theoutnet\\.com/($PATH_REGEX)(?=[/\"'\\s?#])|/\$1/|g" "$html_file"
  sed -i -E 's|([^:])/+|\1/|g' "$html_file"
  if (( WRITE_LINK_TRAILING_SLASH )); then
    for p in "${PATHS[@]}"; do
      sed -i -E "s|(href=\")(/$p)([\"?#])|\1\2/\3|g" "$html_file"
      sed -i -E "s|(href=\")(/$p)(\")|\1\2/\3|g" "$html_file"
    done
  fi
}

verify_archive() {
  echo "----- VERIFY $(date -u) -----" > "$VERIFY_LOG"
  local total_html
  total_html=$(find "$OUTPUT_ROOT" -type f -name index.html 2>/dev/null | wc -l)
  echo "index.html files: $total_html" | tee -a "$VERIFY_LOG"
  local remaining
  remaining=$(grep -RIl "https://www.theoutnet.com" "$OUTPUT_ROOT" 2>/dev/null | wc -l || true)
  echo "Files still containing absolute URLs: $remaining" | tee -a "$VERIFY_LOG"
  if (( remaining > 0 )); then
    echo "Sample:" >> "$VERIFY_LOG"
    grep -RIl "https://www.theoutnet.com" "$OUTPUT_ROOT" 2>/dev/null | head -5 >> "$VERIFY_LOG"
  fi
}

########################################
# BASE SingleFile OPTIONS (root-safe)
########################################
BASE_OPTIONS=(
  --browser-executable-path "/usr/bin/google-chrome"
  --browser-headless true
  --browser-arg "--no-sandbox"
  --browser-arg "--disable-dev-shm-usage"
  --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
  --browser-cookies-file "$COOKIES_FILE"
  --block-images false
  --block-scripts true
  --block-stylesheets false
  --browser-load-max-time 120000
  --browser-wait-until "networkIdle"          # valid value (networkidle0 was not)
  --browser-wait-delay 10000
  --compress-content true
  --self-extracting-archive false             # critical: ensure raw ZIP
  --compress-HTML true
  --compress-CSS true
  --max-resource-size-enabled true
  --max-resource-size 1
  --group-duplicate-images true
  --group-duplicate-stylesheets true
  --blocked-URL-pattern "analytics|tracker|doubleclick|ads|googletagmanager|facebook.net|monetate|bing.com|creativecdn|tiktok|bat.bing|raygun.io|optimizely|techlab-cdn|connect.facebook.net"
  --filename-conflict-action overwrite
  --crawl-links false
  --remove-unused-styles true
  --remove-unused-fonts true
  --remove-alternative-images true
  --remove-frames true
  --insert-meta-CSP true
)

########################################
# START
########################################
build_path_regex
TOTAL=$(grep -cve '^[[:space:]]*$' "$URLS_FILE" || echo 0)
log "Total URLs (non-empty lines): $TOTAL"
(( TOTAL > 0 )) || { err "No URLs to process."; exit 1; }

INDEX=0

while IFS= read -r url; do
  url="${url//$'\r'/}"
  [[ -z "$url" ]] && continue
  [[ ! "$url" =~ https?://(www\.)?theoutnet\.com/ ]] && { dbg "Skip non-target: $url"; continue; }

  ((INDEX++))
  log "[$INDEX/$TOTAL] $url"

  # Derive path
  path="${url#https://www.theoutnet.com/}"
  path="${path#http://www.theoutnet.com/}"
  path="${path%%\?*}"
  path="${path%%#*}"
  path="${path%/}"
  [[ -z "$path" ]] && path="index"
  folder=$(dirname "$path")
  file=$(basename "$path")
  [[ "$folder" == "." ]] && folder=""

  outdir="$OUTPUT_ROOT/$folder"
  zippath="$outdir/${file}.zip"
  folderpath="$outdir/${file}"

  mkdir -p "$outdir"

  # Proxy rotate
  proxy_opts=()
  if (( PROXY_COUNT > 0 )); then
    proxy_index=$(( (INDEX - 1) % PROXY_COUNT ))
    proxy_str=$(get_proxy_opts "$proxy_index")
    [[ -n "$proxy_str" ]] && proxy_opts=($proxy_str)
    dbg "  Proxy idx $proxy_index"
  fi

  # Prepare temporal markers
  pre_ls=$(mktemp)
  ls -1t . > "$pre_ls" 2>/dev/null || true
  start_ts=$(date +%s)

  cmd=( ./single-file "$url" "$zippath" "${BASE_OPTIONS[@]}" "${proxy_opts[@]}" )
  dbg "  Command: ${cmd[*]}"

  # Run and capture stderr separately for quick parsing
  tmp_stderr=$(mktemp)
  if ! "${cmd[@]}" 2> >(tee -a "$ERROR_LOG" >"$tmp_stderr"); then
    err "  SingleFile exited non-zero."
  fi

  # Detect Chrome launch failure
  if grep -qiE "no usable sandbox|cannot run as root|failed to launch|chrome.*error" "$tmp_stderr"; then
    err "  Chrome launch failure detected (see $ERROR_LOG). Check --no-sandbox and chrome path."
    rm -f "$tmp_stderr"
    continue
  fi
  rm -f "$tmp_stderr"

  # Validate output
  if [[ ! -f "$zippath" ]]; then
    # Look for fallback saved.html
    if [[ -f saved.html && $(stat -c %Y saved.html) -ge $((start_ts-2)) ]]; then
      err "  Expected ZIP not created; SingleFile wrote fallback saved.html (arg shift or option mismatch)."
    else
      err "  ZIP missing: $zippath"
    fi
    continue
  fi

  # Unzip
  rm -rf "$folderpath"
  mkdir -p "$folderpath"
  if ! unzip -q "$zippath" -d "$folderpath" 2>>"$ERROR_LOG"; then
    err "  Unzip failed for $zippath"
    continue
  fi
  rm -f "$zippath"

  if [[ -f "$folderpath/index.html" ]]; then
    rewrite_links_in_file "$folderpath/index.html"
  else
    err "  index.html missing after unzip in $folderpath"
  fi

  if id www-data &>/dev/null; then
    chown -R www-data:www-data "$folderpath" || err "  chown failed for $folderpath"
  fi

  log "  OK -> $folderpath/index.html"
  sleep "$REQUEST_DELAY"

done < "$URLS_FILE"

log "Global rewrite pass..."
if [[ -n "$PATH_REGEX" ]]; then
  while IFS= read -r f; do rewrite_links_in_file "$f"; done < <(find "$OUTPUT_ROOT" -type f -name index.html)
fi

verify_archive
log "Done."
[[ -s "$ERROR_LOG" ]] && log "Errors logged to $ERROR_LOG" || log "No errors logged."