#!/usr/bin/env bash
set -euo pipefail

# setup-teashop-assets.sh
# Prepare local assets for the "teashop-mirror" theme (or any theme dir you pass).
#
# What it does:
# - Creates assets/css, assets/js, assets/fonts under the theme directory
# - Downloads exact versions:
#     Font Awesome 4.7.0 (CSS + fonts)
#     Bootstrap 3.4.1 (CSS + Glyphicons fonts)
#     OwlCarousel 1.3.3 (CSS/JS)
# - Optionally writes/patches functions.php to load these local assets (backs up the original)
#
# Usage:
#   ./setup-teashop-assets.sh --theme-dir /absolute/path/to/wp-content/themes/teashop-mirror
#   ./setup-teashop-assets.sh --theme-dir /abs/path --patch-functions
#   ./setup-teashop-assets.sh --theme-dir /abs/path --force
#
# You can still use --create-skeleton to drop a minimal theme if the folder is empty.

THEME_DIR=""
PATCH_FUNCTIONS=0
FORCE=0
CREATE_SKELETON=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --theme-dir) THEME_DIR="${2:-}"; shift 2 ;;
    --patch-functions) PATCH_FUNCTIONS=1; shift ;;
    --force) FORCE=1; shift ;;
    --create-skeleton) CREATE_SKELETON=1; shift ;;
    -h|--help)
      echo "Usage: $0 --theme-dir /path/to/wp-content/themes/teashop-mirror [--patch-functions] [--force] [--create-skeleton]"
      exit 0 ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

[ -n "${THEME_DIR}" ] || { echo "[ERR ] --theme-dir is required"; exit 2; }
[ -d "${THEME_DIR}" ] || mkdir -p "${THEME_DIR}"

CSS_DIR="${THEME_DIR}/assets/css"
JS_DIR="${THEME_DIR}/assets/js"
FONTS_DIR="${THEME_DIR}/assets/fonts"

need() { command -v "$1" >/dev/null 2>&1 || { echo "[ERR ] Missing '$1'"; exit 2; }; }
need curl

write_file() {
  local dest="$1"; shift
  if [[ -f "$dest" && $FORCE -ne 1 ]]; then
    echo "[SKIP] $dest exists (use --force to overwrite)"
    return 0
  fi
  cat > "$dest" <<'EOF'
EOF
}

echo "[INFO] Theme dir: ${THEME_DIR}"
mkdir -p "${CSS_DIR}" "${JS_DIR}" "${FONTS_DIR}"

if [[ "${CREATE_SKELETON}" -eq 1 ]]; then
  echo "[INFO] Creating minimal theme skeleton"
  # style.css
  cat > "${THEME_DIR}/style.css" <<'CSS'
/*
Theme Name: Teashop Mirror
Theme URI: https://example.com
Author: You
Description: Minimal mirror theme for WooCommerce. Renders the front page with captured HTML and loads Bootstrap 3 + Font Awesome + Owl Carousel for pixel-close reproduction.
Version: 1.0.1
Text Domain: teashop-mirror
*/
html, body { margin: 0; padding: 0; }
.fa > span, .glyphicon > span { display: none !important; }
CSS
  # header.php
  cat > "${THEME_DIR}/header.php" <<'PHP'
<?php if (!defined('ABSPATH')) { exit; } ?>
<!doctype html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo('charset'); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
PHP
  # footer.php
  cat > "${THEME_DIR}/footer.php" <<'PHP'
<?php if (!defined('ABSPATH')) { exit; } ?>
<?php wp_footer(); ?>
</body>
</html>
PHP
  # index.php
  cat > "${THEME_DIR}/index.php" <<'PHP'
<?php
if (!defined('ABSPATH')) { exit; }
get_header();
if (have_posts()) :
  while (have_posts()) : the_post();
    the_content();
  endwhile;
endif;
get_footer();
PHP
  # front-page.php
  cat > "${THEME_DIR}/front-page.php" <<'PHP'
<?php
if (!defined('ABSPATH')) { exit; }
get_header();
while (have_posts()) : the_post();
  the_content();
endwhile;
get_footer();
PHP
  # page.php
  cat > "${THEME_DIR}/page.php" <<'PHP'
<?php
if (!defined('ABSPATH')) { exit; }
get_header();
while (have_posts()) : the_post();
  the_content();
endwhile;
get_footer();
PHP
fi

# Download sources (exact versions)
CDN_FA_BASE="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0"
CDN_BS_BASE="https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1"
CDN_OWL_BASE="https://cdnjs.cloudflare.com/ajax/libs/OwlCarousel/1.3.3"

