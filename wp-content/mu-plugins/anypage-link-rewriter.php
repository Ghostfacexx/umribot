<?php
/**
 * Plugin Name: AnyPage Link Rewriter (MU)
 * Description: Rewrites OpenCart product links in content to Woo product permalinks using a JSON map.
 * Version: 1.0.0
 * Load order: MU plugin (drop in wp-content/mu-plugins)
 */
if (!defined('ABSPATH')) exit;

add_filter('the_content', function ($html) {
  if (!is_singular()) return $html;

  static $map = null;
  if ($map === null) {
    // Put your generated product-map.json here (adjust path as needed)
    $pth = WP_CONTENT_DIR . '/uploads/anypage/product-map.json';
    if (file_exists($pth)) {
      $json = file_get_contents($pth);
      $map = json_decode($json, true);
    }
    if (!is_array($map)) $map = [];
  }
  if (!$map) return $html;

  // Replace URLs like index.php?route=product/product&product_id=120
  $html = preg_replace_callback('~href=("|\')([^"\']*index\.php\?[^"\']*)\1~i', function ($m) use ($map) {
    $q = $m[2];
    $parts = wp_parse_url($q);
    if (!isset($parts['query'])) return $m[0];
    parse_str($parts['query'], $qs);
    if (!isset($qs['route']) || stripos($qs['route'], 'product/product') === false) return $m[0];
    $pid = isset($qs['product_id']) ? $qs['product_id'] : (isset($qs['productId']) ? $qs['productId'] : '');
    if (!$pid || empty($map[$pid])) return $m[0];
    $new = home_url(user_trailingslashit('product/' . $map[$pid]));
    return 'href="' . esc_url($new) . '"';
  }, $html);

  return $html;
}, 15);
