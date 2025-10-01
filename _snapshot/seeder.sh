#!/bin/bash

# Set up signal trap to handle Ctrl+C (SIGINT) and SIGTERM gracefully
# This kills all background processes and exits without killing the shell
trap 'echo "Interrupted by user. Cleaning up..."; kill $(jobs -p) 2>/dev/null; exit 130' SIGINT SIGTERM

URLS_FILE="/root/SingleFile/single-file-cli/seeds.txt"
OUTPUT_ROOT="/root/SingleFile/single-file-cli/downloaded_pages"

while read url; do
  # Extract the path part of the URL (e.g. /en-bg/shop/)
  path=$(echo "$url" | sed -E 's~https?://[^/]+~~')
  # Remove leading slash for folder creation
  path=${path#/}
  # Replace / with _ for safe folder names, or keep / for nested folders
  folder=$(dirname "$path")
  file=$(basename "$path")
  # If file is empty (URL ends with /), set a default filename
  if [[ -z "$file" || "$file" == "$folder" ]]; then
    file="index"
  fi
  outdir="${OUTPUT_ROOT}/${folder}"
  mkdir -p "$outdir"
  outpath="${outdir}/${file}.html"

  echo "Processing: $url -> $outpath"
  ./single-file "$url" "$outpath" \
    --browser-executable-path "/usr/bin/google-chrome" \
    --http-proxy-server "http://gate.decodo.com:7000" \
    --http-proxy-username "user-sp6leiql0l-country-us-session-abc123" \
    --http-proxy-password "g=38To6nZrEexln5Nq" \
    --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
    --browser-cookies-file "/root/SingleFile/SingleFile/cookies.txt" \
    --block-images \
    --browser-load-max-time 120000
  if [ $? -ne 0 ]; then
    echo "Failed to process $url"
  fi
done < "$URLS_FILE"

echo "Processing complete."