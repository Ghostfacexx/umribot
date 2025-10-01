/**
 * Puppeteer Extra Stealth Mirror Script (NO PROXY, Node.js v18+ global fetch)
 * - Loads pages directly, NO proxy logic.
 * - Human-like actions, resource downloading, offline structuring.
 * - Uses Node.js built-in fetch (no node-fetch required).
 * 
 * Install: npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const SEEDS_FILE = '/root/SingleFile/single-file-cli/seeds.txt';
const OUTPUT_ROOT = '/var/www/outnet-archive';

function sanitizePath(url) {
  let u = url.replace(/https?:\/\/(www\.)?theoutnet\.com/, '');
  u = u.replace(/\?.*$/, '').replace(/\/$/, '');
  if (!u) return 'index';
  return u.startsWith('/') ? u.slice(1) : u;
}
function escapeRegExp(str) {
  return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}
function randomDelay(min, max) {
  return new Promise(resolve => setTimeout(resolve, randomInt(min, max)));
}

// Download resources using Node.js global fetch (no require needed)
async function downloadResource(rUrl, outPath) {
  try {
    const resp = await fetch(rUrl);
    if (!resp.ok) {
      console.log(`FAILED to download ${rUrl}: ${resp.status}`);
      return false;
    }
    const buffer = await resp.arrayBuffer();
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(buffer));
    return true;
  } catch (e) {
    console.log(`ERROR downloading ${rUrl}:`, e.message);
    return false;
  }
}

const seeds = fs.readFileSync(SEEDS_FILE, 'utf-8').split('\n').map(x => x.trim()).filter(Boolean);

(async () => {
  for (const seed of seeds) {
    // Launch browser normally, NO proxy args
    const browser = await puppeteer.launch({
      headless: false,
      executablePath: '/usr/bin/google-chrome',
      args: [
        '--window-size=1200,900',
        '--no-sandbox'
      ]
    });

    // Create page
    const page = await browser.newPage();

    await randomDelay(2000, 7000);

    try {
      console.log(`Navigating to: ${seed}`);
      await page.goto(seed, { waitUntil: 'networkidle2', timeout: 90000 });

      // Check for redirect (anti-bot, etc)
      const finalUrl = page.url();
      if (finalUrl !== seed) {
        console.log(`Redirected to: ${finalUrl}`);
      }

      await randomDelay(1500, 3500);

      // Human-like actions
      let pos = 0, height = await page.evaluate(() => document.body ? document.body.scrollHeight : 0), scrolls = 0;
      while (scrolls < 12 && height > 0) {
        pos += randomInt(200, 600);
        await page.mouse.wheel({ deltaY: pos });
        await randomDelay(800, 2500);
        let newHeight = await page.evaluate(() => document.body ? document.body.scrollHeight : 0);
        if (newHeight === height) break;
        height = newHeight;
        scrolls++;
      }
      for (let i = 0; i < randomInt(3, 8); i++) {
        await page.mouse.move(randomInt(0, 900), randomInt(0, 700));
        await randomDelay(700, 2200);
      }

      // Resource extraction
      let resourceUrls = [];
      try {
        resourceUrls = await page.evaluate(() => {
          const urls = [];
          document.querySelectorAll('img[src]').forEach(img => urls.push(img.src));
          document.querySelectorAll('link[rel="stylesheet"][href]').forEach(l => urls.push(l.href));
          document.querySelectorAll('script[src]').forEach(s => urls.push(s.src));
          document.querySelectorAll('link[rel="preload"][as="font"][href]').forEach(f => urls.push(f.href));
          return Array.from(new Set(urls));
        });
      } catch (err) {
        console.log(`Resource extraction failed: ${err.message}`);
      }

      console.log('Resource URLs:', resourceUrls);

      // Save page HTML and resources
      const pagePath = sanitizePath(seed);
      const outDir = path.join(OUTPUT_ROOT, path.dirname(pagePath));
      fs.mkdirSync(outDir, { recursive: true });
      const resourceDir = path.join(outDir, 'resources');
      fs.mkdirSync(resourceDir, { recursive: true });

      let html = '';
      try {
        html = await page.content();
      } catch (err) {
        console.log(`Failed to get page HTML: ${err.message}`);
      }

      for (const rUrl of resourceUrls) {
        if (!/^https?:\/\//.test(rUrl)) continue;
        const ext = path.extname(rUrl).split('?')[0];
        const hash = crypto.createHash('sha1').update(rUrl).digest('hex').slice(0, 10);
        const base = path.basename(rUrl).split('?')[0];
        const localName = `${hash}_${base}${ext}`;
        const localPath = path.join(resourceDir, localName);

        const downloaded = await downloadResource(rUrl, localPath);

        console.log(`Downloading ${rUrl} => ${downloaded ? 'OK' : 'FAILED'}`);
        if (downloaded && html) {
          const escapedUrl = escapeRegExp(rUrl);
          html = html.replace(new RegExp(escapedUrl, 'g'), './resources/' + localName);
        }
      }

      // Rewrite <a href> to point to local archive if they match seeds
      for (const link of seeds) {
        const localLink = './' + sanitizePath(link) + '/index.html';
        const escapedUrl = escapeRegExp(link);
        if (html) html = html.replace(new RegExp(`href=["']${escapedUrl}["']`, 'g'), `href="${localLink}"`);
      }

      // Save HTML
      if (html && html.length > 0) {
        const htmlOut = path.join(outDir, path.basename(pagePath) + '.html');
        fs.writeFileSync(htmlOut, html, 'utf8');
        console.log(`Saved ${seed} to ${htmlOut}`);
      } else {
        console.log(`No HTML to save for ${seed}.`);
      }

    } catch (e) {
      console.error(`Navigation failed for ${seed}: ${e.message}`);
    }

    await page.close();
    await browser.close();
    await randomDelay(4000, 17000);
  }
})();