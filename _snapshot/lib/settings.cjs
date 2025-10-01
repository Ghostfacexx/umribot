/**
 * Centralized Settings Configuration
 * Consolidates all GUI settings with tooltips and defaults
 */

const SETTINGS_CONFIG = {
  // Capture Settings
  capture: {
    profiles: {
      default: 'desktop,mobile',
      tooltip: 'Device profiles to capture (desktop, mobile, or both)',
      type: 'select',
      options: ['desktop', 'mobile', 'desktop,mobile']
    },
    headless: {
      default: true,
      tooltip: 'Run browser in headless mode (faster, no GUI)',
      type: 'boolean'
    },
    aggressiveCapture: {
      default: false,
      tooltip: 'Enable aggressive capture mode for complex sites',
      type: 'boolean'
    },
    scrollPasses: {
      default: 0,
      tooltip: 'Number of scroll passes to trigger lazy-loaded content',
      type: 'number',
      min: 0,
      max: 5
    },
    concurrency: {
      default: 2,
      tooltip: 'Number of concurrent browser instances',
      type: 'number',
      min: 1,
      max: 10
    },
    waitExtra: {
      default: 700,
      tooltip: 'Extra wait time after page load (milliseconds)',
      type: 'number',
      min: 0,
      max: 10000
    },
    navTimeout: {
      default: 20000,
      tooltip: 'Navigation timeout (milliseconds)',
      type: 'number',
      min: 5000,
      max: 60000
    },
    pageTimeout: {
      default: 40000,
      tooltip: 'Page timeout (milliseconds)',
      type: 'number',
      min: 10000,
      max: 120000
    },
    maxCaptureMs: {
      default: 0,
      tooltip: 'Maximum capture time per page (0 = unlimited)',
      type: 'number',
      min: 0
    }
  },

  // Crawling Settings
  crawl: {
    maxPages: {
      default: 200,
      tooltip: 'Maximum number of pages to crawl',
      type: 'number',
      min: 1,
      max: 10000
    },
    maxDepth: {
      default: 3,
      tooltip: 'Maximum crawl depth from start URLs',
      type: 'number',
      min: 1,
      max: 10
    },
    sameHostOnly: {
      default: true,
      tooltip: 'Only crawl pages from the same host',
      type: 'boolean'
    },
    waitAfterLoad: {
      default: 500,
      tooltip: 'Wait time after page load during crawl (milliseconds)',
      type: 'number',
      min: 0,
      max: 5000
    }
  },

  // Asset Settings
  assets: {
    assetMaxBytes: {
      default: 3 * 1024 * 1024,
      tooltip: 'Maximum asset size to download (bytes)',
      type: 'number',
      min: 1024,
      max: 100 * 1024 * 1024
    },
    inlineSmallAssets: {
      default: 0,
      tooltip: 'Inline assets smaller than this size (0 = disabled)',
      type: 'number',
      min: 0,
      max: 50000
    },
    rewriteInternal: {
      default: true,
      tooltip: 'Rewrite internal links for offline browsing',
      type: 'boolean'
    },
    rewriteHtmlAssets: {
      default: true,
      tooltip: 'Rewrite HTML asset references',
      type: 'boolean'
    }
  },

  // Hosting Settings
  hosting: {
    includeMobile: {
      default: true,
      tooltip: 'Include mobile variant in hosting package',
      type: 'boolean'
    },
    stripAnalytics: {
      default: false,
      tooltip: 'Remove analytics tracking code',
      type: 'boolean'
    },
    serviceWorker: {
      default: true,
      tooltip: 'Include service worker for offline support',
      type: 'boolean'
    },
    precompress: {
      default: false,
      tooltip: 'Create pre-compressed .gz/.br files',
      type: 'boolean'
    },
    createZip: {
      default: true,
      tooltip: 'Create ZIP archive of hosting package',
      type: 'boolean'
    },
    sitemap: {
      default: true,
      tooltip: 'Generate sitemap.xml and robots.txt',
      type: 'boolean'
    }
  },

  // Consent Settings
  consent: {
    consentRetryAttempts: {
      default: 12,
      tooltip: 'Number of consent popup detection attempts',
      type: 'number',
      min: 0,
      max: 50
    },
    consentRetryInterval: {
      default: 700,
      tooltip: 'Interval between consent detection attempts (ms)',
      type: 'number',
      min: 100,
      max: 5000
    },
    consentMutationWindow: {
      default: 8000,
      tooltip: 'Time to wait for DOM mutations after consent (ms)',
      type: 'number',
      min: 1000,
      max: 30000
    },
    consentIframeScan: {
      default: false,
      tooltip: 'Scan iframes for consent popups',
      type: 'boolean'
    },
    consentDebug: {
      default: false,
      tooltip: 'Enable consent popup debugging',
      type: 'boolean'
    }
  }
};

/**
 * Get setting value with fallback to default
 */
function getSetting(category, key, userValue) {
  const setting = SETTINGS_CONFIG[category]?.[key];
  if (!setting) return userValue;
  
  if (userValue !== undefined) return userValue;
  return setting.default;
}

/**
 * Get setting configuration
 */
function getSettingConfig(category, key) {
  return SETTINGS_CONFIG[category]?.[key];
}

/**
 * Get all settings for a category
 */
function getCategorySettings(category) {
  return SETTINGS_CONFIG[category] || {};
}

/**
 * Get all settings
 */
function getAllSettings() {
  return SETTINGS_CONFIG;
}

module.exports = {
  SETTINGS_CONFIG,
  getSetting,
  getSettingConfig,
  getCategorySettings,
  getAllSettings
};