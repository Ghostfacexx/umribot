#!/usr/bin/env node
/* eslint-disable no-console */
const path = require('path');
const fs = require('fs-extra');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const slugify = require('slugify');
const sanitize = require('sanitize-filename');
const stringify = require('csv-stringify').stringify;
const archiver = require('archiver');
const he = require('he');
const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}

(async () => {
  try {
    const configPath = arg('config', 'scripts/sample.config.json');
    const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));

    // Ensure output dirs
    const outBase = path.resolve(cfg.output.baseDir || 'dist');
    const pagesDir = path.resolve(cfg.output.pagesDir || path.join(outBase, 'pages'));
    const prodsDir = path.resolve(cfg.output.productsDir || path.join(outBase, 'products'));
    const themeOutDir = path.resolve(cfg.output.themeDir || path.join(outBase, 'theme'));
    await fs.ensureDir(outBase);
    await fs.ensureDir(pagesDir);
    await fs.ensureDir(prodsDir);
    await fs.ensureDir(themeOutDir);

    // 1) Build theme folder on disk
    const themeName = cfg.site.themeSlug || 'teashop-mirror';
    const themeDir = path.join(themeOutDir, themeName);
    await fs.emptyDir(themeDir);
    await writeTheme(themeDir, cfg);

    // 2) Download local assets into theme assets
    await prepareLocalAssets(themeDir);

    // 3) Capture pages
    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(90000);

    const pageItems = [];
    for (const p of cfg.pages) {
      console.log(`[pages] capturing: ${p.url}`);
      const html = await captureHTML(page, p.url, p.selector || 'body');
      const cleaned = cleanCapturedHTML(html);
      pageItems.push({
        title: p.title || p.url,
        slug: p.slug || makeSlug(p.title || p.url),
        content: cleaned,
        isFrontPage: !!p.isFrontPage
      });
    }
    await browser.close();

    // 4) Generate WXR for pages
    const wxrPath = path.join(pagesDir, 'pages.wxr');
    await fs.writeFile(wxrPath, buildWXR(cfg, pageItems), 'utf8');
    console.log(`[pages] wrote ${wxrPath}`);

    // 5) Scrape products (CSV for Woo importer)
    if (cfg.scrapeProducts?.enabled && (cfg.scrapeProducts.categoryUrls?.length || 0) > 0) {
      console.log('[products] scraping products...');
      const prodRows = await scrapeProducts(cfg);
      if (prodRows.length) {
        const csvPath = path.join(prodsDir, 'products.csv');
        await writeWooCSV(csvPath, prodRows);
        console.log(`[products] wrote ${csvPath} (${prodRows.length} products)`);
      } else {
        console.log('[products] no products found (check categoryUrls/selectors)');
      }
    } else {
      console.log('[products] skipping (disabled or no categoryUrls)');
    }

    // 6) Zip the theme
    const zipPath = path.join(themeOutDir, `${themeName}.zip`);
    await zipFolder(themeDir, zipPath);
    console.log(`[theme] wrote ${zipPath}`);

    // 7) Summary
    console.log('\nDone.\nImport order via GUI:');
    console.log(`1) Appearance → Themes → Add New → Upload: ${zipPath}`);
    console.log(`2) Tools → Import → WordPress → Upload: ${wxrPath} (pages)`);
    console.log(`3) WooCommerce → Products → Import → Upload: ${path.join(prodsDir, 'products.csv')}`);
    console.log('4) Settings → Reading → Set Static Front Page to the imported homepage.');
  } catch (err) {
    console.error('FATAL', err);
    process.exit(1);
  }
})();

/* ------------------- helpers ------------------- */

function makeSlug(s) {
  if (!s) return `page-${Date.now()}`;
  try {
    // keep non-latin by replacing spaces with hyphens, leave unicode
    const trimmed = s.trim().toLowerCase().replace(/\s+/g, '-');
    return trimmed.replace(/[^\p{L}\p{N}\-_.~]/gu, '');
  } catch {
    return slugify(String(s), { lower: true, strict: true });
  }
}

async function captureHTML(page, url, selector) {
  await page.goto(url, { waitUntil: ['networkidle2', 'domcontentloaded'] });
  // give sliders a tick
  await page.waitForTimeout(1000);
  const exists = await page.$(selector);
  if (!exists) {
    return await page.content();
  }
  const html = await page.$eval(selector, (el) => el.outerHTML);
  return html;
}

