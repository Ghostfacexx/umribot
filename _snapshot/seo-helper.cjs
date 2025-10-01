/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

let cheerio;
try { cheerio = require('cheerio'); } catch (_) {
  console.warn('[seo-helper] Optional dependency "cheerio" not found. Install with: npm i cheerio');
}

/**
 * Lightweight SEO Analyzer + Learner + Applicator for CJS projects.
 * - analyzePage(html, url, ctx) -> { score, details, features, category, tags }
 * - learnFromRun(runSummary) -> updates knowledge DB with high-scoring patterns
 * - maybeImprove(html, url, ctx, opts) -> { html, applied, reason, suggestions }
 */

const DEFAULT_CONFIG = {
  threshold: 8.0,
  knowledgePath: path.resolve(process.cwd(), 'seo_knowledge.json'),
  minHighScoreForLearning: 8.5,
  minPagesPerDomainForLearning: 3,
  maxTokensForBodySampling: 3000,
  categorySimilarityThreshold: 0.2,
  scoringWeights: {
    title: 1.0,
    description: 1.0,
    canonical: 1.0,
    h1: 1.0,
    headingsHierarchy: 0.5,
    imageAltCoverage: 1.0,
    internalLinks: 1.0,
    ogTags: 0.5,
    twitterTags: 0.5,
    jsonLd: 1.0,
    hreflang: 0.5
  },
  targetRanges: {
    titleLength: { min: 40, max: 60 },
    descriptionLength: { min: 110, max: 160 },
    imageAltCoverageMin: 0.9,
    internalLinksMin: 20
  },
  safeTransforms: {
    canonical: true,
    metaDescription: true,
    ogTwitter: true,
    jsonLdWebsite: true,
    enforceSingleH1: true,
    fillMissingImageAlt: true
  }
};

const STOPWORDS = new Set([
  'the','and','for','you','your','with','from','that','this','are','was','were','have','has','had',
  'but','not','can','will','would','could','should','about','into','over','under','then','than',
  'in','on','at','of','to','by','or','as','it','its','is','be','we','our','they','their','a','an'
]);

const CATEGORY_LEXICON = {
  electronics: ['electronics','phone','smartphone','laptop','tablet','camera','tv','television','headphones','audio','gpu','cpu','pc','console','charger','battery','screen','monitor','router'],
  cosmetics: ['cosmetic','cosmetics','beauty','skin','skincare','makeup','lipstick','foundation','fragrance','perfume','serum','moisturizer','haircare','nail','spa'],
  fashion: ['fashion','clothing','apparel','shoes','sneakers','dress','jeans','jacket','tshirt','bag','accessories'],
  grocery: ['grocery','food','beverage','snack','drink','organic','fresh','produce','dairy','meat'],
  software: ['software','saas','app','application','cloud','api','platform','download','install','release','docs','developer'],
  generic: []
};

function loadConfig(userConfig) {
  return { ...DEFAULT_CONFIG, ...(userConfig || {}), scoringWeights: { ...DEFAULT_CONFIG.scoringWeights, ...(userConfig?.scoringWeights || {}) }, targetRanges: { ...DEFAULT_CONFIG.targetRanges, ...(userConfig?.targetRanges || {}) }, safeTransforms: { ...DEFAULT_CONFIG.safeTransforms, ...(userConfig?.safeTransforms || {}) } };
}

function loadKnowledge(dbPath) {
  try {
    if (fs.existsSync(dbPath)) {
      return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    }
  } catch (e) {
    console.warn('[seo-helper] Failed to read knowledge DB:', e.message);
  }
  return { version: 1, lastUpdated: null, strategies: [] };
}

function saveKnowledge(dbPath, data) {
  try {
    fs.writeFileSync(dbPath, JSON.stringify({ ...data, lastUpdated: new Date().toISOString() }, null, 2), 'utf8');
  } catch (e) {
    console.warn('[seo-helper] Failed to write knowledge DB:', e.message);
  }
}

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s\-]/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length > 2 && !STOPWORDS.has(t));
}

function extractCategory(tokens) {
  const counts = {};
  for (const [cat, words] of Object.entries(CATEGORY_LEXICON)) {
    counts[cat] = words.reduce((acc, w) => acc + (tokens.includes(w) ? 1 : 0), 0);
  }
  const best = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
  if (!best || best[1] === 0) return 'generic';
  return best[0];
}

