// lib/domain.cjs
// Utilities to normalize hostnames and decide "same site" membership
// without pulling a full Public Suffix List dependency.

function toHost(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return String(value || '').toLowerCase(); }
}

// Minimal multi-level TLD exceptions. Not exhaustive, but covers common cases.
const MULTI_TLD = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk',
  'co.jp',
  'com.au', 'net.au', 'org.au',
  'com.br', 'com.mx', 'com.tr', 'com.sg', 'com.cn'
]);

function getETLDPlusOne(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return h;

  const lastTwo = parts.slice(-2).join('.');
  const lastThree = parts.slice(-3).join('.');
  if (MULTI_TLD.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  if (MULTI_TLD.has(lastThree) && parts.length >= 4) {
    return parts.slice(-4).join('.');
  }
  return parts.slice(-2).join('.');
}

function stripWww(host) {
  return String(host || '').replace(/^(www|m)\./i, '').toLowerCase();
}

function buildSameSiteChecker(seedUrls, opts = {}) {
  const mode = (opts.mode || 'subdomains').toLowerCase(); // 'exact' | 'subdomains' | 'etld'
  const extraRegex = (opts.extraRegex || '').trim();
  const extraMatcher = extraRegex ? new RegExp(extraRegex, 'i') : null;

  const seeds = (Array.isArray(seedUrls) ? seedUrls : String(seedUrls || '').split(/\r?\n|,|\s+/))
    .map(s => s && s.trim()).filter(Boolean);

  const seedOrigins = new Set();
  const seedHosts = new Set();
  const seedApexes = new Set();

  for (const s of seeds) {
    try {
      const u = new URL(s);
      seedOrigins.add(u.origin.toLowerCase());
      const host = u.hostname.toLowerCase();
      seedHosts.add(host);
      seedApexes.add(getETLDPlusOne(host));
    } catch {}
  }

  return function isSameSite(urlLike) {
    let u;
    try { u = (urlLike instanceof URL) ? urlLike : new URL(String(urlLike)); } catch { return false; }
    const host = u.hostname.toLowerCase();
    if (extraMatcher && extraMatcher.test(host)) return true;

    if (mode === 'exact') {
      return seedOrigins.has(u.origin.toLowerCase());
    }

    if (mode === 'subdomains') {
      for (const seedHost of seedHosts) {
        if (host === seedHost) return true;
        if (host.endsWith('.' + seedHost)) return true;
      }
      return false;
    }

    // etld
    const apex = getETLDPlusOne(host);
    return seedApexes.has(apex);
  };
}

module.exports = {
  toHost,
  getETLDPlusOne,
  stripWww,
  buildSameSiteChecker
};