<?php
/**
 * Plugin Name: AnyPage Attach Images (MU)
 * Description: Attach product thumbnails from JSON map (id -> {slug,title,image,price}). Adds WooCommerce submenu: WooCommerce → AnyPage: Attach Images.
 * Version: 1.0.0
 */
if (!defined('ABSPATH')) exit;

add_action('admin_menu', function () {
  add_submenu_page(
    'woocommerce',
    'AnyPage: Attach Images',
    'AnyPage: Attach Images',
    'manage_woocommerce',
    'anypage-attach-images',
    'anypage_attach_images_page'
  );
});

function anypage_attach_images_page() {
  if (!current_user_can('manage_woocommerce')) wp_die('Insufficient permissions.');

  $json_path_default = WP_CONTENT_DIR . '/uploads/anypage/product-catalog.json';
  $json_path = isset($_POST['json_path']) ? sanitize_text_field($_POST['json_path']) : $json_path_default;

  $run = isset($_POST['run']) && check_admin_referer('anypage_attach_images');

  echo '<div class="wrap"><h1>AnyPage: Attach Images</h1>';
  echo '<p>JSON file should be at <code>' . esc_html($json_path_default) . '</code>. You can override the path below.</p>';
  echo '<form method="post">';
  wp_nonce_field('anypage_attach_images');
  echo '<table class="form-table"><tr><th scope="row">JSON Path</th><td><input type="text" name="json_path" value="' . esc_attr($json_path) . '" size="100" /></td></tr></table>';
  submit_button('Attach Images Now', 'primary', 'run');
  echo '</form>';

  if ($run) {
    @set_time_limit(0);
    anypage_do_attach_images($json_path);
  }
  echo '</div>';
}

function anypage_do_attach_images($json_path) {
  if (!file_exists($json_path)) {
    echo '<div class="notice notice-error"><p>JSON not found at ' . esc_html($json_path) . '</p></div>';
    return;
  }
  $json = file_get_contents($json_path);
  $data = json_decode($json, true);
  if (!is_array($data)) {
    echo '<div class="notice notice-error"><p>Invalid JSON.</p></div>';
    return;
  }

  if (!class_exists('WooCommerce')) {
    echo '<div class="notice notice-error"><p>WooCommerce is not active.</p></div>';
    return;
  }

  require_once ABSPATH . 'wp-admin/includes/file.php';
  require_once ABSPATH . 'wp-admin/includes/media.php';
  require_once ABSPATH . 'wp-admin/includes/image.php';

  $ok = 0; $skip = 0; $fail = 0; $log = [];

  foreach ($data as $pid => $row) {
    $sku = isset($row['id']) ? (string)$row['id'] : (string)$pid;
    $image = isset($row['image']) ? esc_url_raw($row['image']) : '';
    if (!$sku) { $skip++; $log[] = "SKIP (no sku): " . print_r($row, true); continue; }

    // Find product by SKU (we imported SKU as original product_id)
    if (!function_exists('wc_get_product_id_by_sku')) {
      $log[] = "ERROR: WooCommerce function wc_get_product_id_by_sku missing.";
      break;
    }
    $post_id = wc_get_product_id_by_sku($sku);
    if (!$post_id) { $skip++; $log[] = "SKIP sku={$sku} (product not found)"; continue; }

    if (get_post_thumbnail_id($post_id)) { $skip++; $log[] = "SKIP sku={$sku} (already has thumbnail)"; continue; }

    if (!$image) { $skip++; $log[] = "SKIP sku={$sku} (no image url)"; continue; }

    $tmp = anypage_download_with_headers($image);
    if (is_wp_error($tmp)) { $fail++; $log[] = "FAIL sku={$sku} download: " . $tmp->get_error_message(); continue; }

    $file_array = [
      'name'     => basename(parse_url($image, PHP_URL_PATH)),
      'type'     => function_exists('mime_content_type') ? mime_content_type($tmp) : 'image/jpeg',
      'tmp_name' => $tmp,
      'size'     => filesize($tmp),
      'error'    => 0,
    ];

    $att_id = media_handle_sideload($file_array, $post_id);
    @unlink($tmp);

    if (is_wp_error($att_id)) {
      $fail++; $log[] = "FAIL sku={$sku} attach: " . $att_id->get_error_message();
      continue;
    }

    set_post_thumbnail($post_id, $att_id);
    $ok++; $log[] = "OK sku={$sku} → attachment {$att_id}";
  }

  echo '<div class="notice notice-success"><p>Done. OK=' . intval($ok) . ', Skipped=' . intval($skip) . ', Failed=' . intval($fail) . '.</p></div>';
  echo '<details style="margin-top:1em;"><summary>Show log</summary><pre style="max-height:400px;overflow:auto;">' . esc_html(implode("\n", $log)) . '</pre></details>';
}

/**
 * Download a file with browser-like headers to a temp file (works around hotlinking).
 */
function anypage_download_with_headers($url) {
  $tmp = wp_tempnam(basename(parse_url($url, PHP_URL_PATH)) ?: 'img');
  if (!$tmp) return new WP_Error('temp', 'Could not create temp file');

  $args = [
    'timeout'     => 30,
    'redirection' => 5,
    'stream'      => true,
    'filename'    => $tmp,
    'headers'     => [
      'User-Agent' => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36',
      'Referer'    => 'https://teashop.bg/',
      'Accept'     => 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    ],
  ];

  $resp = wp_remote_get($url, $args);
  if (is_wp_error($resp)) { @unlink($tmp); return $resp; }

  $code = wp_remote_retrieve_response_code($resp);
  if ($code !== 200 || !file_exists($tmp) || filesize($tmp) < 32) {
    @unlink($tmp);
    return new WP_Error('http', 'Unexpected HTTP ' . $code . ' or empty file for ' . $url);
  }
  return $tmp;
}
