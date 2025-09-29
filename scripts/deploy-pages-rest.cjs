#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const crypto = require('crypto');

function need(name) { const v = process.env[name]; if (!v) { console.error(`Missing ${name}`); process.exit(1); } return v; }

(async () => {
  const SITE = need('WP_SITE');        // e.g. https://designersdiscount.shop
  const USER = need('WP_USER');        // WP username
  const APP  = need('WP_APP_PASS');    // Application Password (can contain spaces)
  const CFG  = path.resolve(process.env.CONFIG || 'scripts/pages.json');
  const PUBLISH_STATUS = process.env.PUBLISH_STATUS || 'publish';
  const SET_HOME = (process.env.SET_HOME || 'true') === 'true';
  const SET_PERMALINKS = process.env.SET_PERMALINKS || '';

  if (!(await fs.pathExists(CFG))) { console.error('Missing', CFG); process.exit(1); }
  const pages = JSON.parse(await fs.readFile(CFG, 'utf8'));
  if (!Array.isArray(pages) || !pages.length) { console.error('No pages in', CFG); process.exit(1); }

  const auth = 'Basic ' + Buffer.from(`${USER}:${APP}`).toString('base64');
  const api = (p) => `${SITE.replace(/\/+$/,'')}/wp-json${p}`;

  async function get(url)  { const r = await fetch(api(url), { headers: { authorization: auth } }); const t = await r.text(); if (!r.ok) throw new Error(`${r.status} GET ${url} ${t}`); return JSON.parse(t); }
  async function post(url, body) { const r = await fetch(api(url), { method:'POST', headers:{'content-type':'application/json', authorization:auth}, body:JSON.stringify(body)}); const t = await r.text(); if (!r.ok) throw new Error(`${r.status} POST ${url} ${t}`); return JSON.parse(t); }

  let homeId = 0;

  for (const p of pages) {
    const slug = (p.slug || '').trim();
    if (!slug) { console.warn('[skip] no slug', p.title); continue; }

    const payload = JSON.stringify([p.title, p.contentHtml, p.menuOrder || 0]);
    const checksum = crypto.createHash('sha1').update(payload).digest('hex');

    const found = await get(`/wp/v2/pages?slug=${encodeURIComponent(slug)}`);
    if (Array.isArray(found) && found.length) {
      const page = found[0];
      const prev = String((page.meta && page.meta._mirror_checksum) || '');
      if (prev === checksum) {
        console.log(`[=] ${slug} unchanged`);
      } else {
        await post(`/wp/v2/pages/${page.id}`, {
          id: page.id,
          title: p.title || slug,
          content: p.contentHtml || '',
          menu_order: p.menuOrder || 0,
          status: PUBLISH_STATUS,
          meta: { _mirror_origin: p.originUrl || '', _mirror_checksum: checksum }
        });
        console.log(`[~] updated ${slug} (#${page.id})`);
      }
      if (SET_HOME && p.isFrontPage) homeId = page.id;
    } else {
      const created = await post('/wp/v2/pages', {
        title: p.title || slug,
        slug,
        content: p.contentHtml || '',
        menu_order: p.menuOrder || 0,
        status: PUBLISH_STATUS,
        meta: { _mirror_origin: p.originUrl || '', _mirror_checksum: checksum }
      });
      console.log(`[+] created ${slug} (#${created.id})`);
      if (SET_HOME && p.isFrontPage) homeId = created.id;
    }
  }

  if (SET_PERMALINKS) {
    try { await post('/wp/v2/settings', { permalink_structure: SET_PERMALINKS }); console.log(`[ok] permalink_structure=${SET_PERMALINKS}`); }
    catch (e) { console.warn('[warn] set permalinks:', e.message); }
  }
  if (SET_HOME && homeId) {
    try { await post('/wp/v2/settings', { show_on_front: 'page', page_on_front: homeId }); console.log(`[ok] homepage id=${homeId}`); }
    catch (e) { console.warn('[warn] set homepage:', e.message); }
  }
  console.log('Done.');
})().catch(e => { console.error('FATAL', e); process.exit(1); });