function jaccard(aArr, bArr) {
  const a = new Set(aArr);
  const b = new Set(bArr);
  const inter = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size || 1;
  return inter / union;
}

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./,''); } catch { return 'unknown'; }
}

function analyzeHtml(html, url, config) {
  const $ = cheerio ? cheerio.load(html) : null;

  const title = $ ? ($('head title').first().text() || '') : (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '');
  const metaDesc = $ ? ($('meta[name="description"]').attr('content') || '') : (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] || '');
  const canonicalHref = $ ? ($('link[rel="canonical"]').attr('href') || '') : (html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']*)["']/i)?.[1] || '');
  const ogTags = $ ? $('meta[property^="og:"]').length : (html.match(/<meta[^>]*property=["']og:/ig) || []).length;
  const twitterTags = $ ? $('meta[name^="twitter:"]').length : (html.match(/<meta[^>]*name=["']twitter:/ig) || []).length;
  const jsonLdBlocks = $ ? $('script[type="application/ld+json"]').map((_,el)=>$(el).text()).get() : (html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || []);
  let jsonLdTypes = [];
  try {
    jsonLdTypes = jsonLdBlocks.flatMap(txt => {
      try {
        const obj = JSON.parse(txt);
        const items = Array.isArray(obj) ? obj : [obj];
        return items.map(o => (typeof o === 'object' && o['@type']) ? String(o['@type']) : null).filter(Boolean);
      } catch { return []; }
    });
  } catch { jsonLdTypes = []; }

  let h1Count = 0, headingsOk = true;
  let internalLinks = 0, descriptiveAnchors = 0;
  let images = 0, imagesWithAlt = 0;
  if ($) {
    h1Count = $('h1').length;
    const headingLevels = $('h1,h2,h3,h4,h5,h6').map((_,el)=>Number(el.tagName.slice(1))).get();
    let last = 1;
    for (const lvl of headingLevels) {
      if (lvl - last > 1) { headingsOk = false; break; }
      last = lvl;
    }
    $('a[href]').each((_,el)=>{
      const href = $(el).attr('href') || '';
      const text = ($(el).text() || '').trim();
      try {
        const u = new URL(href, url);
        if (u.hostname.replace(/^www\./,'') === getDomain(url)) {
          internalLinks++;
          if (text && text.length > 2 && !/^click here|read more|learn more$/i.test(text)) descriptiveAnchors++;
        }
      } catch { /* ignore */ }
    });
    $('img').each((_,el)=>{
      images++;
      const alt = ($(el).attr('alt') || '').trim();
      if (alt) imagesWithAlt++;
    });
  }

  const bodySample = $ ? ($('h1,h2,h3,p,li').slice(0, 500).text() || '') : '';
  const tokens = tokenize([title, metaDesc, bodySample].join(' '));
  const category = extractCategory(tokens);
  const tags = Array.from(new Set(tokens)).slice(0, 100);

  const W = config.scoringWeights;
  const R = config.targetRanges;

  const titleScore = title.length ? (title.length >= R.titleLength.min && title.length <= R.titleLength.max ? 1 : 0.7) : 0;
  const descScore = metaDesc.length ? (metaDesc.length >= R.descriptionLength.min && metaDesc.length <= R.descriptionLength.max ? 1 : 0.7) : 0;
  let canonicalScore = 0;
  if (canonicalHref) {
    try {
      const u = new URL(canonicalHref, url);
      canonicalScore = (u.hostname.replace(/^www\./,'') === getDomain(url)) ? 1 : 0.7;
    } catch { canonicalScore = 0.5; }
  }
  const h1Score = h1Count === 1 ? 1 : (h1Count > 1 ? 0.3 : 0);
  const headingsScore = headingsOk ? 1 : 0.5;
  const altCoverage = images ? (imagesWithAlt / images) : 1;
  const altScore = altCoverage >= R.imageAltCoverageMin ? 1 : (altCoverage >= 0.6 ? 0.6 : 0.2);
  const internalLinkScore = internalLinks >= R.internalLinksMin ? 1 : (internalLinks >= 8 ? 0.6 : 0.3);
  const ogScore = ogTags > 0 ? 1 : 0;
  const twScore = twitterTags > 0 ? 1 : 0;
  const jsonLdScore = jsonLdTypes.length > 0 ? 1 : 0;
  const hreflangCount = $ ? $('link[rel="alternate"][hreflang]').length : 0;
  const hreflangScore = hreflangCount > 0 ? 1 : 0;

  const totalWeight = Object.values(W).reduce((a,b)=>a+b,0);
  const weighted = (
    W.title * titleScore +
    W.description * descScore +
    W.canonical * canonicalScore +
    W.h1 * h1Score +
    W.headingsHierarchy * headingsScore +
    W.imageAltCoverage * altScore +
    W.internalLinks * internalLinkScore +
    W.ogTags * ogScore +
    W.twitterTags * twScore +
    W.jsonLd * jsonLdScore +
    W.hreflang * hreflangScore
  );
  const score10 = Math.round((weighted / totalWeight) * 100) / 10; // 0..10 with 1 decimal

  return {
    url,
    domain: getDomain(url),
    score: score10,
    category,
    tags,
    features: {
      titleLength: title.length,
      descriptionLength: metaDesc.length,
      hasCanonical: !!canonicalHref,
      h1Count,
      headingsOk,
      imageAltCoverage: Math.round(altCoverage * 1000) / 1000,
      internalLinks,
      descriptiveAnchors,
      ogTags,
      twitterTags,
      jsonLdTypes,
      hreflangCount
    },
    details: {
      title,
      metaDesc,
      canonicalHref
    }
  };
}

function aggregateStrategies(pages, config) {
  const highs = pages.filter(p => p.score >= config.minHighScoreForLearning);
  if (highs.length === 0) return null;

  const freq = (arr, pred)=>arr.reduce((a,p)=>a + (pred(p)?1:0),0)/arr.length;
  const nums = (arr, sel)=>arr.map(sel).sort((a,b)=>a-b);
  const pct = (arr, q)=> {
    if (arr.length===0) return 0;
    const i = Math.floor(q*(arr.length-1));
    return arr[i];
  };

  const titleLengths = nums(highs, p => p.features.titleLength);
  const descLengths = nums(highs, p => p.features.descriptionLength);
  const altCovs = nums(highs, p => p.features.imageAltCoverage);
  const intLinks = nums(highs, p => p.features.internalLinks);

  const strategy = {
    category: mostCommon(highs.map(h => h.category)) || 'generic',
    minScoreObserved: Math.min(...highs.map(h => h.score)),
    medianScoreObserved: pct(highs.map(h => h.score).sort((a,b)=>a-b), 0.5),
    features: {
      requireCanonical: freq(highs, p=>p.features.hasCanonical) >= 0.6,
      requireOG: freq(highs, p=>p.features.ogTags>0) >= 0.6,
      requireTwitter: freq(highs, p=>p.features.twitterTags>0) >= 0.5,
      requireJsonLd: freq(highs, p=>p.features.jsonLdTypes.length>0) >= 0.5,
      enforceHeadingsOk: freq(highs, p=>p.features.headingsOk) >= 0.7,
      enforceSingleH1: freq(highs, p=>p.features.h1Count===1) >= 0.6
    },
    targets: {
      titleLength: {
        min: Math.max(30, pct(titleLengths, 0.25)),
        max: Math.min(65, pct(titleLengths, 0.75))
      },
      descriptionLength: {
        min: Math.max(90, pct(descLengths, 0.25)),
        max: Math.min(170, pct(descLengths, 0.75))
      },
      imageAltCoverageMin: Math.max(0.8, pct(altCovs, 0.25)),
      internalLinksMin: Math.max(10, Math.round(pct(intLinks, 0.5)))
    },
    tags: topKTerms(highs.flatMap(p => p.tags), 50),
    sampleDomains: Array.from(new Set(highs.map(p => p.domain))).slice(0, 10)
  };
  return strategy;
}

function mostCommon(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x)||0)+1);
  let best = null, bestN = -1;
  for (const [k,v] of m) if (v>bestN) { best=k; bestN=v; }
  return best;
}

function topKTerms(arr, k) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x)||0)+1);
  return [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,k).map(([t])=>t);
}

