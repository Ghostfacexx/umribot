/* Lightweight wrapper around 'juice' to inline CSS into elements.
   If 'juice' is not installed, returns the original HTML.
   Install once: npm i juice --save
*/
let juice = null;
try { juice = require('juice'); } catch { /* optional */ }

async function bakeCss(html, opts = {}) {
  if (!html || !juice) return html || '';
  // Preserve !important, inline pseudo elements where possible, and remove <style> after baking
  const options = {
    preserveImportant: true,
    inlinePseudoElements: true,
    removeStyleTags: true,
    applyWidthAttributes: true,
    applyHeightAttributes: true,
    preserveMediaQueries: true,
    ...opts
  };
  try {
    return juice(html, options);
  } catch {
    return html;
  }
}

module.exports = { bakeCss };