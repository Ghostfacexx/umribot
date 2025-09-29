<?php
if (!defined('ABSPATH')) { exit; }

/**
 * Woo (Teashop) mirror theme bootstrap
 * - Global: Font Awesome 4.7 + Bootstrap 3.4.1 (icons, glyphicons, grid)
 * - Front page: OwlCarousel 1.3.3 (local if present; CDN fallback)
 * - Strip WP global styles that fight mirrored HTML
 * - Clean up stray Font Awesome / Glyphicon hex tokens and private-use characters
 * - Robust Owl init with autoplay and pre-wrapped-markup repair
 * - Keep Woo styles off the front page (shop pages remain styled)
 */

add_action('after_setup_theme', function () {
  add_theme_support('title-tag');
  add_theme_support('woocommerce');
});

/* Remove WP/block styles that interfere with mirrored HTML */
add_action('wp_enqueue_scripts', function () {
  wp_dequeue_style('wp-block-library');
  wp_dequeue_style('wp-block-library-theme');
  wp_dequeue_style('global-styles');
  wp_dequeue_style('classic-theme-styles');
}, 20);

/* Keep Woo styles on shop pages; disable on front page to avoid layout clashes */
add_filter('woocommerce_enqueue_styles', function ($styles) {
  if (is_front_page()) { return []; }
  return $styles;
});

