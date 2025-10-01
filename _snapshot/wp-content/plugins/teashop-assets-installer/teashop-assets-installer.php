<?php
/**
 * Plugin Name: Teashop Assets Installer
 * Description: One-click installer to download Font Awesome 4.7.0, Bootstrap 3.4.1 + Glyphicons, and Owl Carousel 1.3.3 into the active theme’s assets folder.
 * Version: 1.0.0
 */
if (!defined('ABSPATH')) exit;

add_action('admin_menu', function () {
  add_management_page('Teashop Assets', 'Teashop Assets', 'manage_options', 'teashop-assets', 'tai_render_page');
});

function tai_assets_map($theme_dir) {
  return [
    // CSS
    [ 'path' => $theme_dir.'/assets/css/font-awesome.min.css', 'url' => 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css' ],
    [ 'path' => $theme_dir.'/assets/css/bootstrap.min.css',    'url' => 'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1/css/bootstrap.min.css' ],
    [ 'path' => $theme_dir.'/assets/css/owl.carousel.min.css', 'url' => 'https://cdnjs.cloudflare.com/ajax/libs/OwlCarousel/1.3.3/owl.carousel.min.css' ],
    [ 'path' => $theme_dir.'/assets/css/owl.theme.min.css',    'url' => 'https://cdnjs.cloudflare.com/ajax/libs/OwlCarousel/1.3.3/owl.theme.min.css' ],
    // JS
    [ 'path' => $theme_dir.'/assets/js/owl.carousel.min.js',   'url' => 'https://cdnjs.cloudflare.com/ajax/libs/OwlCarousel/1.3.3/owl.carousel.min.js' ],
    // FA fonts
    [ 'path' => $theme_dir.'/assets/fonts/fontawesome-webfont.eot',  'url' => 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.eot' ],
    [ 'path' => $theme_dir.'/assets/fonts/fontawesome-webfont.woff2','url' => 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.woff2' ],
    [ 'path' => $theme_dir.'/assets/fonts/fontawesome-webfont.woff', 'url' => 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.woff' ],
    [ 'path' => $theme_dir.'/assets/fonts/fontawesome-webfont.ttf',  'url' => 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.ttf' ],
    [ 'path' => $theme_dir.'/assets/fonts/fontawesome-webfont.svg',  'url' => 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.svg' ],
    // Bootstrap Glyphicons
    [ 'path' => $theme_dir.'/assets/fonts/glyphicons-halflings-regular.eot',  'url' => 'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1/fonts/glyphicons-halflings-regular.eot' ],
    [ 'path' => $theme_dir.'/assets/fonts/glyphicons-halflings-regular.woff2','url' => 'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1/fonts/glyphicons-halflings-regular.woff2' ],
    [ 'path' => $theme_dir.'/assets/fonts/glyphicons-halflings-regular.woff', 'url' => 'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1/fonts/glyphicons-halflings-regular.woff' ],
    [ 'path' => $theme_dir.'/assets/fonts/glyphicons-halflings-regular.ttf',  'url' => 'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1/fonts/glyphicons-halflings-regular.ttf' ],
    [ 'path' => $theme_dir.'/assets/fonts/glyphicons-halflings-regular.svg',  'url' => 'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1/fonts/glyphicons-halflings-regular.svg' ],
  ];
}

function tai_render_page() {
  if (!current_user_can('manage_options')) return;
  $theme_dir = get_stylesheet_directory();
  $theme_uri = get_stylesheet_directory_uri();

  if (isset($_POST['tai_install']) && check_admin_referer('tai_install_assets')) {
    tai_install_assets($theme_dir);
  }

  $assets_base = $theme_dir.'/assets';
  echo '<div class="wrap"><h1>Teashop Assets Installer</h1>';
  echo '<p>Target theme: <code>'.esc_html($theme_dir).'</code></p>';
  if (is_dir($assets_base)) {
    echo '<p>Assets directory exists: <code>'.esc_html($assets_base).'</code></p>';
  }
  echo '<form method="post">';
  wp_nonce_field('tai_install_assets');
  submit_button('Install / Update assets', 'primary', 'tai_install');
  echo '</form>';

  // Quick verification list
  echo '<h2>Files expected</h2><ul>';
  foreach (tai_assets_map($theme_dir) as $f) {
    $exists = file_exists($f['path']);
    echo '<li>'.($exists ? '✅' : '❌').' <code>'.esc_html(str_replace($theme_dir, '', $f['path'])).'</code></li>';
  }
  echo '</ul>';

  echo '<p>After installation, hard-refresh the homepage (Ctrl+F5). Your theme already enqueues these local files.</p>';
  echo '</div>';
}

function tai_install_assets($theme_dir) {
  require_once ABSPATH . 'wp-admin/includes/file.php';
  WP_Filesystem();
  global $wp_filesystem;

  // Create directories
  wp_mkdir_p($theme_dir.'/assets/css');
  wp_mkdir_p($theme_dir.'/assets/js');
  wp_mkdir_p($theme_dir.'/assets/fonts');

  $results = [];
  foreach (tai_assets_map($theme_dir) as $item) {
    $dest = $item['path'];
    $url  = $item['url'];
    $ok   = tai_fetch_and_write($url, $dest, $wp_filesystem);
    $results[] = [ 'dest' => $dest, 'url' => $url, 'ok' => $ok ];
  }

  echo '<div class="notice notice-'.(tai_all_ok($results) ? 'success' : 'warning').'"><p>';
  foreach ($results as $r) {
    echo esc_html(($r['ok'] ? 'OK  ' : 'FAIL')).' '.esc_html(str_replace($theme_dir, '', $r['dest'])).'<br>';
  }
  echo '</p></div>';
}

function tai_fetch_and_write($url, $dest, $fs) {
  $resp = wp_remote_get($url, ['timeout' => 45, 'redirection' => 5, 'sslverify' => true]);
  if (is_wp_error($resp)) return false;
  $code = wp_remote_retrieve_response_code($resp);
  if ($code !== 200) return false;
  $body = wp_remote_retrieve_body($resp);
  if (!is_string($body) || $body === '') return false;
  $dir = dirname($dest);
  if (!is_dir($dir)) wp_mkdir_p($dir);
  // Use filesystem API if available, else fallback
  if ($fs && is_object($fs)) {
    return $fs->put_contents($dest, $body, FS_CHMOD_FILE);
  } else {
    return (bool) file_put_contents($dest, $body);
  }
}

function tai_all_ok($rows) {
  foreach ($rows as $r) if (!$r['ok']) return false;
  return true;
}
