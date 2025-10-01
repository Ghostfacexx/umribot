#!/bin/bash

# Target URL
URL="https://www.theoutnet.com/en-us/shop/"
# Output directory (create if doesn't exist)
OUTDIR="/root/SingleFile/single-file-cli/downloaded_pages/en-us/shop"
mkdir -p "$OUTDIR"
# Output file
OUTFILE="$OUTDIR/index.html"

# Run SingleFile CLI to download the landing page
single-file "$URL" "$OUTFILE"

echo "Landing page saved as $OUTFILE"
