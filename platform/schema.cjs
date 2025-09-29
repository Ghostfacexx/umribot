// Normalized content schema used by all exporters

function page(id, url, title, html, plainText, images = [], metadata = {}) {
  return {
    type: 'page',
    id, // slug or stable id
    url,
    title,
    html,        // sanitized HTML body
    plainText,   // text-only body
    images,      // [{src, alt}]
    metadata     // {description, canonical, tags:[], ...}
  };
}

function product(id, url, title, html, plainText, images = [], price = null, currency = 'USD', sku = '', brand = '', categories = [], variants = [], metadata = {}) {
  return {
    type: 'product',
    id,
    url,
    title,
    html,
    plainText,
    images,      // [{src, alt}]
    price,
    currency,
    sku,
    brand,
    categories,  // strings
    variants,    // [{sku, option1, option2, option3, price, image}]
    metadata
  };
}

module.exports = { page, product };
