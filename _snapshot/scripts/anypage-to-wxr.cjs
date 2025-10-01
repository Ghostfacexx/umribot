#!/usr/bin/env node
/**
 * Any HTML → WXR with:
 * - Pixel-accurate CSS/JS via _anypage_* post meta (use anypage-skin MU plugin).
 * - Product + page link rewrites.
 * - Product-card grid rewrites using cart.add('ID').
 * - Guard to avoid rewriting generic /index.php to a local page.
 *
 * Requires: npm i transliteration cheerio
 */
const fs=require('fs');
const path=require('path');
const cheerio=require('cheerio');
const { URL }=require('url');
const { slugify: tslug } = require('transliteration');

function parseArgs(argv){const a={};for(let i=2;i<argv.length;i++){const k=argv[i];if(k.startsWith('--')){const n=k.slice(2);const v=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true;a[n]=v;}}return a;}
const args=parseArgs(process.argv);

const INPUT=args.in||args.input;
const OUT=args.out||'out/pages-any.wxr';
const SITE_URL=(args['site-url']||'https://example.com').replace(/\/+$/,'');
const AUTHOR=args.author||'admin';
const BASE_URL=args['base-url']||'';
const VERBOSE=!!args.verbose;

const PREFER=(args['prefer-profile']||'').toLowerCase();
const MODE=(args.mode||'folder').toLowerCase();
const PATH_HIERARCHY=!!args['path-hierarchy'];
const SLUG_SOURCE=(args['slug-source']||'title').toLowerCase();
const HOME_TITLE=args['home-title']||'';
const ALLOW_TITLE_ONLY=!!args['allow-title-only'];
const MAX_ATTACH=Math.max(0,Number(args['max-attachments']||8));
const MIN_CONTENT_CHARS=Number(args['min-content-chars']||40);

const REWRITE_INTERNAL_LINKS=!!args['rewrite-internal-links'];
const PRODUCT_BASE=(args['product-base']||'/product').replace(/\/+$/,'');
const PRODUCT_MAP_PATH=args['product-map']||'';
const DEBUG_REWRITES=!!args['debug-rewrites'];

const includeRe=args['include-path-regex']?new RegExp(args['include-path-regex']):null;
const excludeRe=args['exclude-path-regex']?new RegExp(args['exclude-path-regex']):null;

if(!INPUT){console.error('Error: --in <file-or-dir> is required');process.exit(1);}

// Helpers
function walk(root){const out=[];function rec(p){const st=fs.statSync(p);if(st.isDirectory()){for(const n of fs.readdirSync(p))rec(path.join(p,n));}else if(st.isFile()&&/\.html?$/i.test(p)){out.push(p);}}rec(root);return out;}
function normalizeSpaces(s){return s?s.replace(/\s+/g,' ').trim():'';}
function xmlEscape(s){if(s==null)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}
function cdata(s){if(s==null)return'<![CDATA[]]>';return `<![CDATA[${String(s).replace(/\]\]>/g,']]]]><![CDATA[>')}]]>`;}
function absolutize(u,base){if(!u)return'';try{return new URL(u).toString();}catch{try{return new URL(u,base).toString();}catch{return u;}}}
function hostOf(u){try{return new URL(u).host.toLowerCase();}catch{return'';}}
function baseFor($,fb){const b=$('base').attr('href')||$('link[rel="canonical"]').attr('href')||$('meta[property="og:url"]').attr('content')||fb||'';try{return b?new URL(b).toString():'';}catch{return fb||'';}}
function collapseProfiles(rel){return rel.replace(/\/(desktop|mobile)(?=\/|$)/ig,'');}
function pathKeyForFile(abs){let rel=path.relative(INPUT,abs).replace(/\\/g,'/');rel=rel.replace(/\/index\.html?$/i,'');rel=collapseProfiles(rel);rel=rel.replace(/\.html?$/i,'');rel=rel.replace(/\/+$/,'').replace(/^\/+/,'');if(rel===''||rel==='.'||/^index$/i.test(rel))return'home';return rel;}
function parentKeyOf(key){if(!PATH_HIERARCHY||key==='home')return'';const p=key.split('/').slice(0,-1).join('/');return p||'';}
function depthOf(key){if(!PATH_HIERARCHY||key==='home')return 0;return key.split('/').length;}
function preferProfile(oldp,newp){const od=/\/desktop(\/|$)/i.test(oldp), nd=/\/desktop(\/|$)/i.test(newp), om=/\/mobile(\/|$)/i.test(oldp), nm=/\/mobile(\/|$)/i.test(newp);if(PREFER==='desktop')return nd&&!od;if(PREFER==='mobile')return nm&&!om;return false;}
function slugifyBG(s){return tslug(String(s||'').replace(/\u00A0/g,' ').trim(),{lowercase:true,separator:'-',trim:true})||'page';}

