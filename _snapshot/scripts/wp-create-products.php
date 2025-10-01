<?php
/**
 * WP-CLI: create WooCommerce products from a JSON catalog (built from mirror).
 *
 * Usage:
 *   wp eval-file scripts/wp-create-products.php /absolute/path/to/out/product-catalog.json
 *
 * JSON format (keyed by ID):
 * {
 *   "120": { "id":"120", "title":"???? ??? /???????/", "slug":"yoga-chay-ayurveda", "image":"https://...", "price":"5.40 ??. (2.76€)" },
 *   ...
 * }
 */
if ( ! defined('WP_CLI') ) { echo "Run via WP-CLI.\n"; return; }
if ( ! class_exists('WooCommerce') ) { WP_CLI::error('WooCommerce is not active.'); }

$argv = $_SERVER['argv'];
$jsonPath = isset($argv[2]) ? $argv[2] : '';
if ( ! $jsonPath || ! file_exists($jsonPath) ) {
  WP_CLI::error('Provide JSON path: wp eval-file scripts/wp-create-products.php /path/product-catalog.json');
}

$data = json_decode(file_get_contents($jsonPath), true);
if ( ! is_array($data) ) WP_CLI::error('Invalid JSON.');

function ensure_product_exists($slug, $title) {
  $post = get_page_by_path($slug, OBJECT, 'product');
  if ( $post ) return $post->ID;

  $post_id = wp_insert_post([
    'post_type'   => 'product',
    'post_status' => 'publish',
    'post_title'  => $title ?: $slug,
    'post_name'   => $slug,
    'post_content'=> '',
  ], true);

  if ( is_wp_error($post_id) ) {
    WP_CLI::warning('Failed to create product '.$slug.': '.$post_id->get_error_message());
    return 0;
  }

  // Set simple product type
  wp_set_object_terms($post_id, 'simple', 'product_type', false);

  // Visible/catalog
  update_post_meta($post_id, '_visibility', 'visible');
  update_post_meta($post_id, '_stock_status', 'instock');

  return $post_id;
}

function parse_bgn_price($s) {
  if (!is_string($s) || $s === '') return '';
  // Try to extract first decimal number, replace comma with dot if needed
  if (preg_match('~(\d+(?:[.,]\d+)?)\s*??~u', $s, $m)) {
    return str_replace(',', '.', $m[1]);
  }
  return '';
}

function attach_image_to_product($post_id, $url) {
  if ( ! $url ) return;
  // Download and attach
  require_once ABSPATH . 'wp-admin/includes/file.php';
  require_once ABSPATH . 'wp-admin/includes/media.php';
  require_once ABSPATH . 'wp-admin/includes/image.php';
  $tmp = download_url($url);
  if ( is_wp_error($tmp) ) { WP_CLI::warning('Image download failed: '.$url); return; }
  $file = [
    'name'     => basename(parse_url($url, PHP_URL_PATH)),
    'type'     => mime_content_type($tmp),
    'tmp_name' => $tmp,
    'size'     => filesize($tmp),
    'error'    => 0,
  ];
  $id = media_handle_sideload($file, $post_id);
  @unlink($tmp);
  if (is_wp_error($id)) { WP_CLI::warning('Image attach failed: '.$url); return; }
  set_post_thumbnail($post_id, $id);
}

$created = 0; $skipped = 0;
foreach ($data as $pid => $row) {
  $slug  = sanitize_title($row['slug'] ?? '');
  $title = $row['title'] ?? '';
  if ( ! $slug ) { WP_CLI::warning("Skip $pid (no slug)"); $skipped++; continue; }

  $post_id = ensure_product_exists($slug, $title);
  if ( ! $post_id ) { $skipped++; continue; }

  // Price (optional)
  $price = parse_bgn_price($row['price'] ?? '');
  if ( $price !== '' ) {
    update_post_meta($post_id, '_regular_price', $price);
    update_post_meta($post_id, '_price', $price);
  }

  // Image (optional)
  $image = $row['image'] ?? '';
  if ( $image ) attach_image_to_product($post_id, $image);

  $created++;
  WP_CLI::log("OK: $slug (post_id=$post_id)");
}

WP_CLI::success("Done. Created/updated: $created, Skipped: $skipped");