function cleanCapturedHTML(html) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Remove external CSS/JS that the theme will enqueue
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = ($(el).attr('href') || '').toLowerCase();
    if (href.includes('font-awesome') || href.includes('bootstrap') || href.includes('owl')) $(el).remove();
  });
  $('script[src]').each((_, el) => {
    const src = ($(el).attr('src') || '').toLowerCase();
    if (src.includes('jquery') || src.includes('owl') || src.includes('bootstrap')) $(el).remove();
  });

  // Hide/remove stray icon code spans inside <i class="fa|glyphicon">
  $('i.fa > span, i.glyphicon > span').remove();

  // Remove noscript images that duplicate sliders
  $('noscript').remove();

  // Unwrap <html>, <head>, <body> if present
  $('html > head').remove();
  const body = $('html > body');
  if (body.length) return body.html() || '';

  return $.root().html() || '';
}

async function writeTheme(themeDir, cfg) {
  const assetsDir = path.join(themeDir, 'assets');
  await fs.ensureDir(path.join(assetsDir, 'css'));
  await fs.ensureDir(path.join(assetsDir, 'js'));
  await fs.ensureDir(path.join(assetsDir, 'fonts'));

  // Basic theme files
  await fs.writeFile(path.join(themeDir, 'style.css'), theme_style_css(cfg), 'utf8');
  await fs.writeFile(path.join(themeDir, 'functions.php'), theme_functions_php(), 'utf8');
  await fs.writeFile(path.join(themeDir, 'header.php'), theme_header_php(), 'utf8');
  await fs.writeFile(path.join(themeDir, 'footer.php'), theme_footer_php(), 'utf8');
  await fs.writeFile(path.join(themeDir, 'index.php'), theme_index_php(), 'utf8');
  await fs.writeFile(path.join(themeDir, 'front-page.php'), theme_front_page_php(), 'utf8');
  await fs.writeFile(path.join(themeDir, 'page.php'), theme_page_php(), 'utf8');
}

async function prepareLocalAssets(themeDir) {
  const base = path.join(themeDir, 'assets');
  const cssDir = path.join(base, 'css');
  const jsDir = path.join(base, 'js');
  const fontsDir = path.join(base, 'fonts');

  const files = [
    // CSS
    { dest: path.join(cssDir, 'font-awesome.min.css'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css'
    ]},
    { dest: path.join(cssDir, 'bootstrap.min.css'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1/css/bootstrap.min.css'
    ]},
    { dest: path.join(cssDir, 'owl.carousel.min.css'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/owl-carousel/1.3.3/owl.carousel.min.css'
    ]},
    { dest: path.join(cssDir, 'owl.theme.min.css'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/owl-carousel/1.3.3/owl.theme.min.css'
    ]},
    // JS
    { dest: path.join(jsDir, 'owl.carousel.min.js'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/owl-carousel/1.3.3/owl.carousel.min.js'
    ]},
    // FA fonts
    { dest: path.join(fontsDir, 'fontawesome-webfont.eot'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.eot'
    ]},
    { dest: path.join(fontsDir, 'fontawesome-webfont.woff2'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.woff2'
    ]},
    { dest: path.join(fontsDir, 'fontawesome-webfont.woff'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.woff'
    ]},
    { dest: path.join(fontsDir, 'fontawesome-webfont.ttf'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.ttf'
    ]},
    { dest: path.join(fontsDir, 'fontawesome-webfont.svg'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.svg'
    ]},
    // Glyphicons
    { dest: path.join(fontsDir, 'glyphicons-halflings-regular.eot'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1/fonts/glyphicons-halflings-regular.eot'
    ]},
    { dest: path.join(fontsDir, 'glyphicons-halflings-regular.woff2'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1/fonts/glyphicons-halflings-regular.woff2'
    ]},
    { dest: path.join(fontsDir, 'glyphicons-halflings-regular.woff'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1/fonts/glyphicons-halflings-regular.woff'
    ]},
    { dest: path.join(fontsDir, 'glyphicons-halflings-regular.ttf'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1/fonts/glyphicons-halflings-regular.ttf'
    ]},
    { dest: path.join(fontsDir, 'glyphicons-halflings-regular.svg'), srcs: [
      'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/3.4.1/fonts/glyphicons-halflings-regular.svg'
    ]}
  ];

  for (const f of files) {
    await fs.ensureDir(path.dirname(f.dest));
    let ok = false;
    for (const url of f.srcs) {
      try {
        const res = await fetch(url, { timeout: 45000 });
        if (!res.ok) continue;
        const buf = await res.buffer();
        await fs.writeFile(f.dest, buf);
        console.log(`[assets] ${path.basename(f.dest)} OK`);
        ok = true;
        break;
      } catch {}
    }
    if (!ok) console.warn(`[assets] FAILED ${path.basename(f.dest)} (will rely on CDN fallback in repair plugin if needed)`);
  }
}