function selectBestStrategy(knowledge, targetCategory, targetTags, config) {
  let candidates = knowledge.strategies || [];
  const ranked = candidates.map(s => {
    const catBoost = (s.category === targetCategory) ? 1 : (s.category === 'generic' ? 0.5 : 0);
    const sim = jaccard(s.tags || [], targetTags || []);
    const score = (catBoost * 2) + (sim * 3) + ((s.medianScoreObserved || 8) / 10);
    return { s, catBoost, sim, score };
  }).sort((a,b)=>b.score-a.score);

  for (const r of ranked) {
    if (r.catBoost === 0) continue;
    if (r.sim >= config.categorySimilarityThreshold || r.s.category === 'generic') {
      return { strategy: r.s, similarity: r.sim };
    }
  }
  const generic = ranked.find(r => r.s.category === 'generic');
  return generic ? { strategy: generic.s, similarity: generic.sim } : { strategy: null, similarity: 0 };
}

function applyStrategyToHtml(html, url, analysis, strategy, config) {
  if (!cheerio) return { html, applied: false, reason: 'cheerio-not-installed', suggestions: [] };

  const $ = cheerio.load(html);
  const sug = [];
  if ($('head').length === 0) $('html').prepend('<head></head>');
  if ($('body').length === 0) $('html').append('<body></body>');

  if (config.safeTransforms.canonical && strategy.features?.requireCanonical) {
    const existing = $('link[rel="canonical"]');
    if (existing.length === 0) {
      $('head').append(`<link rel="canonical" href="${url}">`);
      sug.push('Added canonical link');
    }
  }

  if (config.safeTransforms.metaDescription) {
    const meta = $('meta[name="description"]');
    const descText = meta.attr('content') || '';
    const targetMin = strategy.targets?.descriptionLength?.min ?? config.targetRanges.descriptionLength.min;
    const targetMax = strategy.targets?.descriptionLength?.max ?? config.targetRanges.descriptionLength.max;
    if (!descText || descText.length < targetMin || descText.length > targetMax) {
      const base = ($('meta[property="og:description"]').attr('content') ||
                    $('p').first().text() ||
                    $('h1').first().text() ||
                    $('title').first().text() || '').trim().replace(/\s+/g,' ');
      const trimmed = base.substring(0, Math.min(base.length, targetMax));
      if (meta.length === 0) {
        $('head').append(`<meta name="description" content="${escapeHtml(trimmed)}">`);
        sug.push('Added meta description');
      } else {
        meta.attr('content', trimmed);
        sug.push('Adjusted meta description length');
      }
    }
  }

  if (config.safeTransforms.ogTwitter) {
    if (strategy.features?.requireOG) {
      ensureMeta($, 'property', 'og:title', $('title').first().text(), sug);
      ensureMeta($, 'property', 'og:description', $('meta[name="description"]').attr('content'), sug);
      ensureMeta($, 'property', 'og:url', url, sug);
    }
    if (strategy.features?.requireTwitter) {
      ensureMeta($, 'name', 'twitter:card', 'summary', sug);
      ensureMeta($, 'name', 'twitter:title', $('title').first().text(), sug);
      ensureMeta($, 'name', 'twitter:description', $('meta[name="description"]').attr('content'), sug);
    }
  }

  if (config.safeTransforms.jsonLdWebsite && strategy.features?.requireJsonLd) {
    const hasJsonLd = $('script[type="application/ld+json"]').length > 0;
    if (!hasJsonLd) {
      const domain = getDomain(url);
      const siteJson = {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        url: `https://${domain}/`,
        potentialAction: {
          '@type': 'SearchAction',
          target: `https://${domain}/search?q={search_term_string}`,
          'query-input': 'required name=search_term_string'
        }
      };
      $('head').append(`<script type="application/ld+json">${JSON.stringify(siteJson)}</script>`);
      sug.push('Added JSON-LD WebSite schema');
    }
  }

  if (config.safeTransforms.enforceSingleH1 && strategy.features?.enforceSingleH1) {
    const h1s = $('h1');
    if (h1s.length > 1) {
      h1s.slice(1).each((_,el)=>{
        const $el = $(el);
        $el.replaceWith(`<h2>${$el.html()}</h2>`);
      });
      sug.push(`Demoted ${h1s.length - 1} extra H1s to H2`);
    }
  }

  if (config.safeTransforms.fillMissingImageAlt) {
    let filled = 0;
    $('img').each((_,el)=>{
      const $el = $(el);
      const alt = ($el.attr('alt') || '').trim();
      if (!alt) {
        const src = ($el.attr('src') || '').split('/').pop() || 'image';
        const guess = src.replace(/\.[a-z0-9]+$/i,'').replace(/[-_]/g,' ').trim() || 'image';
        $el.attr('alt', guess);
        filled++;
      }
    });
    if (filled > 0) sug.push(`Filled alt text for ${filled} image(s)`);
  }

  return { html: $.html(), applied: sug.length > 0, reason: sug.length ? 'applied' : 'no-op', suggestions: sug };
}

