const fs = require('fs');
const path = require('path');

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^[\s._-]+|[\s._-]+$/g, '')
    .replace(/[^a-z0-9.-]+/g, '-')  // keep dots and dashes for hostnames
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '');
}

function stripWww(host) {
  return host.replace(/^(www|m)\./i, '');
}

function fmtDate(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

function shortRand() {
  return Math.random().toString(36).slice(2, 6);
}

function ensureUnique(baseDir, id) {
  let candidate = id;
  let i = 2;
  while (fs.existsSync(path.join(baseDir, candidate))) {
    candidate = `${id}-${i++}`;
    if (i > 2000) { // safety
      candidate = `${id}-${shortRand()}`;
      break;
    }
  }
  return candidate;
}

/**
 * Derive a runId from the first URL's hostname.
 *
 * opts:
 * - format: 'domain' | 'domain-date' | 'domain-date-rand' | 'domain-rand' | 'random'
 * - baseDir: directory where runs are created (for uniqueness checks)
 * - stripWWW: default true, strip www./m.
 *
 * Returns a string suitable for the run folder name.
 */
function deriveRunId(urlsText, opts = {}) {
  const {
    format = process.env.RUN_ID_FORMAT || 'domain-date-rand',
    baseDir = '',
    stripWWW: doStripWWW = String(process.env.RUN_ID_STRIP_WWW || 'true').toLowerCase() !== 'false'
  } = opts;

  const urls = String(urlsText || '')
    .split(/\r?\n|,|\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  let host = 'run';
  for (const u of urls) {
    try {
      const url = new URL(u);
      host = url.hostname || host;
      break;
    } catch {}
  }

  if (doStripWWW) host = stripWww(host);
  const domainSlug = slugify(host) || 'run';

  let id;
  switch ((format || '').toLowerCase()) {
    case 'domain':
      id = domainSlug;
      break;
    case 'domain-date':
      id = `${domainSlug}-${fmtDate()}`;
      break;
    case 'domain-rand':
      id = `${domainSlug}-${shortRand()}`;
      break;
    case 'random':
      id = shortRand() + shortRand();
      break;
    case 'domain-date-rand':
    default:
      id = `${domainSlug}-${fmtDate()}-${shortRand()}`;
      break;
  }

  if (baseDir) {
    id = ensureUnique(baseDir, id);
  }
  return id;
}

module.exports = { deriveRunId, slugify };