// HTML selection/cleanup
const CONTENT_SELECTOR=args['content-selector']||"#content, main .entry-content, article .entry-content, main, article, .post-content, .entry-content, .content, .container #content, .container, body";
const STRIP_SELECTORS=(args['strip-selectors']||"script, noscript, iframe[title='Google analytics'], .cookie, .cookies, .cookie-notice, .gdpr, .newsletter, .popup, .modal, .offcanvas, .ads, .advert, .ad, #comments, .comments, nav.breadcrumbs .pagination").split(',').map(s=>s.trim()).filter(Boolean);

function pickContainer($){for(const sel of CONTENT_SELECTOR.split(',').map(s=>s.trim()).filter(Boolean)){if($(sel).length)return sel;}return 'body';}
function cleanAndFixContent($,container,base){
  const c=$(container).first().clone();
  c.find('img').each((_,img)=>{const $i=$(img);if(!$i.attr('src')){$i.attr('src',$i.attr('data-src')||$i.attr('data-lazy')||$i.attr('data-original')||$i.attr('data-srcset')||'');}const src=$i.attr('src');if(src)$i.attr('src',absolutize(src,base));const ss=$i.attr('srcset');if(ss){const fixed=ss.split(',').map(s=>{const [u,d]=s.trim().split(/\s+/);return [absolutize(u,base),d].filter(Boolean).join(' ')}).join(', ');$i.attr('srcset',fixed);}});
  c.find('a[href]').each((_,a)=>{const $a=$(a);const href=$a.attr('href');if(href)$a.attr('href',absolutize(href,base));});
  STRIP_SELECTORS.forEach(sel=>c.find(sel).remove());
  return c.html()||'';
}
function pageFromFile(abs){
  const html=fs.readFileSync(abs,'utf8');
  const $=cheerio.load(html,{decodeEntities:false});
  const base=baseFor($,BASE_URL);
  const containerSel=pickContainer($);
  const contentHtml=cleanAndFixContent($,containerSel,base);
  let title=normalizeSpaces($('meta[property="og:title"]').attr('content'))||normalizeSpaces($('title').text())||normalizeSpaces($('h1').first().text())||'';
  // head assets
  const headStyles=[];$('link[rel="stylesheet"][href]').each((_,el)=>{const u=$(el).attr('href');if(u)headStyles.push(absolutize(u,base));});
  let inlineCss='';$('style').each((_,el)=>{const css=$(el).html();if(css&&String(css).trim())inlineCss+=css+"\n";});
  const deny=/(google-analytics|googletagmanager|gtag\/js|fb(|-)|connect\.facebook|hotjar|clarity|recaptcha|gstatic|intercom|livereload)/i;
  const headScripts=[];$('script[src]').each((_,el)=>{const u=$(el).attr('src');if(!u)return;const abs=absolutize(u,base);if(!deny.test(abs))headScripts.push(abs);});
  return { $, base, title, contentHtml, headStyles, inlineCss, headScripts };
}

// Load product map
function loadProductMap(p){if(!p)return{};if(!fs.existsSync(p)){console.warn(`Warning: --product-map not found: ${p}`);return{};}try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){console.warn(`Warning: cannot parse product map: ${e.message}`);return{};}}
const productMap=loadProductMap(PRODUCT_MAP_PATH);
if (VERBOSE) console.log(`[ProductMap] loaded ${Object.keys(productMap).length} entries from ${PRODUCT_MAP_PATH||'(none)'}`);