function buildWXR(cfg, items) {
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const wpns = {
    wxrVersion: '1.2',
    baseBlogUrl: cfg.site.origin
  };

  const itemsXML = items.map((p, i) => {
    const id = 1000 + i;
    const title = he.encode(p.title || '');
    const slug = p.slug || `page-${id}`;
    const content = `<![CDATA[${p.content}]]>`;
    return `
  <item>
    <title>${title}</title>
    <link>${cfg.site.origin}/${encodeURI(slug)}/</link>
    <pubDate>${new Date().toUTCString()}</pubDate>
    <dc:creator><![CDATA[admin]]></dc:creator>
    <guid isPermaLink="false">${uuidv4()}</guid>
    <description></description>
    <content:encoded>${content}</content:encoded>
    <excerpt:encoded><![CDATA[]]></excerpt:encoded>
    <wp:post_id>${id}</wp:post_id>
    <wp:post_date>${now}</wp:post_date>
    <wp:post_date_gmt>${now}</wp:post_date_gmt>
    <wp:comment_status>closed</wp:comment_status>
    <wp:ping_status>closed</wp:ping_status>
    <wp:post_name>${slug}</wp:post_name>
    <wp:status>publish</wp:status>
    <wp:post_parent>0</wp:post_parent>
    <wp:menu_order>${i}</wp:menu_order>
    <wp:post_type>page</wp:post_type>
    <wp:post_password></wp:post_password>
    <wp:is_sticky>0</wp:is_sticky>
  </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
 xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
 xmlns:content="http://purl.org/rss/1.0/modules/content/"
 xmlns:wfw="http://wellformedweb.org/CommentAPI/"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:wp="http://wordpress.org/export/1.2/"
>
<channel>
  <title>${he.encode(cfg.site.brand || 'Mirror')}</title>
  <link>${cfg.site.origin}</link>
  <description>Exported by Teashop Archiver</description>
  <pubDate>${new Date().toUTCString()}</pubDate>
  <language>bg</language>
  <wp:wxr_version>${wpns.wxrVersion}</wp:wxr_version>
  <wp:base_site_url>${cfg.site.origin}</wp:base_site_url>
  <wp:base_blog_url>${wpns.baseBlogUrl}</wp:base_blog_url>
${itemsXML}
</channel>
</rss>`;
}

async function scrapeProducts(cfg) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(90000);

  const selectors = cfg.scrapeProducts.selectors;
  const seen = new Set();
  const productUrls = [];

  for (const catUrl of cfg.scrapeProducts.categoryUrls) {
    console.log(`[products] listing: ${catUrl}`);
    await page.goto(catUrl, { waitUntil: ['networkidle2', 'domcontentloaded'] });
    await page.waitForTimeout(1000);
    const links = await page.$$eval(selectors['list.productLink'], els => els.map(a => a.href));
    for (const link of links) {
      if (!seen.has(link)) {
        seen.add(link);
        productUrls.push(link);
      }
    }
    if (productUrls.length >= cfg.scrapeProducts.maxProducts) break;
  }

  const rows = [];
  const max = Math.min(productUrls.length, cfg.scrapeProducts.maxProducts);
  for (let i = 0; i < max; i++) {
    const url = productUrls[i];
    try {
      console.log(`[products] item ${i + 1}/${max}: ${url}`);
      await page.goto(url, { waitUntil: ['networkidle2', 'domcontentloaded'] });
      await page.waitForTimeout(800);

      const html = await page.content();
      const $ = cheerio.load(html);

      const title = ($(selectors['product.title']).first().text() || '').trim() || `Product ${i + 1}`;
      let priceRaw = ($(selectors['product.price']).first().text() || '').replace(/[^\d.,]/g, '').replace(',', '.').trim();
      const price = priceRaw && !isNaN(parseFloat(priceRaw)) ? parseFloat(priceRaw) : '';
      const desc = ($(selectors['product.description']).first().html() || '').trim();
      const images = [];
      $(selectors['product.images']).each((_, a) => {
        const href = $(a).attr('href') || $(a).attr('data-large') || $(a).attr('data-image') || '';
        if (href) images.push(href);
      });

      rows.push({
        Name: title,
        Type: 'simple',
        Published: 1,
        'Regular price': price,
        'Sale price': '',
        'Categories': '',
        'Images': images.filter(Boolean).join(','),
        'Description': desc,
        'Short description': '',
        'SKU': '',
        'Visibility in catalog': 'visible'
      });
    } catch (e) {
      console.warn('[products] FAILED', url, e.message);
    }
  }

  await browser.close();
  return rows;
}

async function writeWooCSV(file, rows) {
  const headers = [
    'Name', 'Type', 'Published', 'Regular price', 'Sale price', 'Categories',
    'Images', 'Description', 'Short description', 'SKU', 'Visibility in catalog'
  ];
  return new Promise((resolve, reject) => {
    const s = stringify(rows, { header: true, columns: headers });
    const ws = fs.createWriteStream(file);
    s.pipe(ws);
    s.on('error', reject);
    ws.on('finish', resolve);
  });
}

async function zipFolder(srcDir, zipPath) {
  await fs.ensureDir(path.dirname(zipPath));
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize();
  });
}