function ensureMeta($, attrName, key, val, suggestions) {
  if (!val) return;
  const sel = `meta[${attrName}="${key}"]`;
  const el = $(sel);
  if (el.length === 0) {
    const attr = attrName === 'property' ? `property="${key}"` : `name="${key}"`;
    $('head').append(`<meta ${attr} content="${escapeHtml(val)}">`);
    suggestions.push(`Added ${key}`);
  } else if ((el.attr('content') || '') !== val) {
    el.attr('content', val);
    suggestions.push(`Updated ${key}`);
  }
}

function escapeHtml(s='') {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Public API

function createSeoHelper(userConfig) {
  const config = loadConfig(userConfig);
  const knowledge = loadKnowledge(config.knowledgePath);

  const run = {
    pagesByDomain: new Map()
  };

  return {
    config,
    knowledge,

    analyzePage(html, url, ctx={}) {
      const a = analyzeHtml(html, url, config);
      const arr = run.pagesByDomain.get(a.domain) || [];
      arr.push(a);
      run.pagesByDomain.set(a.domain, arr);
      return a;
    },

    maybeImprove(html, url, ctx={}, opts={ interactive: false, autoApply: true }) {
      const analysis = analyzeHtml(html, url, config);
      if (analysis.score >= config.threshold) {
        return { html, applied: false, reason: 'above-threshold', suggestions: [], analysis };
      }
      const { strategy } = selectBestStrategy(knowledge, analysis.category, analysis.tags, config);
      if (!strategy) {
        return { html, applied: false, reason: 'no-strategy', suggestions: [], analysis };
      }

      if (opts.interactive && process.stdin.isTTY) {
        return new Promise(resolve => {
          const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
          rl.question(`[seo-helper] Page score ${analysis.score.toFixed(1)}/10. Apply best strategy (${strategy.category})? [Y/n] `, ans => {
            rl.close();
            const yes = !ans || ans.toLowerCase().startsWith('y');
            if (!yes) return resolve({ html, applied: false, reason: 'user-declined', suggestions: [], analysis, strategy });
            const applied = applyStrategyToHtml(html, url, analysis, strategy, config);
            resolve({ ...applied, analysis, strategy });
          });
        });
      } else if (opts.autoApply) {
        const applied = applyStrategyToHtml(html, url, analysis, strategy, config);
        return { ...applied, analysis, strategy };
      } else {
        return { html, applied: false, reason: 'auto-apply-disabled', suggestions: [], analysis, strategy };
      }
    },

    async learnFromRun(runContext={}) {
      for (const [domain, pages] of run.pagesByDomain.entries()) {
        if (pages.length < (runContext.minPagesPerDomainForLearning || config.minPagesPerDomainForLearning)) continue;
        const strat = aggregateStrategies(pages, config);
        if (!strat) continue;
        const existingIdx = (knowledge.strategies || []).findIndex(s => s.category === strat.category);
        if (existingIdx >= 0) knowledge.strategies[existingIdx] = { ...knowledge.strategies[existingIdx], ...strat };
        else knowledge.strategies.push(strat);
      }
      saveKnowledge(config.knowledgePath, knowledge);
      run.pagesByDomain.clear();
      return { saved: true, strategiesCount: knowledge.strategies.length };
    }
  };
}

module.exports = { createSeoHelper };