declare -A FILES
# CSS
FILES["${CSS_DIR}/font-awesome.min.css"]="${CDN_FA_BASE}/css/font-awesome.min.css"
FILES["${CSS_DIR}/bootstrap.min.css"]="${CDN_BS_BASE}/css/bootstrap.min.css"
FILES["${CSS_DIR}/owl.carousel.min.css"]="${CDN_OWL_BASE}/owl.carousel.min.css"
FILES["${CSS_DIR}/owl.theme.min.css"]="${CDN_OWL_BASE}/owl.theme.min.css"
# JS
FILES["${JS_DIR}/owl.carousel.min.js"]="${CDN_OWL_BASE}/owl.carousel.min.js"
# FA fonts
FILES["${FONTS_DIR}/fontawesome-webfont.eot"]="${CDN_FA_BASE}/fonts/fontawesome-webfont.eot"
FILES["${FONTS_DIR}/fontawesome-webfont.woff2"]="${CDN_FA_BASE}/fonts/fontawesome-webfont.woff2"
FILES["${FONTS_DIR}/fontawesome-webfont.woff"]="${CDN_FA_BASE}/fonts/fontawesome-webfont.woff"
FILES["${FONTS_DIR}/fontawesome-webfont.ttf"]="${CDN_FA_BASE}/fonts/fontawesome-webfont.ttf"
FILES["${FONTS_DIR}/fontawesome-webfont.svg"]="${CDN_FA_BASE}/fonts/fontawesome-webfont.svg"
# Bootstrap Glyphicons
FILES["${FONTS_DIR}/glyphicons-halflings-regular.eot"]="${CDN_BS_BASE}/fonts/glyphicons-halflings-regular.eot"
FILES["${FONTS_DIR}/glyphicons-halflings-regular.woff2"]="${CDN_BS_BASE}/fonts/glyphicons-halflings-regular.woff2"
FILES["${FONTS_DIR}/glyphicons-halflings-regular.woff"]="${CDN_BS_BASE}/fonts/glyphicons-halflings-regular.woff"
FILES["${FONTS_DIR}/glyphicons-halflings-regular.ttf"]="${CDN_BS_BASE}/fonts/glyphicons-halflings-regular.ttf"
FILES["${FONTS_DIR}/glyphicons-halflings-regular.svg"]="${CDN_BS_BASE}/fonts/glyphicons-halflings-regular.svg"

download() {
  local dest="$1" url="$2"
  if [[ -s "$dest" && $FORCE -ne 1 ]]; then
    echo "[SKIP] $(basename "$dest") exists"
    return 0
  fi
  echo "[GET ] $url"
  curl -fL --retry 3 --retry-delay 1 -o "${dest}.part" "$url"
  mv "${dest}.part" "$dest"
  echo "[OK  ] $(basename "$dest")"
}

FAILED=0
for dest in "${!FILES[@]}"; do
  if ! download "$dest" "${FILES[$dest]}"; then
    FAILED=$((FAILED+1))
  fi
done
[[ $FAILED -gt 0 ]] && echo "[WARN] $FAILED file(s) failed to download."

# Patch functions.php (optional)
if [[ $PATCH_FUNCTIONS -eq 1 ]]; then
  FN="${THEME_DIR}/functions.php"
  if [[ -f "$FN" ]]; then
    cp -f "$FN" "${FN}.bak.$(date +%Y%m%d%H%M%S)"
    echo "[INFO] Backed up functions.php"
  fi
  cat > "$FN" <<'PHP'
<?php
if (!defined('ABSPATH')) { exit; }

/* Basic supports */
add_action('after_setup_theme', function () {
  add_theme_support('title-tag');
  add_theme_support('woocommerce');
});

/* Strip WP/global styles that can interfere with mirrored HTML */
add_action('wp_enqueue_scripts', function () {
  wp_dequeue_style('wp-block-library');
  wp_dequeue_style('wp-block-library-theme');
  wp_dequeue_style('global-styles');
  wp_dequeue_style('classic-theme-styles');
}, 20);

/* Disable Woo styles on the front page only (shop pages keep styling) */
add_filter('woocommerce_enqueue_styles', function ($styles) {
  if (is_front_page()) { return []; }
  return $styles;
});

/* Load dependencies the mirrored INDEX expects (front page only) */
add_action('wp_enqueue_scripts', function () {
  if (!is_front_page()) return;

  $uri = get_stylesheet_directory_uri();

  wp_enqueue_script('jquery'); // WordPress jQuery

  // CSS: Local assets
  wp_enqueue_style('tm-fa4', $uri . '/assets/css/font-awesome.min.css', [], '4.7.0');
  wp_enqueue_style('tm-bs3', $uri . '/assets/css/bootstrap.min.css', [], '3.4.1');
  wp_enqueue_style('tm-owl', $uri . '/assets/css/owl.carousel.min.css', [], '1.3.3');
  wp_enqueue_style('tm-owl-theme', $uri . '/assets/css/owl.theme.min.css', ['tm-owl'], '1.3.3');

  // JS: Local OwlCarousel
  wp_enqueue_script('tm-owl', $uri . '/assets/js/owl.carousel.min.js', ['jquery'], '1.3.3', true);

  // Minimal fixes
  $css = '
    .entry-title, .page-title, .wp-block-post-title { display: none !important; }
    .fa > span, .glyphicon > span { display:none !important; }
    #slideshow0 { opacity: 1 !important; }
  ';
  wp_register_style('tm-inline', false, [], null);
  wp_enqueue_style('tm-inline');
  wp_add_inline_style('tm-inline', $css);

  $js = <<<JS
  jQuery(function($){
    var \$s = $('#slideshow0');
    if (\$s.length && $.fn.owlCarousel) {
      try {
        \$s.owlCarousel({
          singleItem: true,
          autoPlay: 4000,
          slideSpeed: 600,
          pagination: true,
          navigation: true,
          navigationText: ["<i class='fa fa-chevron-left'></i>","<i class='fa fa-chevron-right'></i>"],
          stopOnHover: true
        });
      } catch(e){}
    }
  });
JS;
  wp_add_inline_script('tm-owl', $js, 'after');
}, 30);
PHP
  echo "[INFO] Patched functions.php to use local assets"
fi

echo
echo "[DONE] Assets are in:"
echo "  ${CSS_DIR}"
echo "  ${JS_DIR}"
echo "  ${FONTS_DIR}"
echo "Hard refresh your homepage (Ctrl+F5) after clearing caches."