/* ------------------- theme file templates ------------------- */

function theme_style_css(cfg) {
  const name = cfg.site.brand || 'Mirror Theme';
  return `/*
Theme Name: ${name}
Theme URI: ${cfg.site.origin}
Author: Mirror
Description: Generated theme that mirrors ${cfg.site.origin}
Version: 1.0.0
Text Domain: ${cfg.site.themeSlug || 'mirror-theme'}
*/
html, body { margin:0; padding:0; }
.fa > span, .glyphicon > span { display:none !important; }
`;
}

function theme_functions_php() {
  return `<?php
if (!defined('ABSPATH')) { exit; }

add_action('after_setup_theme', function () {
  add_theme_support('title-tag');
  add_theme_support('woocommerce');
});

add_action('wp_enqueue_scripts', function () {
  // Remove WP global styles that may interfere
  wp_dequeue_style('wp-block-library');
  wp_dequeue_style('wp-block-library-theme');
  wp_dequeue_style('global-styles');
  wp_dequeue_style('classic-theme-styles');
}, 20);

add_filter('woocommerce_enqueue_styles', function ($styles) {
  if (is_front_page()) { return []; }
  return $styles;
});

add_action('wp_enqueue_scripts', function () {
  if (!is_front_page()) return;

  $uri = get_stylesheet_directory_uri();
  wp_enqueue_script('jquery');

  // Local assets
  wp_enqueue_style('tm-fa4', $uri . '/assets/css/font-awesome.min.css', [], '4.7.0');
  wp_enqueue_style('tm-bs3', $uri . '/assets/css/bootstrap.min.css', [], '3.4.1');
  wp_enqueue_style('tm-owl', $uri . '/assets/css/owl.carousel.min.css', [], '1.3.3');
  wp_enqueue_style('tm-owl-theme', $uri . '/assets/css/owl.theme.min.css', ['tm-owl'], '1.3.3');
  wp_enqueue_script('tm-owl', $uri . '/assets/js/owl.carousel.min.js', ['jquery'], '1.3.3', true);

  $css = '
    .entry-title, .page-title, .wp-block-post-title { display:none !important; }
    #slideshow0 { opacity:1 !important; }
  ';
  wp_register_style('tm-inline', false, [], null);
  wp_enqueue_style('tm-inline');
  wp_add_inline_style('tm-inline', $css);

  $js = <<<JS
  jQuery(function($){
    function rebuildIfWrapped($s){
      var $wrappedItems = $s.find('.owl-wrapper-outer .owl-wrapper .owl-item .item');
      if ($wrappedItems.length){
        var items = [];
        $wrappedItems.each(function(){ items.push($(this).clone(true)); });
        $s.empty();
        for (var i=0;i<items.length;i++){ $s.append(items[i]); }
      }
    }
    var tries = 0, maxTries = 20;
    (function start(){
      var $s = $('#slideshow0');
      if (!$s.length){ if(++tries<maxTries) return setTimeout(start,250); else return; }
      if (typeof $.fn.owlCarousel !== 'function'){ if(++tries<maxTries) return setTimeout(start,250); else return; }
      if ($s.data('owlCarousel')){ $s.trigger('owl.play', 4000); return; }
      rebuildIfWrapped($s);
      try{
        $s.owlCarousel({
          items:1,
          singleItem:true,
          autoPlay:4000,
          slideSpeed:600,
          stopOnHover:true,
          pagination:true,
          navigation:true,
          navigationText:["<i class='fa fa-chevron-left'></i>","<i class='fa fa-chevron-right'></i>"]
        });
      }catch(e){}
    })();
  });
JS;
  wp_add_inline_script('tm-owl', $js, 'after');
}, 30);
`;
}

function theme_header_php() {
  return `<?php if (!defined('ABSPATH')) { exit; } ?>
<!doctype html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo('charset'); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
`;
}

function theme_footer_php() {
  return `<?php if (!defined('ABSPATH')) { exit; } ?>
<?php wp_footer(); ?>
</body>
</html>
`;
}

function theme_index_php() {
  return `<?php
if (!defined('ABSPATH')) { exit; }
get_header();
if (have_posts()) :
  while (have_posts()) : the_post();
    the_content();
  endwhile;
endif;
get_footer();
`;
}

function theme_front_page_php() {
  return `<?php
if (!defined('ABSPATH')) { exit; }
get_header();
while (have_posts()) : the_post();
  the_content();
endwhile;
get_footer();
`;
}

function theme_page_php() {
  return `<?php
if (!defined('ABSPATH')) { exit; }
get_header();
while (have_posts()) : the_post();
  the_content();
endwhile;
get_footer();
`;
}
