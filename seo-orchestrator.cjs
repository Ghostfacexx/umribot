/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { SeoToolsClient } = require('./seo-tools-client.cjs');
const { createSeoHelper } = require('./seo-helper.cjs');

function loadJson(p, fallback = {}) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }

const toolsConfig = loadJson(path.resolve(process.cwd(), 'seo-tools.config.json'), {
  baseUrl: process.env.SEO_API_BASE || 'http://127.0.0.1:3000/api',
  timeoutMs: 60000,
  concurrency: 4,
  tasks: []
});
const helperConfig = loadJson(path.resolve(process.cwd(), 'seo.config.json'), {});

const client = new (SeoToolsClient)(toolsConfig);
const helper = createSeoHelper(helperConfig);

const DEFAULTS = { threshold: helper.config.threshold || 8.0, weight: { api: 0.4, local: 0.6 } };

function combineScores(localScore, apiScore, weight = DEFAULTS.weight) {
  if (localScore == null && apiScore == null) return null;
  if (localScore == null) return apiScore;
  if (apiScore == null) return localScore;
  const s = (localScore * (weight.local ?? 0.6)) + (apiScore * (weight.api ?? 0.4));
  return Math.round(s * 10) / 10;
}

async function analyzeAndMaybeImprove(html, url, opts = { interactive: false, autoApply: true }) {
  const local = helper.analyzePage(html, url, {});
  const api = await client.runAll({ html, url });
  const combinedScore = combineScores(local.score, api.combinedScore);

  let finalHtml = html;
  let applied = false;
  let suggestions = [];
  let appliedReason = 'above-threshold';

  if (combinedScore != null && combinedScore < (helper.config.threshold || DEFAULTS.threshold)) {
    const res = await helper.maybeImprove(html, url, {}, { interactive: !!opts.interactive, autoApply: !!opts.autoApply });
    finalHtml = res.html;
    applied = !!res.applied;
    suggestions = res.suggestions || [];
    appliedReason = res.reason || 'applied';
  }

  return { url, combinedScore, localScore: local.score, apiScore: api.combinedScore, category: local.category, applied, appliedReason, suggestions, apiResults: api.results, analysis: local, html: finalHtml };
}

async function finalizeRun(ctx = {}) { return helper.learnFromRun(ctx); }

module.exports = { analyzeAndMaybeImprove, finalizeRun };
