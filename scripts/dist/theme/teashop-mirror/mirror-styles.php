<?php
if (!defined('ABSPATH')) exit;
/**
 * Enqueue mirrored site CSS in the order they were discovered.
 * Expects assets-mirror-manifest.json and assets/mirror/... inside this theme.
 */
add_action('wp_enqueue_scripts', function () {
  $theme_dir = get_stylesheet_directory();
  $theme_uri = get_stylesheet_directory_uri();
  $manifest  = $theme_dir . '/assets-mirror-manifest.json';
  if (!file_exists($manifest)) return;
  $data = json_decode(file_get_contents($manifest), true);
  if (!is_array($data) || empty($data['css'])) return;
  $i = 0;
  foreach ($data['css'] as $rel) {
    $rel = ltrim($rel, '/');
    $handle = 'mirror-css-' . (++$i);
    wp_enqueue_style($handle, $theme_uri . '/' . $rel, [], null);
  }
}, 35);
