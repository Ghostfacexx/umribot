<?php
/**
 * Plugin Name: AnyPage Skin (MU)
 * Description: Enqueue per-page CSS/JS captured from a mirrored page to achieve pixel-accurate rendering.
 * Author: Ghostfacexx + Copilot
 * Version: 1.0.0
 *
 * Install: create the directory wp-content/mu-plugins if it doesn't exist and place this file inside.
 * MU plugins load automatically (no activation screen).
 */

if (!defined('ABSPATH')) { exit; }

add_action('wp_enqueue_scripts', function () {
  if (!is_singular('page')) return;
  $post_id = get_queried_object_id();
  if (!$post_id) return;

  // Minimal layout reset to avoid theme containers limiting width/margins
  $apply_reset = get_post_meta($post_id, '_anypage_layout_reset', true);
  if ($apply_reset === '' || $apply_reset === '1') {
    $reset_handle = 'anypage-layout-reset';
    wp_register_style($reset_handle, false, [], null);
    wp_enqueue_style($reset_handle);
    $reset_css = <<<CSS
/* AnyPage layout reset (safe) */
body.page .entry-content,
body.page .site-content,
body.page .container,
body.page .content-area,
body.page .hentry,
body.page .site-main {
  max-width: none !important;
  width: auto !important;
  padding: 0 !important;
  margin: 0 !important;
}
.entry-content > .wp-block-group,
.entry-content > .wp-block-columns {
  margin: 0 !important;
  padding: 0 !important;
}
img { height: auto; }
CSS;
    wp_add_inline_style($reset_handle, $reset_css);
  }

  // Styles: external list in JSON, plus inline CSS string
  $styles_json = get_post_meta($post_id, '_anypage_styles', true);
  $styles = [];
  if (is_string($styles_json) && $styles_json !== '') {
    $decoded = json_decode($styles_json, true);
    if (is_array($decoded)) $styles = $decoded;
  }

  foreach ($styles as $idx => $url) {
    if (!is_string($url) || $url === '') continue;
    $handle = 'anypage-style-' . $idx;
    // Let browser cache; do not force versions
    wp_enqueue_style($handle, $url, [], null);
  }

  $inline_css = get_post_meta($post_id, '_anypage_inline_css', true);
  if (is_string($inline_css) && $inline_css !== '') {
    $inline_handle = 'anypage-inline';
    // Ensure target handle exists
    if (!wp_style_is($inline_handle, 'registered')) {
      wp_register_style($inline_handle, false, [], null);
      wp_enqueue_style($inline_handle);
    } else {
      wp_enqueue_style($inline_handle);
    }
    wp_add_inline_style($inline_handle, $inline_css);
  }

  // Scripts: external list in JSON
  $scripts_json = get_post_meta($post_id, '_anypage_scripts', true);
  $scripts = [];
  if (is_string($scripts_json) && $scripts_json !== '') {
    $decoded = json_decode($scripts_json, true);
    if (is_array($decoded)) $scripts = $decoded;
  }

  // Load jQuery early if mirrored pages rely on it
  if (!empty($scripts)) {
    wp_enqueue_script('jquery');
  }

  foreach ($scripts as $idx => $url) {
    if (!is_string($url) || $url === '') continue;
    $handle = 'anypage-script-' . $idx;
    wp_enqueue_script($handle, $url, [], null, true);
  }
}, 20);

/**
 * Optional: add defer/async to our anypage-script-* handles (defer by default).
 */
add_filter('script_loader_tag', function ($tag, $handle, $src) {
  if (strpos($handle, 'anypage-script-') === 0) {
    // Add defer attribute
    if (strpos($tag, 'defer') === false) {
      $tag = str_replace('<script ', '<script defer ', $tag);
    }
  }
  return $tag;
}, 10, 3);