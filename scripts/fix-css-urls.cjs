#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');

const THEME_SLUG = 'teashop-mirror';
const themeOutDir = path.resolve('dist/theme', THEME_SLUG);
const assetsBaseRel = path.posix.join('assets', 'mirror');
const assetsBaseAbs = path.join(themeOutDir, assetsBaseRel);
const manifestPath = path.join(themeOutDir, 'assets-mirror-manifest.json');

(async () => {
  if (!(await fs.pathExists(manifestPath))) {
    console.error('No assets-mirror-manifest.json at', manifestPath);
    process.exit(1);
  }
  const { css = [] } = await fs.readJson(manifestPath);
  if (!css.length) {
    console.log('No CSS in manifest.');
    process.exit(0);
  }

  let totalUrls = 0, rewritten = 0, fetched = 0;

  for (const rel of css) {
    const abs = path.join(themeOutDir, rel);
    if (!(await fs.pathExists(abs))) { console.warn('[skip] missing CSS:', rel); continue; }

    // rel: assets/mirror/<host>/<remote/path>.css
    const parts = rel.split('/');
    const hostIdx = parts.indexOf('mirror') + 1;
    const host = parts[hostIdx];
    const remotePath = parts.slice(hostIdx + 1).join('/');
    const remoteCssUrl = `https://${host}/${remotePath}`;

    let cssText = await fs.readFile(abs, 'utf8');

    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    cssText = await replaceAsync(cssText, re, async (m, q, raw) => {
      totalUrls++;
      const u = (raw || '').trim();
      if (!u || /^data:/.test(u) || /^https?:\/\//i.test(u) || /^\/\//.test(u)) return m;

      // Resolve relative to the CSS file’s original URL
      let assetAbsUrl;
      try { assetAbsUrl = new URL(u, remoteCssUrl).toString(); }
      catch { return m; }

      const mirroredRel = await mirrorAsset(assetAbsUrl);
      if (!mirroredRel) return m;

      rewritten++;
      return `url("/wp-content/themes/${THEME_SLUG}/${mirroredRel}")`;
    });

    await fs.writeFile(abs, cssText, 'utf8');
    console.log('[ok] rewritten CSS:', rel);
  }

  console.log(`Done. url() seen: ${totalUrls}, rewritten: ${rewritten}, fetched assets: ${fetched}`);

  async function mirrorAsset(absUrl) {
    try {
      const u = new URL(absUrl);
      const cleanPath = u.pathname.replace(/^\/+/, '');
      const outRel = path.posix.join(assetsBaseRel, u.hostname, cleanPath);
      const outAbs = path.join(assetsBaseAbs, u.hostname, cleanPath);
      await fs.ensureDir(path.dirname(outAbs));
      if (!(await fs.pathExists(outAbs))) {
        const r = await fetch(absUrl, { timeout: 60000 });
        if (!r.ok) return '';
        const buf = await r.buffer();
        await fs.writeFile(outAbs, buf);
        fetched++;
      }
      return outRel;
    } catch {
      return '';
    }
  }
})();

function replaceAsync(str, regex, asyncFn) {
  const promises = [];
  str.replace(regex, (match, ...args) => {
    const promise = asyncFn(match, ...args);
    promises.push(promise);
    return match;
  });
  return Promise.all(promises).then(results => {
    let i = 0;
    return str.replace(regex, () => results[i++]);
  });
}