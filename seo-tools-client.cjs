/* eslint-disable no-console */
const { URL } = require('url');

function getFetch() {
  if (typeof fetch === 'function') return fetch;
  try { return require('node-fetch'); } catch {
    throw new Error('Global fetch not found. Install node-fetch: npm i node-fetch@2');
  }
}
const doFetch = getFetch();

function withTimeout(promise, ms, msg='Request timed out') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

function joinUrl(base, pth) {
  try {
    const u = new URL(pth, base.endsWith('/') ? base : base + '/');
    return u.toString().replace(/\/+$/,'');
  } catch {
    return base.replace(/\/+$/,'') + '/' + String(pth || '').replace(/^\/+/, '');
  }
}

function defaultScoreMapper(val) {
  if (val == null || Number.isNaN(Number(val))) return null;
  const n = Number(val);
  if (n <= 1) return Math.max(0, Math.min(10, n * 10));
  if (n <= 10) return Math.max(0, Math.min(10, n));
  if (n <= 100) return Math.max(0, Math.min(10, n / 10));
  return Math.max(0, Math.min(10, n));
}

class SeoToolsClient {
  constructor(config) {
    this.baseUrl = process.env.SEO_API_BASE || config.baseUrl || 'http://127.0.0.1:3000/api';
    this.timeoutMs = Number(process.env.SEO_API_TIMEOUT_MS || config.timeoutMs || 60000);
    this.concurrency = Number(process.env.SEO_API_CONCURRENCY || config.concurrency || 4);
    this.headers = config.headers || {};
    this.tasks = Array.isArray(config.tasks) ? config.tasks : [];
  }

  async runTask(task, { html, url }) {
    const endpoint = joinUrl(this.baseUrl, task.path);
    const method = (task.method || 'POST').toUpperCase();
    const headers = { 'content-type': 'application/json', ...this.headers, ...(task.headers || {}) };

    const payloadKind = (task.payload || 'url').toLowerCase();
    const payload = payloadKind === 'url' ? { url } : payloadKind === 'html' ? { html, url } : payloadKind === 'both' ? { url, html } : (typeof task.payload === 'object' ? task.payload : { url });

    if (method === 'GET') {
      const u = new URL(endpoint);
      Object.entries(payload).forEach(([k, v]) => { if (v != null) u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v)); });
      const res = await withTimeout(doFetch(u.toString(), { method, headers }), this.timeoutMs);
      const json = await res.json().catch(() => ({}));
      return this._shapeTaskResult(task, json);
    }

    const res = await withTimeout(doFetch(endpoint, { method, headers, body: JSON.stringify(payload) }), this.timeoutMs);
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { json = { raw: text, ok: res.ok, status: res.status }; }
    return this._shapeTaskResult(task, json);
  }

  _shapeTaskResult(task, data) {
    let score = null;
    if (task.scoreKey) {
      const val = this._getNested(data, task.scoreKey);
      score = (typeof task.mapScore === 'function' ? task.mapScore : defaultScoreMapper)(val);
    } else if (typeof task.mapScore === 'function') {
      score = task.mapScore(data);
    }
    return { name: task.name, ok: true, score, data };
  }

  _getNested(obj, keyPath) {
    try { return keyPath.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); } catch { return undefined; }
  }

  async runAll({ html, url }) {
    if (!this.tasks.length) return { results: [], combinedScore: null };
    const results = [];
    for (const task of this.tasks) {
      try { results.push(await this.runTask(task, { html, url })); }
      catch (e) { results.push({ name: task.name, ok: false, error: e.message || String(e), score: null, data: null }); }
    }
    const combinedScore = this._combineScores(results);
    return { results, combinedScore };
  }

  _combineScores(results) {
    const scores = results.map(r => (typeof r.score === 'number' ? r.score : null)).filter(s => s != null);
    if (!scores.length) return null;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return Math.round(avg * 10) / 10;
  }
}

module.exports = { SeoToolsClient, defaultScoreMapper, joinUrl };