// URL mappers
function productSlugFromUrl(href){
  try{const u=new URL(href,BASE_URL||'http://local/');const route=u.searchParams.get('route')||'';const pid=u.searchParams.get('product_id')||u.searchParams.get('productId')||'';if(/product\/product/i.test(route)&&pid&&productMap[pid])return productMap[pid];}catch{}return null;
}
function keyFromUrlLike(uStr){
  try{
    const u=new URL(uStr,BASE_URL||'http://local/');
    const baseHost=BASE_URL?new URL(BASE_URL).host.toLowerCase():'';
    const same=!/^https?:/i.test(uStr)||(baseHost&&u.host.toLowerCase()===baseHost);
    if(!same) return null;

    // Guard: generic /index.php without route -> leave as is (do NOT rewrite to a page)
    if (/\/index\.php$/i.test(u.pathname) && !u.searchParams.get('route')) return null;

    let p=u.pathname||'/';
    if(p==='/'||/^\/index(\.html?)?$/i.test(p)) return 'home';
    p=p.replace(/^\/+|\/+$/g,'');
    p=collapseProfiles('/'+p).replace(/^\/+/,'').replace(/\/index$/i,'');
    return p||'home';
  }catch{return null;}
}
function rewriteProductCards($c){
  $c('[class*="product-thumb"],[class*="product-layout"],[class*="product-grid"]').each((_,card)=>{
    const $card=$c(card);
    let pid='';
    $card.find('[onclick]').each((__,el)=>{const on=String($c(el).attr('onclick')||'');const m=on.match(/cart\.add\(['"](\d+)['"]/i);if(m){pid=m[1];return false;}});
    if(!pid){const d=$card.attr('data-product-id')||$card.find('[data-product-id]').attr('data-product-id')||'';if(d)pid=String(d).trim();}
    if(!pid) return;
    const slug=productMap[pid]; if(!slug) return;
    $card.find('a[href]').each((__,a)=>{
      const $a=$c(a);const href=$a.attr('href')||'';
      const isExternal=/^https?:\/\//i.test(href)&&BASE_URL&&hostOf(href)!==hostOf(BASE_URL);
      if(isExternal) return;
      // Avoid re-rewriting Woo product links
      if(new RegExp(`^${PRODUCT_BASE.replace(/\//g,'\\/')}\\/`,'i').test(href)) return;
      const newHref=`${PRODUCT_BASE}/${slug}/`;
      if(DEBUG_REWRITES) console.log(`REWRITE card: ${href} -> ${newHref}`);
      $a.attr('href',newHref);
    });
  });
}

// XML
function postmetaXml(k,v){return ['<wp:postmeta>',`<wp:meta_key>${k}</wp:meta_key>`,`<wp:meta_value><![CDATA[${v||''}]]></wp:meta_value>`,'</wp:postmeta>'].join('');}
function pageItemXml(p,ids,thumbId,dates,site,author){
  const link=`${site}/?page_id=${ids.post}`;
  const parts=[
    `<title>${cdata(p.title)}</title>`,`<link>${xmlEscape(link)}</link>`,`<pubDate>${xmlEscape(dates.rfc2822)}</pubDate>`,`<dc:creator>${cdata(author)}</dc:creator>`,
    `<guid isPermaLink="false">${xmlEscape(`page-${ids.post}`)}</guid>`,`<description></description>`,
    `<content:encoded>${cdata(p.contentHtml)}</content:encoded>`,`<excerpt:encoded>${cdata(p.excerptHtml||'')}</excerpt:encoded>`,
    `<wp:post_id>${ids.post}</wp:post_id>`,`<wp:post_date>${xmlEscape(dates.local)}</wp:post_date>`,`<wp:post_date_gmt>${xmlEscape(dates.gmt)}</wp:post_date_gmt>`,
    `<wp:comment_status>closed</wp:comment_status>`,`<wp:ping_status>closed</wp:ping_status>`,`<wp:post_name>${xmlEscape(p.slug)}</wp:post_name>`,
    `<wp:status>publish</wp:status>`,`<wp:post_parent>${ids.parent}</wp:post_parent>`,`<wp:menu_order>${ids.menuOrder||0}</wp:menu_order>`,`<wp:post_type>page</wp:post_type>`,
    `<wp:post_password></wp:post_password>`,`<wp:is_sticky>0</wp:is_sticky>`,
    thumbId?postmetaXml('_thumbnail_id',String(thumbId)):'',
    postmetaXml('_anypage_layout_reset','1'),
    postmetaXml('_anypage_styles',JSON.stringify(p._anypage_styles||[])),
    postmetaXml('_anypage_inline_css',p._anypage_inline_css||''),
    postmetaXml('_anypage_scripts',JSON.stringify(p._anypage_scripts||[]))
  ];
  return `<item>${parts.join('')}</item>`;
}
function attachmentItemXml(url,attId,parentId,dates,site,author){
  const fileName=(url.split('/').pop()||'image').split('?')[0];
  const title=fileName.replace(/\.[a-z0-9]+$/i,'');
  const link=`${site}/?attachment_id=${attId}`;
  const parts=[
    `<title>${cdata(title)}</title>`,`<link>${xmlEscape(link)}</link>`,`<pubDate>${xmlEscape(dates.rfc2822)}</pubDate>`,`<dc:creator>${cdata(author)}</dc:creator>`,
    `<guid isPermaLink="false">${xmlEscape(`attachment-${attId}`)}</guid>`,`<description></description>`,`<content:encoded><![CDATA[]]></content:encoded>`,`<excerpt:encoded><![CDATA[]]></excerpt:encoded>`,
    `<wp:post_id>${attId}</wp:post_id>`,`<wp:post_date>${xmlEscape(dates.local)}</wp:post_date>`,`<wp:post_date_gmt>${xmlEscape(dates.gmt)}</wp:post_date_gmt>`,
    `<wp:comment_status>closed</wp:comment_status>`,`<wp:ping_status>closed</wp:ping_status>`,`<wp:post_name>${xmlEscape(slugifyBG(title))}</wp:post_name>`,
    `<wp:status>inherit</wp:status>`,`<wp:post_parent>${parentId}</wp:post_parent>`,`<wp:menu_order>0</wp:menu_order>`,`<wp:post_type>attachment</wp:post_type>`,
    `<wp:post_password></wp:post_password>`,`<wp:is_sticky>0</wp:is_sticky>`,`<wp:attachment_url>${xmlEscape(url)}</wp:attachment_url>`
  ];
  return `<item>${parts.join('')}</item>`;
}
function nowDates(){const d=new Date();const pad=n=>String(n).padStart(2,'0');const local=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;const g=new Date(d.getTime()-d.getTimezoneOffset()*60000);const gLocal=`${g.getFullYear()}-${pad(g.getMonth()+1)}-${pad(g.getDate())} ${pad(g.getHours())}:${pad(g.getMinutes())}:${pad(g.getSeconds())}`;return{local,gmt:gLocal,rfc2822:d.toUTCString()};}

// Parse files
const files=walk(INPUT);
const buckets=new Map();
for(const f of files){
  if(PREFER==='desktop' && /\/mobile\//i.test(f)){if(VERBOSE)console.log(`SKIP profile mobile: ${f}`);continue;}
  if(PREFER==='mobile' && /\/desktop\//i.test(f)){if(VERBOSE)console.log(`SKIP profile desktop: ${f}`);continue;}
  if(MODE==='folder' && !/\/index\.html?$/i.test(f)) continue;
  const key=pathKeyForFile(f);
  if(includeRe && !includeRe.test(key)){if(VERBOSE)console.log(`SKIP include filter: ${key}`);continue;}
  if(excludeRe && excludeRe.test(key)){if(VERBOSE)console.log(`SKIP exclude filter: ${key}`);continue;}
  const ex=buckets.get(key);
  if(!ex) buckets.set(key,f); else if(preferProfile(ex,f)) buckets.set(key,f);
}
if(!buckets.size){console.error('No candidate pages found.');process.exit(2);}

// Build nodes
const nodes=new Map();
const slugByKey=new Map();
for(const [key,file] of buckets.entries()){
  const { $, base, title:t0, contentHtml, headStyles, inlineCss, headScripts }=pageFromFile(file);
  let title=t0|| (key.split('/').pop()||'Page').replace(/[-_]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
  if(key==='home'&&HOME_TITLE) title=HOME_TITLE;
  const slug = (SLUG_SOURCE==='key')? slugifyBG(key==='home'?'home':key) : slugifyBG(title);
  slugByKey.set(key,slug);
  nodes.set(key,{key,file,depth:depthOf(key),parentKey:parentKeyOf(key),base,title,contentHtml,headStyles,inlineCss,headScripts});
  if(VERBOSE) console.log(`PAGE: ${file} -> key=${key} title=${title}`);
}

// Rewrite links
if(REWRITE_INTERNAL_LINKS){
  for(const node of nodes.values()){
    const $c=cheerio.load(`<div id="__c">${node.contentHtml}</div>`,{decodeEntities:false});
    // Rewrite grids to product URLs
    rewriteProductCards($c);
    // Anchor-by-anchor
    $c('#__c a[href]').each((_,a)=>{
      const $a=$c(a);const href=$a.attr('href');if(!href) return;
      const prodSlug=productSlugFromUrl(href);
      if(prodSlug){const newHref=`${PRODUCT_BASE}/${prodSlug}/`;if(DEBUG_REWRITES)console.log(`REWRITE product: ${href} -> ${newHref}`);$a.attr('href',newHref);return;}
      const k=keyFromUrlLike(href);
      if(k && slugByKey.has(k)){const newHref=`/${slugByKey.get(k)}/`;if(DEBUG_REWRITES)console.log(`REWRITE page: ${href} -> ${newHref}`);$a.attr('href',newHref);}
    });
    node.contentHtml=$c('#__c').html()||node.contentHtml;
  }
}

// Emit WXR
let nextId=80000;
const idByKey=new Map();
const items=[];
const dates=nowDates();

if(PATH_HIERARCHY){
  const sortedKeys=Array.from(nodes.keys()).sort((a,b)=>nodes.get(a).depth-nodes.get(b).depth);
  for(const key of sortedKeys){
    const parent=parentKeyOf(key); if(!parent) continue;
    if(!idByKey.has(parent) && !nodes.has(parent)){
      const stubTitle=(parent.split('/').pop()||'Page').replace(/[-_]+/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
      const stubSlug=(SLUG_SOURCE==='key')?slugifyBG(parent):slugifyBG(stubTitle);
      const pid=nextId++; idByKey.set(parent,pid);
      const stub={title:stubTitle,slug:stubSlug,contentHtml:'',excerptHtml:'',_anypage_styles:[],_anypage_inline_css:'',_anypage_scripts:[]};
      items.push(pageItemXml(stub,{post:pid,parent:0,menuOrder:parent.split('/').length-1},null,dates,SITE_URL,AUTHOR));
      if(VERBOSE) console.log(`STUB: created for ${parent} id=${pid}`);
    }
  }
}

for(const node of Array.from(nodes.values()).sort((a,b)=>a.depth-b.depth)){
  const postId=nextId++; idByKey.set(node.key,postId);
  let parent=0; if(PATH_HIERARCHY){const p=parentKeyOf(node.key); if(p) parent=idByKey.get(p)||0;}
  // Attachments
  const imgs=new Set(); const $img=cheerio.load(`<div id="__c">${node.contentHtml}</div>`,{decodeEntities:false});
  $img('#__c img[src]').each((_,img)=>{const u=$img(img).attr('src');if(u)imgs.add(u);});
  const images=Array.from(imgs).filter(u=>/^https?:\/\//i.test(u)).slice(0,MAX_ATTACH);
  if(!ALLOW_TITLE_ONLY){const txt=normalizeSpaces($img('#__c').text()).length;if(!node.contentHtml||txt<MIN_CONTENT_CHARS){if(VERBOSE)console.log(`SKIP (too little content): key=${node.key} file=${node.file}`);continue;}}
  let thumb=null; images.forEach((u,i)=>{const attId=nextId++; if(i===0) thumb=attId; items.push(attachmentItemXml(u,attId,postId,dates,SITE_URL,AUTHOR));});
  const page={title:node.title,slug:(SLUG_SOURCE==='key')?slugifyBG(node.key==='home'?'home':node.key):slugifyBG(node.title),contentHtml:node.contentHtml,excerptHtml:'',_anypage_styles:node.headStyles||[],_anypage_inline_css:node.inlineCss||'',_anypage_scripts:node.headScripts||[]};
  items.push(pageItemXml(page,{post:postId,parent,menuOrder:node.depth},thumb,dates,SITE_URL,AUTHOR));
}

const header=`<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0"
  xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:wfw="http://wellformedweb.org/CommentAPI/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:wp="http://wordpress.org/export/1.2/"
>
<channel>
  <title><![CDATA[Pages Import (AnyPage)]]></title>
  <link>${xmlEscape(SITE_URL)}</link>
  <description><![CDATA[Generated from mirrored HTML]]></description>
  <pubDate>${xmlEscape(dates.rfc2822)}</pubDate>
  <language>bg</language>
  <wp:wxr_version>1.2</wp:wxr_version>
  <wp:base_site_url>${xmlEscape(SITE_URL)}</wp:base_site_url>
  <wp:base_blog_url>${xmlEscape(SITE_URL)}</wp:base_blog_url>
`;
const footer=`
</channel>
</rss>`;
fs.mkdirSync(path.dirname(OUT),{recursive:true});
fs.writeFileSync(OUT,header+items.join('\n')+footer,'utf8');
const pageCount=items.filter(s=>s.includes('<wp:post_type>page</wp:post_type>')).length;
console.log(`\nWrote ${pageCount} pages (plus attachments) to ${OUT}`);