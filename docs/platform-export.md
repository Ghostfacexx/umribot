# Platform Export (Shopify, WooCommerce)

This layer converts captured pages/products into platform‑specific output.

## Usage (CLI)

```bash
# install deps
npm i cheerio

# export Shopify (Liquid + products.csv)
node bin/export-run.cjs --platform shopify --run-dir downloaded_pages/<run_id> --out out/shopify/<run_id>

# export WooCommerce (products.csv + pages WXR XML)
node bin/export-run.cjs --platform woocommerce --run-dir downloaded_pages/<run_id> --out out/woo/<run_id>
```

## What gets produced

- Shopify:
  - `shopify-theme/sections/captured-page-<slug>.liquid` — simple section embedding captured HTML
  - `products.csv` — compatible with Shopify product import (Admin > Products > Import)
- WooCommerce:
  - `woocommerce/woocommerce-products.csv` — minimal product CSV import
  - `woocommerce/wordpress-pages-wxr.xml` — import via WordPress Tools > Import > WordPress

## How it works

1. Parse captured HTML to a normalized schema (pages/products).
2. Exporters adapt the schema to Shopify/WooCommerce formats.
3. You can extend `platform/exporters/*` to support more platforms.

## Extending

Add a new exporter file and switch-case inside `platform/exporter.cjs`, then document the expected output and how to import it on the platform.
