/* eslint-disable no-console */
// Call this helper right after page.goto and before link extraction.
async function handleConsentAndChallenges(page) {
  try {
    const challengeSelector = '.challenge-platform, .cf-challenge, #cf-challenge-running';
    const consentSelector = '[id*="consent"], [class*="consent"], button:has-text("Accept"), button:has-text("Agree")';

    if (await page.$(challengeSelector)) {
      console.log('[ARCHIVER] Cloudflare challenge detected, waiting up to 20s...');
      await page.waitForTimeout(3000);
      try {
        await page.waitForFunction(sel => !document.querySelector(sel), { timeout: 20000 }, challengeSelector);
        console.log('[ARCHIVER] Challenge appears resolved');
      } catch {
        console.warn('[ARCHIVER] Challenge did not resolve in time');
      }
    }

    if (await page.$(consentSelector)) {
      console.log('[ARCHIVER] Consent popup detected, attempting click...');
      try { await page.click(consentSelector, { timeout: 3000 }); } catch {}
      await page.waitForTimeout(1000);
    }
  } catch (e) {
    console.warn('[ARCHIVER] Consent/challenge bypass error:', e.message);
  }
}

module.exports = { handleConsentAndChallenges };
