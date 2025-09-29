/**
 * Playwright Stealth Mirror Script
 * - Uses playwright-stealth (unofficial) for anti-bot evasion.
 * - Real Chrome, persistent context, human-like actions.
 * 
 * Install: npm install playwright-stealth
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-stealth');

const SEEDS_FILE = '/root/SingleFile/single-file-cli/seeds.txt';
const OUTPUT_ROOT = '/var/www/outnet-archive';

function sanitizePath(url) {
  let u = url.replace(/https?:\/\/(www\.)?theoutnet\.com/, '');
  u = u.replace(/\?.*$/, '');
  u = u.replace(/\/$/, '');
  if (!u) return 'index';
  return u.startsWith('/') ? u.slice(1) : u;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min)) + min;
}

function randomDelay(min, max) {
  return new Promise(resolve => setTimeout(resolve, randomInt(min, max)));
}

// Human-like actions
async function humanScroll(page) {
  let pos = 0;
  let height = await page.evaluate(() => document.body ? document.body.scrollHeight : 0);
  let scrolls = 0;
  while (scrolls < 12 && height > 0) {
    pos += randomInt(200, 600);
    await page.mouse.wheel(0, pos);
    await randomDelay(800, 2500);
    let newHeight = await page.evaluate(() => document.body ? document.body.scrollHeight : 0);
    if (newHeight === height) break;
    height = newHeight;
    scrolls++;
  }
}

async function humanMouseMove(page) {
  for (let i = 0; i < randomInt(3, 8); i++) {
    await page.mouse.move(randomInt(0, 900), randomInt(0, 700));
    await randomDelay(700, 2200);
  }
}

async function randomClick(page) {
  const selectors = ['button', 'a', '[role="button"]', '.menu', '.dropdown'];
  for (const sel of selectors) {
    const els = await page.$$(sel);
    if (els.length > 0) {
      const el = els[randomInt(0, els.length)];
      try {
        await el.click({ timeout: randomInt(800, 2500) });
        await randomDelay(700, 2200);
      } catch (e) { /* ignore */ }
    }
  }
}

(async () => {
  const seeds = fs.readFileSync(SEEDS_FILE, 'utf-8')
    .split('\n').map(x => x.trim()).filter(Boolean);

  const context = await chromium.launchPersistentContext('/tmp/playwright-profile-' + Math.random(), {
    headless: false,
    executablePath: '/usr/bin/google-chrome',
    args: [ '--window-size=1200,900', '--disable-blink-features=AutomationControlled' ]
  });

  for (const seed of seeds) {
    const page = await context.newPage();
    console.log(`Navigating to: ${seed}`);
    try {
      await page.goto(seed, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(5000);

      // Human-like actions
      await humanScroll(page);
      await humanMouseMove(page);
      await randomClick(page);

      const html = await page.content();
      console.log('HTML preview:', html.slice(0, 500));

      // Save HTML for debugging
      const pagePath = sanitizePath(seed);
      const outDir = path.join(OUTPUT_ROOT, path.dirname(pagePath));
      fs.mkdirSync(outDir, { recursive: true });
      const htmlOut = path.join(outDir, path.basename(pagePath) + '.html');
      fs.writeFileSync(htmlOut, html, 'utf8');
      console.log(`Saved HTML to ${htmlOut}`);
    } catch (e) {
      console.error(`Navigation failed for ${seed}: ${e.message}`);
      continue;
    }
    await page.close();
    await randomDelay(3000, 7000);
  }

  await context.close();
})();