/* Core assets and fixes */
add_action('wp_enqueue_scripts', function () {
  if (is_admin()) return;

  $uri = get_stylesheet_directory_uri();
  $dir = get_stylesheet_directory();

  // Always have jQuery available
  wp_enqueue_script('jquery');

  // 1) Global CSS: Font Awesome + Bootstrap (icons, glyphicons, grid)
  wp_enqueue_style('woo-fa4', $uri . '/assets/css/font-awesome.min.css', [], '4.7.0');
  wp_enqueue_style('woo-bs3', $uri . '/assets/css/bootstrap.min.css', [], '3.4.1');

  // 2) Front-page only: OwlCarousel (local preferred; CDN fallback)
  if (is_front_page()) {
    $owlCss = file_exists($dir . '/assets/css/owl.carousel.min.css')
      ? $uri . '/assets/css/owl.carousel.min.css'
      : 'https://cdnjs.cloudflare.com/ajax/libs/owl-carousel/1.3.3/owl.carousel.min.css';
    $owlThemeCss = file_exists($dir . '/assets/css/owl.theme.min.css')
      ? $uri . '/assets/css/owl.theme.min.css'
      : 'https://cdnjs.cloudflare.com/ajax/libs/owl-carousel/1.3.3/owl.theme.min.css';
    $owlJs = file_exists($dir . '/assets/js/owl.carousel.min.js')
      ? $uri . '/assets/js/owl.carousel.min.js'
      : 'https://cdnjs.cloudflare.com/ajax/libs/owl-carousel/1.3.3/owl.carousel.min.js';

    wp_enqueue_style('woo-owl', $owlCss, [], '1.3.3');
    wp_enqueue_style('woo-owl-theme', $owlThemeCss, ['woo-owl'], '1.3.3');
    wp_enqueue_script('woo-owl', $owlJs, ['jquery'], '1.3.3', true);
  }

  // 3) Small global CSS fixes (icons + remove duplicate page titles on mirrored pages)
  $css = '
    /* Hide stray icon code tokens accidentally captured inside FA/Glyphicons */
    .fa > span, .glyphicon > span,
    .fa > i, .glyphicon > i,
    .fa > b, .glyphicon > b,
    .fa > strong, .glyphicon > strong,
    .fa > em, .glyphicon > em { display: none !important; }

    /* Force correct icon fonts on icon elements */
    i.fa, .fa { font-family: "FontAwesome" !important; font-style: normal; text-rendering:auto; -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }
    .glyphicon { font-family: "Glyphicons Halflings" !important; }

    /* Kill theme page titles if the mirrored page already has its own heading */
    .entry-title, .page-title, .wp-block-post-title { display: none !important; }

    /* Make sure the main slider is visible */
    #slideshow0 { opacity: 1 !important; }
  ';
  wp_register_style('woo-inline', false, [], null);
  wp_enqueue_style('woo-inline');
  wp_add_inline_style('woo-inline', $css);

  // 4) JS: Clean stray text/hex tokens in FA/Glyphicons (now and in future DOM changes)
  $js_global = <<<JS
  (function($){
    // Returns true if a string looks like a FA hex code ("f0d7", "f002") or private-use glyphs
    function looksLikeFaHex(s){
      if (!s) return false;
      var t = String(s).trim().toLowerCase();
      if (/^f[0-9a-f]{3}$/.test(t)) return true;
      // Contains private-use characters (FontAwesome often sits in U+F000..U+F2FF)
      for (var i=0;i<t.length;i++){
        var code = t.charCodeAt(i);
        if (code >= 0xf000 && code <= 0xf2ff) return true;
      }
      return false;
    }

    function cleanIconElement(el){
      var \$el = $(el);

      // Remove raw text nodes that look like hex tokens or PUA glyphs
      \$el.contents().each(function(){
        if (this.nodeType === 3) {
          var tx = this.nodeValue;
          if (looksLikeFaHex(tx)) { $(this).remove(); }
        }
      });

      // Remove spans (and common inline tags) that contain only those tokens
      \$el.find('span, i, b, strong, em').each(function(){
        var txt = ($(this).text() || '').trim();
        if (looksLikeFaHex(txt)) $(this).remove();
      });

      // Hide from AT if no label
      if (!\$el.attr('aria-hidden')) \$el.attr('aria-hidden','true');
    }

    function cleanAllIcons(){
      $('.fa, .glyphicon').each(function(){ cleanIconElement(this); });
    }

    // Initial clean
    $(function(){ cleanAllIcons(); });

    // Keep cleaning if DOM changes (e.g., widgets, lazy scripts)
    var obs;
    try{
      obs = new MutationObserver(function(muts){
        var needs = false;
        for (var i=0;i<muts.length;i++){
          var m = muts[i];
          if ((m.addedNodes && m.addedNodes.length) || (m.type === 'characterData')) { needs = true; break; }
        }
        if (needs) cleanAllIcons();
      });
      obs.observe(document.documentElement, { childList:true, subtree:true, characterData:true });
    }catch(e){}
  })(jQuery);
JS;
  wp_register_script('woo-icons-clean', false, ['jquery'], null, true);
  wp_enqueue_script('woo-icons-clean');
  wp_add_inline_script('woo-icons-clean', $js_global);

  // 5) Front-page Owl init (robust): unwrap captured markup if already "Owl-wrapped" and start autoplay
  if (is_front_page()) {
    $js_front = <<<JS
    (function($){
      function rebuildIfWrapped($s){
        var \$wrappedItems = \$s.find('.owl-wrapper-outer .owl-wrapper .owl-item .item');
        if (\$wrappedItems.length){
          var items = [];
          \$wrappedItems.each(function(){ items.push($(this).clone(true)); });
          \$s.empty();
          for (var i=0;i<items.length;i++){ \$s.append(items[i]); }
        }
      }
      function findSlider(){
        var \$s = $('#slideshow0');
        if (\$s.length) return \$s;
        var found = $();
        $('[id^="slideshow"], .slideshow, .owl-carousel').each(function(){
          var \$el = $(this);
          var count = \$el.find('> .item').length || \$el.find('.owl-wrapper-outer .owl-wrapper .owl-item .item').length;
          if (!found.length && count >= 2) found = \$el;
        });
        return found;
      }
      function tryInit(){
        var \$s = findSlider();
        if (!\$s.length) return false;
        if (typeof $.fn.owlCarousel !== 'function') return false;
        if (\$s.data('owlCarousel')) { \$s.trigger('owl.play', 4000); return true; }
        rebuildIfWrapped(\$s);
        try {
          \$s.owlCarousel({
            items: 1,
            singleItem: true,
            autoPlay: 4000,
            slideSpeed: 600,
            stopOnHover: true,
            pagination: true,
            navigation: true,
            navigationText: ["<i class='fa fa-chevron-left'></i>","<i class='fa fa-chevron-right'></i>"]
          });
          return true;
        } catch(e) { return false; }
      }
      $(function(){
        var tries = 0, maxTries = 24, timer = setInterval(function(){
          tries++;
          if (tryInit() || tries >= maxTries) clearInterval(timer);
        }, 250);
      });
    })(jQuery);
JS;
    // Depend on woo-owl when it's enqueued; otherwise just on jQuery and our retries handle timing
    $deps = array('jquery');
    if (wp_script_is('woo-owl', 'enqueued') || wp_script_is('woo-owl', 'registered')) $deps[] = 'woo-owl';
    wp_register_script('woo-owl-init', false, $deps, null, true);
    wp_enqueue_script('woo-owl-init');
    wp_add_inline_script('woo-owl-init', $js_front);
  }
}, 40);