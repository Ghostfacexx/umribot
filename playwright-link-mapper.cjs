const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/**
 * COMPLETE SITE CRAWLER - 600+ LINES
 * CLICKS THROUGH NAVIGATION TO DISCOVER ALL LINKS
 */

class CompleteSiteCrawler {
    constructor(options = {}) {
        this.options = {
            // Crawling configuration
            headless: false,
            maxDepth: 3,
            maxPages: 50,
            clickNavigation: true,
            followInternalLinks: true,
            discoverProductPages: true,
            
            // Timing configuration
            timeout: 30000,
            navigationTimeout: 45000,
            clickDelay: 1000,
            pageLoadDelay: 2000,
            
            // Discovery configuration
            discoverCategories: true,
            discoverProducts: true,
            discoverFilters: true,
            discoverPagination: true,
            
            // Blocking configuration
            blockAnalytics: true,
            blockAds: true,
            
            // Output configuration
            outputFormat: 'console',
            outputFile: 'complete-links.csv',
            debugMode: false,
            
            // Merge user options
            ...options
        };

        this.statistics = {
            execution: {
                startTime: null,
                endTime: null,
                totalDuration: null
            },
            crawling: {
                pagesVisited: 0,
                linksDiscovered: 0,
                uniqueLinks: 0,
                categoriesFound: 0,
                productsFound: 0
            },
            resources: {
                totalRequests: 0,
                blockedRequests: 0
            }
        };

        this.state = {
            browser: null,
            context: null,
            page: null,
            currentURL: null,
            currentDomain: null,
            discoveredLinks: new Set(),
            visitedURLs: new Set(),
            navigationStack: [],
            isCrawling: false
        };

        // Pattern matching for different link types
        this.patterns = {
            categories: [
                '/shop/', '/category/', '/collection/', '/departments/',
                '/women/', '/men/', '/sale/', '/new/', '/bestsellers/'
            ],
            products: [
                '/product/', '/item/', '/p/', '/detail/',
                /\/[A-Z0-9]{6,}/, // Product codes
                /-\d+\.html/ // Product pages
            ],
            filters: [
                'size=', 'color=', 'brand=', 'price=',
                'category=', 'filter=', 'sort='
            ],
            pagination: [
                'page=', 'p=', 'offset=', 'start=',
                '/page/', '/p/'
            ]
        };

        console.log('🔧 COMPLETE SITE CRAWLER INITIALIZED');
        console.log(`📊 Max Depth: ${this.options.maxDepth}, Max Pages: ${this.options.maxPages}`);
    }

    /**
     * BROWSER INITIALIZATION
     */
    async initializeBrowser() {
        try {
            this.statistics.execution.startTime = Date.now();
            
            console.log('🚀 INITIALIZING CRAWLER BROWSER...');
            
            this.state.browser = await chromium.launch({ 
                headless: this.options.headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--window-size=1920,1080',
                    '--disable-web-security',
                    '--ignore-certificate-errors'
                ]
            });

            this.state.context = await this.state.browser.newContext({
                viewport: { width: 1920, height: 1080 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ignoreHTTPSErrors: true
            });

            // Stealth measures
            await this.state.context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

            this.state.page = await this.state.context.newPage();
            this.state.page.setDefaultTimeout(this.options.timeout);
            
            await this.setupRequestInterception();
            
            console.log('✅ CRAWLER BROWSER INITIALIZED');
            return true;
            
        } catch (error) {
            console.error('❌ BROWSER INITIALIZATION FAILED:', error);
            return false;
        }
    }

    /**
     * REQUEST INTERCEPTION
     */
    async setupRequestInterception() {
        await this.state.page.route('**/*', (route) => {
            const url = route.request().url();
            this.statistics.resources.totalRequests++;

            // Block analytics and ads
            const blockedDomains = [
                'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
                'facebook.com', 'facebook.net', 'analytics.tiktok.com', 'bat.bing.com'
            ];

            if (blockedDomains.some(domain => url.includes(domain)) ||
                /\/track|\/pixel|\/beacon|\/analytics|\/gtm\.js/.test(url)) {
                this.statistics.resources.blockedRequests++;
                route.abort();
                return;
            }

            route.continue();
        });

        console.log('✅ REQUEST INTERCEPTION CONFIGURED');
    }

    /**
     * MAIN CRAWLING ENGINE
     */
    async crawlSite(startURL) {
        try {
            console.log('🚀 STARTING COMPLETE SITE CRAWL...');
            console.log(`🌐 START URL: ${startURL}`);
            
            this.state.currentURL = startURL;
            const urlObj = new URL(startURL);
            this.state.currentDomain = urlObj.hostname;
            
            // Start with the main page
            await this.navigateToPage(startURL);
            
            // Extract initial links
            await this.extractAndDiscoverLinks();
            
            // Click through main navigation to discover categories
            await this.clickNavigationMenus();
            
            // Discover category pages
            await this.discoverCategoryPages();
            
            // Discover product listings
            await this.discoverProductListings();
            
            // Follow pagination if enabled
            if (this.options.discoverPagination) {
                await this.discoverPagination();
            }
            
            console.log('✅ CRAWLING COMPLETED');
            return Array.from(this.state.discoveredLinks);
            
        } catch (error) {
            console.error('❌ CRAWLING FAILED:', error.message);
            return Array.from(this.state.discoveredLinks);
        }
    }

    /**
     * NAVIGATE TO PAGE
     */
    async navigateToPage(url) {
        try {
            if (this.state.visitedURLs.has(url)) {
                return false;
            }
            
            console.log(`🧭 NAVIGATING TO: ${this.truncateURL(url)}`);
            
            await this.state.page.goto(url, {
                waitUntil: 'load',
                timeout: this.options.navigationTimeout
            });
            
            await this.state.page.waitForTimeout(this.options.pageLoadDelay);
            
            this.state.visitedURLs.add(url);
            this.statistics.crawling.pagesVisited++;
            this.state.currentURL = url;
            
            // Extract links from this page
            await this.extractAndDiscoverLinks();
            
            return true;
            
        } catch (error) {
            console.log(`❌ NAVIGATION FAILED: ${this.truncateURL(url)} - ${error.message}`);
            return false;
        }
    }

    /**
     * CLICK THROUGH NAVIGATION MENUS
     */
    async clickNavigationMenus() {
        if (!this.options.clickNavigation) return;
        
        console.log('🖱️  CLICKING THROUGH NAVIGATION MENUS...');
        
        const navigationSelectors = [
            // Main navigation
            'nav a', '.navigation a', '.menu a', '.nav a',
            '.header a', '.main-nav a', '.primary-nav a',
            // Dropdowns
            '.dropdown a', '.submenu a', '.megamenu a',
            // Category links
            '[href*="/shop/"]', '[href*="/category/"]', '[href*="/collection/"]',
            // Specific to THE OUTNET
            '[data-testid*="nav"]', '[class*="nav-item"]', '[class*="menu-item"]'
        ];

        for (const selector of navigationSelectors) {
            try {
                const links = await this.state.page.$$eval(selector, elements => 
                    elements.map(el => ({
                        href: el.href,
                        text: el.textContent?.trim(),
                        isVisible: el.offsetWidth > 0 && el.offsetHeight > 0
                    })).filter(link => 
                        link.href && 
                        link.isVisible &&
                        !link.href.includes('#') &&
                        !link.href.includes('javascript:')
                    )
                );

                for (const link of links.slice(0, 10)) { // Limit to first 10 per selector
                    if (this.shouldFollowLink(link.href) && this.state.discoveredLinks.size < 1000) {
                        console.log(`   👆 Clicking: ${this.truncateURL(link.href)}`);
                        
                        try {
                            await this.state.page.click(`${selector}[href="${link.href}"]`, { timeout: 5000 });
                            await this.state.page.waitForTimeout(this.options.clickDelay);
                            
                            // Extract links from new page
                            await this.extractAndDiscoverLinks();
                            
                            // Go back to original page
                            await this.state.page.goBack();
                            await this.state.page.waitForTimeout(this.options.clickDelay);
                            
                        } catch (clickError) {
                            console.log(`   ❌ Click failed: ${clickError.message}`);
                        }
                    }
                }
            } catch (error) {
                // Selector not found, continue
            }
        }
    }

    /**
     * DISCOVER CATEGORY PAGES
     */
    async discoverCategoryPages() {
        if (!this.options.discoverCategories) return;
        
        console.log('📂 DISCOVERING CATEGORY PAGES...');
        
        const categoryLinks = Array.from(this.state.discoveredLinks).filter(link => 
            this.patterns.categories.some(pattern => 
                typeof pattern === 'string' ? link.includes(pattern) : pattern.test(link)
            )
        );

        console.log(`   Found ${categoryLinks.length} category links`);
        
        // Visit up to 10 category pages to discover more links
        for (const categoryLink of categoryLinks.slice(0, 10)) {
            if (this.statistics.crawling.pagesVisited >= this.options.maxPages) break;
            
            await this.navigateToPage(categoryLink);
            
            // Extract more links from category page
            await this.extractAndDiscoverLinks();
            
            // Go back to maintain state
            await this.state.page.goBack();
            await this.state.page.waitForTimeout(this.options.clickDelay);
        }
    }

    /**
     * DISCOVER PRODUCT LISTINGS
     */
    async discoverProductListings() {
        if (!this.options.discoverProducts) return;
        
        console.log('🛍️  DISCOVERING PRODUCT LISTINGS...');
        
        const productLinks = Array.from(this.state.discoveredLinks).filter(link => 
            this.patterns.products.some(pattern => 
                typeof pattern === 'string' ? link.includes(pattern) : pattern.test(link)
            )
        );

        console.log(`   Found ${productLinks.length} product links`);
        
        // Sample some product pages to discover related links
        for (const productLink of productLinks.slice(0, 5)) {
            if (this.statistics.crawling.pagesVisited >= this.options.maxPages) break;
            
            await this.navigateToPage(productLink);
            
            // Extract links from product page (related products, etc.)
            await this.extractAndDiscoverLinks();
            
            // Go back
            await this.state.page.goBack();
            await this.state.page.waitForTimeout(this.options.clickDelay);
        }
    }

    /**
     * DISCOVER PAGINATION
     */
    async discoverPagination() {
        console.log('📄 DISCOVERING PAGINATION...');
        
        const paginationLinks = Array.from(this.state.discoveredLinks).filter(link => 
            this.patterns.pagination.some(pattern => 
                typeof pattern === 'string' ? link.includes(pattern) : pattern.test(link)
            )
        );

        console.log(`   Found ${paginationLinks.length} pagination links`);
        
        // Follow first few pagination links
        for (const pageLink of paginationLinks.slice(0, 3)) {
            if (this.statistics.crawling.pagesVisited >= this.options.maxPages) break;
            
            await this.navigateToPage(pageLink);
            await this.extractAndDiscoverLinks();
            
            // Go back
            await this.state.page.goBack();
            await this.state.page.waitForTimeout(this.options.clickDelay);
        }
    }

    /**
     * EXTRACT AND DISCOVER LINKS FROM CURRENT PAGE
     */
    async extractAndDiscoverLinks() {
        try {
            const links = await this.state.page.$$eval('a[href], [href]', (elements) => {
                return elements.map(element => {
                    try {
                        let href = element.href;
                        
                        // Handle relative URLs
                        if (href && !href.startsWith('http') && element.getAttribute('href')) {
                            const base = window.location.origin;
                            const relativeHref = element.getAttribute('href');
                            if (relativeHref.startsWith('/')) {
                                href = base + relativeHref;
                            } else if (relativeHref.startsWith('./') || relativeHref.startsWith('../')) {
                                href = new URL(relativeHref, window.location.href).href;
                            }
                        }
                        
                        return {
                            href: href,
                            text: element.textContent?.trim().substring(0, 100) || '',
                            title: element.getAttribute('title') || '',
                            tagName: element.tagName.toLowerCase(),
                            className: element.className || '',
                            isVisible: element.offsetWidth > 0 && element.offsetHeight > 0
                        };
                    } catch (error) {
                        return null;
                    }
                }).filter(item => item !== null && item.href);
            });

            let newLinksCount = 0;
            
            for (const link of links) {
                if (this.shouldDiscoverLink(link.href)) {
                    const normalizedURL = this.normalizeURL(link.href);
                    
                    if (!this.state.discoveredLinks.has(normalizedURL)) {
                        this.state.discoveredLinks.add(normalizedURL);
                        newLinksCount++;
                        
                        // Classify the link
                        if (this.isCategoryLink(link.href)) {
                            this.statistics.crawling.categoriesFound++;
                        } else if (this.isProductLink(link.href)) {
                            this.statistics.crawling.productsFound++;
                        }
                    }
                }
            }
            
            this.statistics.crawling.linksDiscovered = this.state.discoveredLinks.size;
            
            if (newLinksCount > 0) {
                console.log(`   🔍 Found ${newLinksCount} new links (Total: ${this.state.discoveredLinks.size})`);
            }
            
        } catch (error) {
            console.log('❌ LINK EXTRACTION FAILED:', error.message);
        }
    }

    /**
     * LINK FILTERING AND CLASSIFICATION
     */
    shouldDiscoverLink(url) {
        if (!url || !url.startsWith('http')) return false;
        if (url.includes('javascript:')) return false;
        if (url.includes('mailto:') || url.includes('tel:')) return false;
        if (url.length > 500) return false; // Too long, probably invalid
        
        // Only follow links from the same domain
        try {
            const urlObj = new URL(url);
            return urlObj.hostname === this.state.currentDomain;
        } catch {
            return false;
        }
    }

    shouldFollowLink(url) {
        if (!this.shouldDiscoverLink(url)) return false;
        
        // Don't follow these patterns to avoid infinite loops
        const avoidPatterns = [
            '/logout', '/signout', '/exit', '/leave',
            'add-to-cart', 'add-to-bag', 'checkout',
            'wishlist', 'favorites', 'account', 'login'
        ];
        
        return !avoidPatterns.some(pattern => url.includes(pattern));
    }

    isCategoryLink(url) {
        return this.patterns.categories.some(pattern => 
            typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)
        );
    }

    isProductLink(url) {
        return this.patterns.products.some(pattern => 
            typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)
        );
    }

    normalizeURL(url) {
        try {
            const urlObj = new URL(url);
            
            // Remove common tracking parameters
            const trackingParams = [
                'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
                'gclid', 'fbclid', 'trk', 'track', 'ref', 'source'
            ];
            
            trackingParams.forEach(param => urlObj.searchParams.delete(param));
            
            // Remove hash
            urlObj.hash = '';
            
            return urlObj.href;
        } catch {
            return url;
        }
    }

    /**
     * OUTPUT GENERATION
     */
    generateCSV(links, filename) {
        try {
            console.log(`💾 GENERATING COMPLETE CSV: ${filename}`);
            
            const headers = ['URL', 'Link Text', 'Title', 'Type', 'Category', 'Product'].join(',');
            const rows = links.map(link => {
                const isCategory = this.isCategoryLink(link);
                const isProduct = this.isProductLink(link);
                
                return [
                    `"${link.replace(/"/g, '""')}"`,
                    `""`, // Text would need to be stored separately
                    `""`, // Title would need to be stored separately
                    `"${isProduct ? 'Product' : isCategory ? 'Category' : 'Page'}"`,
                    `"${isCategory ? 'Yes' : 'No'}"`,
                    `"${isProduct ? 'Yes' : 'No'}"`
                ].join(',');
            });

            const csvContent = [headers, ...rows].join('\n');
            fs.writeFileSync(filename, csvContent, 'utf8');
            
            console.log(`✅ COMPLETE CSV GENERATED: ${filename}`);
            console.log(`📊 ${rows.length} links exported`);
            
            return true;
            
        } catch (error) {
            console.error('❌ CSV GENERATION FAILED:', error.message);
            return false;
        }
    }

    generateReport(links) {
        console.log('\n' + '='.repeat(100));
        console.log('📊 COMPLETE SITE CRAWLING REPORT');
        console.log('='.repeat(100));
        
        console.log(`🌐 TARGET: ${this.state.currentURL}`);
        console.log(`📅 TIMESTAMP: ${new Date().toISOString()}`);
        console.log(`⏱️  TOTAL DURATION: ${this.statistics.execution.totalDuration}ms`);
        
        console.log(`\n📊 CRAWLING STATISTICS:`);
        console.log(`   Pages Visited: ${this.statistics.crawling.pagesVisited}`);
        console.log(`   Links Discovered: ${this.statistics.crawling.linksDiscovered}`);
        console.log(`   Categories Found: ${this.statistics.crawling.categoriesFound}`);
        console.log(`   Products Found: ${this.statistics.crawling.productsFound}`);
        
        console.log(`\n📦 RESOURCE STATISTICS:`);
        console.log(`   Total Requests: ${this.statistics.resources.totalRequests}`);
        console.log(`   Blocked Requests: ${this.statistics.resources.blockedRequests}`);
        
        // Show link breakdown
        const categories = links.filter(link => this.isCategoryLink(link)).length;
        const products = links.filter(link => this.isProductLink(link)).length;
        const pages = links.length - categories - products;
        
        console.log(`\n🔗 LINK BREAKDOWN:`);
        console.log(`   Total Links: ${links.length}`);
        console.log(`   Category Links: ${categories}`);
        console.log(`   Product Links: ${products}`);
        console.log(`   Page Links: ${pages}`);
        
        console.log('\n📋 SAMPLE LINKS:');
        links.slice(0, 25).forEach((link, index) => {
            const type = this.isProductLink(link) ? '🛍️ ' : this.isCategoryLink(link) ? '📂' : '📄';
            console.log(`${index + 1}. ${type} ${this.truncateURL(link)}`);
        });
        
        if (links.length > 25) {
            console.log(`   ... and ${links.length - 25} more links`);
        }
        
        console.log(`\n🎉 COMPLETE CRAWLING FINISHED!`);
    }

    /**
     * MAIN EXECUTION
     */
    async execute(startURL) {
        try {
            console.log('🚀 EXECUTING COMPLETE SITE CRAWL...');
            console.log('='.repeat(70));
            
            if (!await this.initializeBrowser()) {
                throw new Error('Browser initialization failed');
            }
            
            const links = await this.crawlSite(startURL);
            
            if (links.length === 0) {
                throw new Error('No links discovered during crawling');
            }
            
            this.statistics.execution.endTime = Date.now();
            this.statistics.execution.totalDuration = this.statistics.execution.endTime - this.statistics.execution.startTime;
            
            if (this.options.outputFormat === 'csv') {
                this.generateCSV(links, this.options.outputFile);
            } else {
                this.generateReport(links);
            }
            
            console.log(`\n✅ CRAWLING COMPLETED SUCCESSFULLY!`);
            console.log(`📊 ${links.length} total links discovered`);
            console.log(`🌐 ${this.statistics.crawling.pagesVisited} pages visited`);
            console.log(`🛡️  ${this.statistics.resources.blockedRequests} tracking requests blocked`);
            
            return {
                success: true,
                links: links,
                statistics: this.statistics
            };
            
        } catch (error) {
            this.statistics.execution.endTime = Date.now();
            this.statistics.execution.totalDuration = this.statistics.execution.endTime - this.statistics.execution.startTime;
            
            console.error('💥 CRAWLING FAILED:', error.message);
            
            return {
                success: false,
                error: error.message,
                links: Array.from(this.state.discoveredLinks),
                statistics: this.statistics
            };
            
        } finally {
            await this.cleanup();
        }
    }

    async cleanup() {
        try {
            if (this.state.browser) {
                await this.state.browser.close();
                console.log('🧹 CRAWLER CLEANUP COMPLETED');
            }
        } catch (error) {
            console.log('⚠️  Cleanup warning:', error.message);
        }
    }

    truncateURL(url, length = 60) {
        return url.length > length ? url.substring(0, length) + '...' : url;
    }
}

/**
 * COMMAND LINE INTERFACE
 */
async function main() {
    const args = process.argv.slice(2);
    const url = args[0] || 'https://www.theoutnet.com/en-us';
    
    const options = {
        headless: false,
        debugMode: args.includes('--debug'),
        outputFormat: args.includes('--output') ? args[args.indexOf('--output') + 1] : 'console',
        outputFile: args.includes('--file') ? args[args.indexOf('--file') + 1] : 'complete-links.csv',
        maxPages: 100, // Increase page limit
        maxDepth: 3
    };

    console.log('🚀 COMPLETE SITE CRAWLER - DISCOVERS ALL LINKS');
    console.log('='.repeat(80));
    console.log(`🌐 TARGET: ${url}`);
    console.log(`📊 MAX PAGES: ${options.maxPages}`);
    console.log(`🔍 STRATEGY: Navigation clicking + Category discovery + Pagination`);
    console.log('='.repeat(80));

    const crawler = new CompleteSiteCrawler(options);
    
    try {
        const result = await crawler.execute(url);
        
        if (result.success) {
            console.log(`\n🎉 SUCCESS! Discovered ${result.links.length} links`);
            process.exit(0);
        } else {
            console.log(`\n💥 FAILED: ${result.error}`);
            process.exit(1);
        }
        
    } catch (error) {
        console.error('💥 FATAL ERROR:', error);
        process.exit(1);
    }
}

module.exports = { CompleteSiteCrawler, main };

if (require.main === module) {
    main();
}const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/**
 * COMPLETE SITE CRAWLER - 600+ LINES
 * CLICKS THROUGH NAVIGATION TO DISCOVER ALL LINKS
 */

class CompleteSiteCrawler {
    constructor(options = {}) {
        this.options = {
            // Crawling configuration
            headless: false,
            maxDepth: 3,
            maxPages: 50,
            clickNavigation: true,
            followInternalLinks: true,
            discoverProductPages: true,
            
            // Timing configuration
            timeout: 30000,
            navigationTimeout: 45000,
            clickDelay: 1000,
            pageLoadDelay: 2000,
            
            // Discovery configuration
            discoverCategories: true,
            discoverProducts: true,
            discoverFilters: true,
            discoverPagination: true,
            
            // Blocking configuration
            blockAnalytics: true,
            blockAds: true,
            
            // Output configuration
            outputFormat: 'console',
            outputFile: 'complete-links.csv',
            debugMode: false,
            
            // Merge user options
            ...options
        };

        this.statistics = {
            execution: {
                startTime: null,
                endTime: null,
                totalDuration: null
            },
            crawling: {
                pagesVisited: 0,
                linksDiscovered: 0,
                uniqueLinks: 0,
                categoriesFound: 0,
                productsFound: 0
            },
            resources: {
                totalRequests: 0,
                blockedRequests: 0
            }
        };

        this.state = {
            browser: null,
            context: null,
            page: null,
            currentURL: null,
            currentDomain: null,
            discoveredLinks: new Set(),
            visitedURLs: new Set(),
            navigationStack: [],
            isCrawling: false
        };

        // Pattern matching for different link types
        this.patterns = {
            categories: [
                '/shop/', '/category/', '/collection/', '/departments/',
                '/women/', '/men/', '/sale/', '/new/', '/bestsellers/'
            ],
            products: [
                '/product/', '/item/', '/p/', '/detail/',
                /\/[A-Z0-9]{6,}/, // Product codes
                /-\d+\.html/ // Product pages
            ],
            filters: [
                'size=', 'color=', 'brand=', 'price=',
                'category=', 'filter=', 'sort='
            ],
            pagination: [
                'page=', 'p=', 'offset=', 'start=',
                '/page/', '/p/'
            ]
        };

        console.log('🔧 COMPLETE SITE CRAWLER INITIALIZED');
        console.log(`📊 Max Depth: ${this.options.maxDepth}, Max Pages: ${this.options.maxPages}`);
    }

    /**
     * BROWSER INITIALIZATION
     */
    async initializeBrowser() {
        try {
            this.statistics.execution.startTime = Date.now();
            
            console.log('🚀 INITIALIZING CRAWLER BROWSER...');
            
            this.state.browser = await chromium.launch({ 
                headless: this.options.headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--window-size=1920,1080',
                    '--disable-web-security',
                    '--ignore-certificate-errors'
                ]
            });

            this.state.context = await this.state.browser.newContext({
                viewport: { width: 1920, height: 1080 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ignoreHTTPSErrors: true
            });

            // Stealth measures
            await this.state.context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

            this.state.page = await this.state.context.newPage();
            this.state.page.setDefaultTimeout(this.options.timeout);
            
            await this.setupRequestInterception();
            
            console.log('✅ CRAWLER BROWSER INITIALIZED');
            return true;
            
        } catch (error) {
            console.error('❌ BROWSER INITIALIZATION FAILED:', error);
            return false;
        }
    }

    /**
     * REQUEST INTERCEPTION
     */
    async setupRequestInterception() {
        await this.state.page.route('**/*', (route) => {
            const url = route.request().url();
            this.statistics.resources.totalRequests++;

            // Block analytics and ads
            const blockedDomains = [
                'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
                'facebook.com', 'facebook.net', 'analytics.tiktok.com', 'bat.bing.com'
            ];

            if (blockedDomains.some(domain => url.includes(domain)) ||
                /\/track|\/pixel|\/beacon|\/analytics|\/gtm\.js/.test(url)) {
                this.statistics.resources.blockedRequests++;
                route.abort();
                return;
            }

            route.continue();
        });

        console.log('✅ REQUEST INTERCEPTION CONFIGURED');
    }

    /**
     * MAIN CRAWLING ENGINE
     */
    async crawlSite(startURL) {
        try {
            console.log('🚀 STARTING COMPLETE SITE CRAWL...');
            console.log(`🌐 START URL: ${startURL}`);
            
            this.state.currentURL = startURL;
            const urlObj = new URL(startURL);
            this.state.currentDomain = urlObj.hostname;
            
            // Start with the main page
            await this.navigateToPage(startURL);
            
            // Extract initial links
            await this.extractAndDiscoverLinks();
            
            // Click through main navigation to discover categories
            await this.clickNavigationMenus();
            
            // Discover category pages
            await this.discoverCategoryPages();
            
            // Discover product listings
            await this.discoverProductListings();
            
            // Follow pagination if enabled
            if (this.options.discoverPagination) {
                await this.discoverPagination();
            }
            
            console.log('✅ CRAWLING COMPLETED');
            return Array.from(this.state.discoveredLinks);
            
        } catch (error) {
            console.error('❌ CRAWLING FAILED:', error.message);
            return Array.from(this.state.discoveredLinks);
        }
    }

    /**
     * NAVIGATE TO PAGE
     */
    async navigateToPage(url) {
        try {
            if (this.state.visitedURLs.has(url)) {
                return false;
            }
            
            console.log(`🧭 NAVIGATING TO: ${this.truncateURL(url)}`);
            
            await this.state.page.goto(url, {
                waitUntil: 'load',
                timeout: this.options.navigationTimeout
            });
            
            await this.state.page.waitForTimeout(this.options.pageLoadDelay);
            
            this.state.visitedURLs.add(url);
            this.statistics.crawling.pagesVisited++;
            this.state.currentURL = url;
            
            // Extract links from this page
            await this.extractAndDiscoverLinks();
            
            return true;
            
        } catch (error) {
            console.log(`❌ NAVIGATION FAILED: ${this.truncateURL(url)} - ${error.message}`);
            return false;
        }
    }

    /**
     * CLICK THROUGH NAVIGATION MENUS
     */
    async clickNavigationMenus() {
        if (!this.options.clickNavigation) return;
        
        console.log('🖱️  CLICKING THROUGH NAVIGATION MENUS...');
        
        const navigationSelectors = [
            // Main navigation
            'nav a', '.navigation a', '.menu a', '.nav a',
            '.header a', '.main-nav a', '.primary-nav a',
            // Dropdowns
            '.dropdown a', '.submenu a', '.megamenu a',
            // Category links
            '[href*="/shop/"]', '[href*="/category/"]', '[href*="/collection/"]',
            // Specific to THE OUTNET
            '[data-testid*="nav"]', '[class*="nav-item"]', '[class*="menu-item"]'
        ];

        for (const selector of navigationSelectors) {
            try {
                const links = await this.state.page.$$eval(selector, elements => 
                    elements.map(el => ({
                        href: el.href,
                        text: el.textContent?.trim(),
                        isVisible: el.offsetWidth > 0 && el.offsetHeight > 0
                    })).filter(link => 
                        link.href && 
                        link.isVisible &&
                        !link.href.includes('#') &&
                        !link.href.includes('javascript:')
                    )
                );

                for (const link of links.slice(0, 10)) { // Limit to first 10 per selector
                    if (this.shouldFollowLink(link.href) && this.state.discoveredLinks.size < 1000) {
                        console.log(`   👆 Clicking: ${this.truncateURL(link.href)}`);
                        
                        try {
                            await this.state.page.click(`${selector}[href="${link.href}"]`, { timeout: 5000 });
                            await this.state.page.waitForTimeout(this.options.clickDelay);
                            
                            // Extract links from new page
                            await this.extractAndDiscoverLinks();
                            
                            // Go back to original page
                            await this.state.page.goBack();
                            await this.state.page.waitForTimeout(this.options.clickDelay);
                            
                        } catch (clickError) {
                            console.log(`   ❌ Click failed: ${clickError.message}`);
                        }
                    }
                }
            } catch (error) {
                // Selector not found, continue
            }
        }
    }

    /**
     * DISCOVER CATEGORY PAGES
     */
    async discoverCategoryPages() {
        if (!this.options.discoverCategories) return;
        
        console.log('📂 DISCOVERING CATEGORY PAGES...');
        
        const categoryLinks = Array.from(this.state.discoveredLinks).filter(link => 
            this.patterns.categories.some(pattern => 
                typeof pattern === 'string' ? link.includes(pattern) : pattern.test(link)
            )
        );

        console.log(`   Found ${categoryLinks.length} category links`);
        
        // Visit up to 10 category pages to discover more links
        for (const categoryLink of categoryLinks.slice(0, 10)) {
            if (this.statistics.crawling.pagesVisited >= this.options.maxPages) break;
            
            await this.navigateToPage(categoryLink);
            
            // Extract more links from category page
            await this.extractAndDiscoverLinks();
            
            // Go back to maintain state
            await this.state.page.goBack();
            await this.state.page.waitForTimeout(this.options.clickDelay);
        }
    }

    /**
     * DISCOVER PRODUCT LISTINGS
     */
    async discoverProductListings() {
        if (!this.options.discoverProducts) return;
        
        console.log('🛍️  DISCOVERING PRODUCT LISTINGS...');
        
        const productLinks = Array.from(this.state.discoveredLinks).filter(link => 
            this.patterns.products.some(pattern => 
                typeof pattern === 'string' ? link.includes(pattern) : pattern.test(link)
            )
        );

        console.log(`   Found ${productLinks.length} product links`);
        
        // Sample some product pages to discover related links
        for (const productLink of productLinks.slice(0, 5)) {
            if (this.statistics.crawling.pagesVisited >= this.options.maxPages) break;
            
            await this.navigateToPage(productLink);
            
            // Extract links from product page (related products, etc.)
            await this.extractAndDiscoverLinks();
            
            // Go back
            await this.state.page.goBack();
            await this.state.page.waitForTimeout(this.options.clickDelay);
        }
    }

    /**
     * DISCOVER PAGINATION
     */
    async discoverPagination() {
        console.log('📄 DISCOVERING PAGINATION...');
        
        const paginationLinks = Array.from(this.state.discoveredLinks).filter(link => 
            this.patterns.pagination.some(pattern => 
                typeof pattern === 'string' ? link.includes(pattern) : pattern.test(link)
            )
        );

        console.log(`   Found ${paginationLinks.length} pagination links`);
        
        // Follow first few pagination links
        for (const pageLink of paginationLinks.slice(0, 3)) {
            if (this.statistics.crawling.pagesVisited >= this.options.maxPages) break;
            
            await this.navigateToPage(pageLink);
            await this.extractAndDiscoverLinks();
            
            // Go back
            await this.state.page.goBack();
            await this.state.page.waitForTimeout(this.options.clickDelay);
        }
    }

    /**
     * EXTRACT AND DISCOVER LINKS FROM CURRENT PAGE
     */
    async extractAndDiscoverLinks() {
        try {
            const links = await this.state.page.$$eval('a[href], [href]', (elements) => {
                return elements.map(element => {
                    try {
                        let href = element.href;
                        
                        // Handle relative URLs
                        if (href && !href.startsWith('http') && element.getAttribute('href')) {
                            const base = window.location.origin;
                            const relativeHref = element.getAttribute('href');
                            if (relativeHref.startsWith('/')) {
                                href = base + relativeHref;
                            } else if (relativeHref.startsWith('./') || relativeHref.startsWith('../')) {
                                href = new URL(relativeHref, window.location.href).href;
                            }
                        }
                        
                        return {
                            href: href,
                            text: element.textContent?.trim().substring(0, 100) || '',
                            title: element.getAttribute('title') || '',
                            tagName: element.tagName.toLowerCase(),
                            className: element.className || '',
                            isVisible: element.offsetWidth > 0 && element.offsetHeight > 0
                        };
                    } catch (error) {
                        return null;
                    }
                }).filter(item => item !== null && item.href);
            });

            let newLinksCount = 0;
            
            for (const link of links) {
                if (this.shouldDiscoverLink(link.href)) {
                    const normalizedURL = this.normalizeURL(link.href);
                    
                    if (!this.state.discoveredLinks.has(normalizedURL)) {
                        this.state.discoveredLinks.add(normalizedURL);
                        newLinksCount++;
                        
                        // Classify the link
                        if (this.isCategoryLink(link.href)) {
                            this.statistics.crawling.categoriesFound++;
                        } else if (this.isProductLink(link.href)) {
                            this.statistics.crawling.productsFound++;
                        }
                    }
                }
            }
            
            this.statistics.crawling.linksDiscovered = this.state.discoveredLinks.size;
            
            if (newLinksCount > 0) {
                console.log(`   🔍 Found ${newLinksCount} new links (Total: ${this.state.discoveredLinks.size})`);
            }
            
        } catch (error) {
            console.log('❌ LINK EXTRACTION FAILED:', error.message);
        }
    }

    /**
     * LINK FILTERING AND CLASSIFICATION
     */
    shouldDiscoverLink(url) {
        if (!url || !url.startsWith('http')) return false;
        if (url.includes('javascript:')) return false;
        if (url.includes('mailto:') || url.includes('tel:')) return false;
        if (url.length > 500) return false; // Too long, probably invalid
        
        // Only follow links from the same domain
        try {
            const urlObj = new URL(url);
            return urlObj.hostname === this.state.currentDomain;
        } catch {
            return false;
        }
    }

    shouldFollowLink(url) {
        if (!this.shouldDiscoverLink(url)) return false;
        
        // Don't follow these patterns to avoid infinite loops
        const avoidPatterns = [
            '/logout', '/signout', '/exit', '/leave',
            'add-to-cart', 'add-to-bag', 'checkout',
            'wishlist', 'favorites', 'account', 'login'
        ];
        
        return !avoidPatterns.some(pattern => url.includes(pattern));
    }

    isCategoryLink(url) {
        return this.patterns.categories.some(pattern => 
            typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)
        );
    }

    isProductLink(url) {
        return this.patterns.products.some(pattern => 
            typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)
        );
    }

    normalizeURL(url) {
        try {
            const urlObj = new URL(url);
            
            // Remove common tracking parameters
            const trackingParams = [
                'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
                'gclid', 'fbclid', 'trk', 'track', 'ref', 'source'
            ];
            
            trackingParams.forEach(param => urlObj.searchParams.delete(param));
            
            // Remove hash
            urlObj.hash = '';
            
            return urlObj.href;
        } catch {
            return url;
        }
    }

    /**
     * OUTPUT GENERATION
     */
    generateCSV(links, filename) {
        try {
            console.log(`💾 GENERATING COMPLETE CSV: ${filename}`);
            
            const headers = ['URL', 'Link Text', 'Title', 'Type', 'Category', 'Product'].join(',');
            const rows = links.map(link => {
                const isCategory = this.isCategoryLink(link);
                const isProduct = this.isProductLink(link);
                
                return [
                    `"${link.replace(/"/g, '""')}"`,
                    `""`, // Text would need to be stored separately
                    `""`, // Title would need to be stored separately
                    `"${isProduct ? 'Product' : isCategory ? 'Category' : 'Page'}"`,
                    `"${isCategory ? 'Yes' : 'No'}"`,
                    `"${isProduct ? 'Yes' : 'No'}"`
                ].join(',');
            });

            const csvContent = [headers, ...rows].join('\n');
            fs.writeFileSync(filename, csvContent, 'utf8');
            
            console.log(`✅ COMPLETE CSV GENERATED: ${filename}`);
            console.log(`📊 ${rows.length} links exported`);
            
            return true;
            
        } catch (error) {
            console.error('❌ CSV GENERATION FAILED:', error.message);
            return false;
        }
    }

    generateReport(links) {
        console.log('\n' + '='.repeat(100));
        console.log('📊 COMPLETE SITE CRAWLING REPORT');
        console.log('='.repeat(100));
        
        console.log(`🌐 TARGET: ${this.state.currentURL}`);
        console.log(`📅 TIMESTAMP: ${new Date().toISOString()}`);
        console.log(`⏱️  TOTAL DURATION: ${this.statistics.execution.totalDuration}ms`);
        
        console.log(`\n📊 CRAWLING STATISTICS:`);
        console.log(`   Pages Visited: ${this.statistics.crawling.pagesVisited}`);
        console.log(`   Links Discovered: ${this.statistics.crawling.linksDiscovered}`);
        console.log(`   Categories Found: ${this.statistics.crawling.categoriesFound}`);
        console.log(`   Products Found: ${this.statistics.crawling.productsFound}`);
        
        console.log(`\n📦 RESOURCE STATISTICS:`);
        console.log(`   Total Requests: ${this.statistics.resources.totalRequests}`);
        console.log(`   Blocked Requests: ${this.statistics.resources.blockedRequests}`);
        
        // Show link breakdown
        const categories = links.filter(link => this.isCategoryLink(link)).length;
        const products = links.filter(link => this.isProductLink(link)).length;
        const pages = links.length - categories - products;
        
        console.log(`\n🔗 LINK BREAKDOWN:`);
        console.log(`   Total Links: ${links.length}`);
        console.log(`   Category Links: ${categories}`);
        console.log(`   Product Links: ${products}`);
        console.log(`   Page Links: ${pages}`);
        
        console.log('\n📋 SAMPLE LINKS:');
        links.slice(0, 25).forEach((link, index) => {
            const type = this.isProductLink(link) ? '🛍️ ' : this.isCategoryLink(link) ? '📂' : '📄';
            console.log(`${index + 1}. ${type} ${this.truncateURL(link)}`);
        });
        
        if (links.length > 25) {
            console.log(`   ... and ${links.length - 25} more links`);
        }
        
        console.log(`\n🎉 COMPLETE CRAWLING FINISHED!`);
    }

    /**
     * MAIN EXECUTION
     */
    async execute(startURL) {
        try {
            console.log('🚀 EXECUTING COMPLETE SITE CRAWL...');
            console.log('='.repeat(70));
            
            if (!await this.initializeBrowser()) {
                throw new Error('Browser initialization failed');
            }
            
            const links = await this.crawlSite(startURL);
            
            if (links.length === 0) {
                throw new Error('No links discovered during crawling');
            }
            
            this.statistics.execution.endTime = Date.now();
            this.statistics.execution.totalDuration = this.statistics.execution.endTime - this.statistics.execution.startTime;
            
            if (this.options.outputFormat === 'csv') {
                this.generateCSV(links, this.options.outputFile);
            } else {
                this.generateReport(links);
            }
            
            console.log(`\n✅ CRAWLING COMPLETED SUCCESSFULLY!`);
            console.log(`📊 ${links.length} total links discovered`);
            console.log(`🌐 ${this.statistics.crawling.pagesVisited} pages visited`);
            console.log(`🛡️  ${this.statistics.resources.blockedRequests} tracking requests blocked`);
            
            return {
                success: true,
                links: links,
                statistics: this.statistics
            };
            
        } catch (error) {
            this.statistics.execution.endTime = Date.now();
            this.statistics.execution.totalDuration = this.statistics.execution.endTime - this.statistics.execution.startTime;
            
            console.error('💥 CRAWLING FAILED:', error.message);
            
            return {
                success: false,
                error: error.message,
                links: Array.from(this.state.discoveredLinks),
                statistics: this.statistics
            };
            
        } finally {
            await this.cleanup();
        }
    }

    async cleanup() {
        try {
            if (this.state.browser) {
                await this.state.browser.close();
                console.log('🧹 CRAWLER CLEANUP COMPLETED');
            }
        } catch (error) {
            console.log('⚠️  Cleanup warning:', error.message);
        }
    }

    truncateURL(url, length = 60) {
        return url.length > length ? url.substring(0, length) + '...' : url;
    }
}

/**
 * COMMAND LINE INTERFACE
 */
async function main() {
    const args = process.argv.slice(2);
    const url = args[0] || 'https://www.theoutnet.com/en-us';
    
    const options = {
        headless: false,
        debugMode: args.includes('--debug'),
        outputFormat: args.includes('--output') ? args[args.indexOf('--output') + 1] : 'console',
        outputFile: args.includes('--file') ? args[args.indexOf('--file') + 1] : 'complete-links.csv',
        maxPages: 100, // Increase page limit
        maxDepth: 3
    };

    console.log('🚀 COMPLETE SITE CRAWLER - DISCOVERS ALL LINKS');
    console.log('='.repeat(80));
    console.log(`🌐 TARGET: ${url}`);
    console.log(`📊 MAX PAGES: ${options.maxPages}`);
    console.log(`🔍 STRATEGY: Navigation clicking + Category discovery + Pagination`);
    console.log('='.repeat(80));

    const crawler = new CompleteSiteCrawler(options);
    
    try {
        const result = await crawler.execute(url);
        
        if (result.success) {
            console.log(`\n🎉 SUCCESS! Discovered ${result.links.length} links`);
            process.exit(0);
        } else {
            console.log(`\n💥 FAILED: ${result.error}`);
            process.exit(1);
        }
        
    } catch (error) {
        console.error('💥 FATAL ERROR:', error);
        process.exit(1);
    }
}

module.exports = { CompleteSiteCrawler, main };

if (require.main === module) {
    main();
}const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/**
 * COMPLETE SITE CRAWLER - 600+ LINES
 * CLICKS THROUGH NAVIGATION TO DISCOVER ALL LINKS
 */

class CompleteSiteCrawler {
    constructor(options = {}) {
        this.options = {
            // Crawling configuration
            headless: false,
            maxDepth: 3,
            maxPages: 50,
            clickNavigation: true,
            followInternalLinks: true,
            discoverProductPages: true,
            
            // Timing configuration
            timeout: 30000,
            navigationTimeout: 45000,
            clickDelay: 1000,
            pageLoadDelay: 2000,
            
            // Discovery configuration
            discoverCategories: true,
            discoverProducts: true,
            discoverFilters: true,
            discoverPagination: true,
            
            // Blocking configuration
            blockAnalytics: true,
            blockAds: true,
            
            // Output configuration
            outputFormat: 'console',
            outputFile: 'complete-links.csv',
            debugMode: false,
            
            // Merge user options
            ...options
        };

        this.statistics = {
            execution: {
                startTime: null,
                endTime: null,
                totalDuration: null
            },
            crawling: {
                pagesVisited: 0,
                linksDiscovered: 0,
                uniqueLinks: 0,
                categoriesFound: 0,
                productsFound: 0
            },
            resources: {
                totalRequests: 0,
                blockedRequests: 0
            }
        };

        this.state = {
            browser: null,
            context: null,
            page: null,
            currentURL: null,
            currentDomain: null,
            discoveredLinks: new Set(),
            visitedURLs: new Set(),
            navigationStack: [],
            isCrawling: false
        };

        // Pattern matching for different link types
        this.patterns = {
            categories: [
                '/shop/', '/category/', '/collection/', '/departments/',
                '/women/', '/men/', '/sale/', '/new/', '/bestsellers/'
            ],
            products: [
                '/product/', '/item/', '/p/', '/detail/',
                /\/[A-Z0-9]{6,}/, // Product codes
                /-\d+\.html/ // Product pages
            ],
            filters: [
                'size=', 'color=', 'brand=', 'price=',
                'category=', 'filter=', 'sort='
            ],
            pagination: [
                'page=', 'p=', 'offset=', 'start=',
                '/page/', '/p/'
            ]
        };

        console.log('🔧 COMPLETE SITE CRAWLER INITIALIZED');
        console.log(`📊 Max Depth: ${this.options.maxDepth}, Max Pages: ${this.options.maxPages}`);
    }

    /**
     * BROWSER INITIALIZATION
     */
    async initializeBrowser() {
        try {
            this.statistics.execution.startTime = Date.now();
            
            console.log('🚀 INITIALIZING CRAWLER BROWSER...');
            
            this.state.browser = await chromium.launch({ 
                headless: this.options.headless,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-blink-features=AutomationControlled',
                    '--window-size=1920,1080',
                    '--disable-web-security',
                    '--ignore-certificate-errors'
                ]
            });

            this.state.context = await this.state.browser.newContext({
                viewport: { width: 1920, height: 1080 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                ignoreHTTPSErrors: true
            });

            // Stealth measures
            await this.state.context.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

            this.state.page = await this.state.context.newPage();
            this.state.page.setDefaultTimeout(this.options.timeout);
            
            await this.setupRequestInterception();
            
            console.log('✅ CRAWLER BROWSER INITIALIZED');
            return true;
            
        } catch (error) {
            console.error('❌ BROWSER INITIALIZATION FAILED:', error);
            return false;
        }
    }

    /**
     * REQUEST INTERCEPTION
     */
    async setupRequestInterception() {
        await this.state.page.route('**/*', (route) => {
            const url = route.request().url();
            this.statistics.resources.totalRequests++;

            // Block analytics and ads
            const blockedDomains = [
                'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
                'facebook.com', 'facebook.net', 'analytics.tiktok.com', 'bat.bing.com'
            ];

            if (blockedDomains.some(domain => url.includes(domain)) ||
                /\/track|\/pixel|\/beacon|\/analytics|\/gtm\.js/.test(url)) {
                this.statistics.resources.blockedRequests++;
                route.abort();
                return;
            }

            route.continue();
        });

        console.log('✅ REQUEST INTERCEPTION CONFIGURED');
    }

    /**
     * MAIN CRAWLING ENGINE
     */
    async crawlSite(startURL) {
        try {
            console.log('🚀 STARTING COMPLETE SITE CRAWL...');
            console.log(`🌐 START URL: ${startURL}`);
            
            this.state.currentURL = startURL;
            const urlObj = new URL(startURL);
            this.state.currentDomain = urlObj.hostname;
            
            // Start with the main page
            await this.navigateToPage(startURL);
            
            // Extract initial links
            await this.extractAndDiscoverLinks();
            
            // Click through main navigation to discover categories
            await this.clickNavigationMenus();
            
            // Discover category pages
            await this.discoverCategoryPages();
            
            // Discover product listings
            await this.discoverProductListings();
            
            // Follow pagination if enabled
            if (this.options.discoverPagination) {
                await this.discoverPagination();
            }
            
            console.log('✅ CRAWLING COMPLETED');
            return Array.from(this.state.discoveredLinks);
            
        } catch (error) {
            console.error('❌ CRAWLING FAILED:', error.message);
            return Array.from(this.state.discoveredLinks);
        }
    }

    /**
     * NAVIGATE TO PAGE
     */
    async navigateToPage(url) {
        try {
            if (this.state.visitedURLs.has(url)) {
                return false;
            }
            
            console.log(`🧭 NAVIGATING TO: ${this.truncateURL(url)}`);
            
            await this.state.page.goto(url, {
                waitUntil: 'load',
                timeout: this.options.navigationTimeout
            });
            
            await this.state.page.waitForTimeout(this.options.pageLoadDelay);
            
            this.state.visitedURLs.add(url);
            this.statistics.crawling.pagesVisited++;
            this.state.currentURL = url;
            
            // Extract links from this page
            await this.extractAndDiscoverLinks();
            
            return true;
            
        } catch (error) {
            console.log(`❌ NAVIGATION FAILED: ${this.truncateURL(url)} - ${error.message}`);
            return false;
        }
    }

    /**
     * CLICK THROUGH NAVIGATION MENUS
     */
    async clickNavigationMenus() {
        if (!this.options.clickNavigation) return;
        
        console.log('🖱️  CLICKING THROUGH NAVIGATION MENUS...');
        
        const navigationSelectors = [
            // Main navigation
            'nav a', '.navigation a', '.menu a', '.nav a',
            '.header a', '.main-nav a', '.primary-nav a',
            // Dropdowns
            '.dropdown a', '.submenu a', '.megamenu a',
            // Category links
            '[href*="/shop/"]', '[href*="/category/"]', '[href*="/collection/"]',
            // Specific to THE OUTNET
            '[data-testid*="nav"]', '[class*="nav-item"]', '[class*="menu-item"]'
        ];

        for (const selector of navigationSelectors) {
            try {
                const links = await this.state.page.$$eval(selector, elements => 
                    elements.map(el => ({
                        href: el.href,
                        text: el.textContent?.trim(),
                        isVisible: el.offsetWidth > 0 && el.offsetHeight > 0
                    })).filter(link => 
                        link.href && 
                        link.isVisible &&
                        !link.href.includes('#') &&
                        !link.href.includes('javascript:')
                    )
                );

                for (const link of links.slice(0, 10)) { // Limit to first 10 per selector
                    if (this.shouldFollowLink(link.href) && this.state.discoveredLinks.size < 1000) {
                        console.log(`   👆 Clicking: ${this.truncateURL(link.href)}`);
                        
                        try {
                            await this.state.page.click(`${selector}[href="${link.href}"]`, { timeout: 5000 });
                            await this.state.page.waitForTimeout(this.options.clickDelay);
                            
                            // Extract links from new page
                            await this.extractAndDiscoverLinks();
                            
                            // Go back to original page
                            await this.state.page.goBack();
                            await this.state.page.waitForTimeout(this.options.clickDelay);
                            
                        } catch (clickError) {
                            console.log(`   ❌ Click failed: ${clickError.message}`);
                        }
                    }
                }
            } catch (error) {
                // Selector not found, continue
            }
        }
    }

    /**
     * DISCOVER CATEGORY PAGES
     */
    async discoverCategoryPages() {
        if (!this.options.discoverCategories) return;
        
        console.log('📂 DISCOVERING CATEGORY PAGES...');
        
        const categoryLinks = Array.from(this.state.discoveredLinks).filter(link => 
            this.patterns.categories.some(pattern => 
                typeof pattern === 'string' ? link.includes(pattern) : pattern.test(link)
            )
        );

        console.log(`   Found ${categoryLinks.length} category links`);
        
        // Visit up to 10 category pages to discover more links
        for (const categoryLink of categoryLinks.slice(0, 10)) {
            if (this.statistics.crawling.pagesVisited >= this.options.maxPages) break;
            
            await this.navigateToPage(categoryLink);
            
            // Extract more links from category page
            await this.extractAndDiscoverLinks();
            
            // Go back to maintain state
            await this.state.page.goBack();
            await this.state.page.waitForTimeout(this.options.clickDelay);
        }
    }

    /**
     * DISCOVER PRODUCT LISTINGS
     */
    async discoverProductListings() {
        if (!this.options.discoverProducts) return;
        
        console.log('🛍️  DISCOVERING PRODUCT LISTINGS...');
        
        const productLinks = Array.from(this.state.discoveredLinks).filter(link => 
            this.patterns.products.some(pattern => 
                typeof pattern === 'string' ? link.includes(pattern) : pattern.test(link)
            )
        );

        console.log(`   Found ${productLinks.length} product links`);
        
        // Sample some product pages to discover related links
        for (const productLink of productLinks.slice(0, 5)) {
            if (this.statistics.crawling.pagesVisited >= this.options.maxPages) break;
            
            await this.navigateToPage(productLink);
            
            // Extract links from product page (related products, etc.)
            await this.extractAndDiscoverLinks();
            
            // Go back
            await this.state.page.goBack();
            await this.state.page.waitForTimeout(this.options.clickDelay);
        }
    }

    /**
     * DISCOVER PAGINATION
     */
    async discoverPagination() {
        console.log('📄 DISCOVERING PAGINATION...');
        
        const paginationLinks = Array.from(this.state.discoveredLinks).filter(link => 
            this.patterns.pagination.some(pattern => 
                typeof pattern === 'string' ? link.includes(pattern) : pattern.test(link)
            )
        );

        console.log(`   Found ${paginationLinks.length} pagination links`);
        
        // Follow first few pagination links
        for (const pageLink of paginationLinks.slice(0, 3)) {
            if (this.statistics.crawling.pagesVisited >= this.options.maxPages) break;
            
            await this.navigateToPage(pageLink);
            await this.extractAndDiscoverLinks();
            
            // Go back
            await this.state.page.goBack();
            await this.state.page.waitForTimeout(this.options.clickDelay);
        }
    }

    /**
     * EXTRACT AND DISCOVER LINKS FROM CURRENT PAGE
     */
    async extractAndDiscoverLinks() {
        try {
            const links = await this.state.page.$$eval('a[href], [href]', (elements) => {
                return elements.map(element => {
                    try {
                        let href = element.href;
                        
                        // Handle relative URLs
                        if (href && !href.startsWith('http') && element.getAttribute('href')) {
                            const base = window.location.origin;
                            const relativeHref = element.getAttribute('href');
                            if (relativeHref.startsWith('/')) {
                                href = base + relativeHref;
                            } else if (relativeHref.startsWith('./') || relativeHref.startsWith('../')) {
                                href = new URL(relativeHref, window.location.href).href;
                            }
                        }
                        
                        return {
                            href: href,
                            text: element.textContent?.trim().substring(0, 100) || '',
                            title: element.getAttribute('title') || '',
                            tagName: element.tagName.toLowerCase(),
                            className: element.className || '',
                            isVisible: element.offsetWidth > 0 && element.offsetHeight > 0
                        };
                    } catch (error) {
                        return null;
                    }
                }).filter(item => item !== null && item.href);
            });

            let newLinksCount = 0;
            
            for (const link of links) {
                if (this.shouldDiscoverLink(link.href)) {
                    const normalizedURL = this.normalizeURL(link.href);
                    
                    if (!this.state.discoveredLinks.has(normalizedURL)) {
                        this.state.discoveredLinks.add(normalizedURL);
                        newLinksCount++;
                        
                        // Classify the link
                        if (this.isCategoryLink(link.href)) {
                            this.statistics.crawling.categoriesFound++;
                        } else if (this.isProductLink(link.href)) {
                            this.statistics.crawling.productsFound++;
                        }
                    }
                }
            }
            
            this.statistics.crawling.linksDiscovered = this.state.discoveredLinks.size;
            
            if (newLinksCount > 0) {
                console.log(`   🔍 Found ${newLinksCount} new links (Total: ${this.state.discoveredLinks.size})`);
            }
            
        } catch (error) {
            console.log('❌ LINK EXTRACTION FAILED:', error.message);
        }
    }

    /**
     * LINK FILTERING AND CLASSIFICATION
     */
    shouldDiscoverLink(url) {
        if (!url || !url.startsWith('http')) return false;
        if (url.includes('javascript:')) return false;
        if (url.includes('mailto:') || url.includes('tel:')) return false;
        if (url.length > 500) return false; // Too long, probably invalid
        
        // Only follow links from the same domain
        try {
            const urlObj = new URL(url);
            return urlObj.hostname === this.state.currentDomain;
        } catch {
            return false;
        }
    }

    shouldFollowLink(url) {
        if (!this.shouldDiscoverLink(url)) return false;
        
        // Don't follow these patterns to avoid infinite loops
        const avoidPatterns = [
            '/logout', '/signout', '/exit', '/leave',
            'add-to-cart', 'add-to-bag', 'checkout',
            'wishlist', 'favorites', 'account', 'login'
        ];
        
        return !avoidPatterns.some(pattern => url.includes(pattern));
    }

    isCategoryLink(url) {
        return this.patterns.categories.some(pattern => 
            typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)
        );
    }

    isProductLink(url) {
        return this.patterns.products.some(pattern => 
            typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)
        );
    }

    normalizeURL(url) {
        try {
            const urlObj = new URL(url);
            
            // Remove common tracking parameters
            const trackingParams = [
                'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
                'gclid', 'fbclid', 'trk', 'track', 'ref', 'source'
            ];
            
            trackingParams.forEach(param => urlObj.searchParams.delete(param));
            
            // Remove hash
            urlObj.hash = '';
            
            return urlObj.href;
        } catch {
            return url;
        }
    }

    /**
     * OUTPUT GENERATION
     */
    generateCSV(links, filename) {
        try {
            console.log(`💾 GENERATING COMPLETE CSV: ${filename}`);
            
            const headers = ['URL', 'Link Text', 'Title', 'Type', 'Category', 'Product'].join(',');
            const rows = links.map(link => {
                const isCategory = this.isCategoryLink(link);
                const isProduct = this.isProductLink(link);
                
                return [
                    `"${link.replace(/"/g, '""')}"`,
                    `""`, // Text would need to be stored separately
                    `""`, // Title would need to be stored separately
                    `"${isProduct ? 'Product' : isCategory ? 'Category' : 'Page'}"`,
                    `"${isCategory ? 'Yes' : 'No'}"`,
                    `"${isProduct ? 'Yes' : 'No'}"`
                ].join(',');
            });

            const csvContent = [headers, ...rows].join('\n');
            fs.writeFileSync(filename, csvContent, 'utf8');
            
            console.log(`✅ COMPLETE CSV GENERATED: ${filename}`);
            console.log(`📊 ${rows.length} links exported`);
            
            return true;
            
        } catch (error) {
            console.error('❌ CSV GENERATION FAILED:', error.message);
            return false;
        }
    }

    generateReport(links) {
        console.log('\n' + '='.repeat(100));
        console.log('📊 COMPLETE SITE CRAWLING REPORT');
        console.log('='.repeat(100));
        
        console.log(`🌐 TARGET: ${this.state.currentURL}`);
        console.log(`📅 TIMESTAMP: ${new Date().toISOString()}`);
        console.log(`⏱️  TOTAL DURATION: ${this.statistics.execution.totalDuration}ms`);
        
        console.log(`\n📊 CRAWLING STATISTICS:`);
        console.log(`   Pages Visited: ${this.statistics.crawling.pagesVisited}`);
        console.log(`   Links Discovered: ${this.statistics.crawling.linksDiscovered}`);
        console.log(`   Categories Found: ${this.statistics.crawling.categoriesFound}`);
        console.log(`   Products Found: ${this.statistics.crawling.productsFound}`);
        
        console.log(`\n📦 RESOURCE STATISTICS:`);
        console.log(`   Total Requests: ${this.statistics.resources.totalRequests}`);
        console.log(`   Blocked Requests: ${this.statistics.resources.blockedRequests}`);
        
        // Show link breakdown
        const categories = links.filter(link => this.isCategoryLink(link)).length;
        const products = links.filter(link => this.isProductLink(link)).length;
        const pages = links.length - categories - products;
        
        console.log(`\n🔗 LINK BREAKDOWN:`);
        console.log(`   Total Links: ${links.length}`);
        console.log(`   Category Links: ${categories}`);
        console.log(`   Product Links: ${products}`);
        console.log(`   Page Links: ${pages}`);
        
        console.log('\n📋 SAMPLE LINKS:');
        links.slice(0, 25).forEach((link, index) => {
            const type = this.isProductLink(link) ? '🛍️ ' : this.isCategoryLink(link) ? '📂' : '📄';
            console.log(`${index + 1}. ${type} ${this.truncateURL(link)}`);
        });
        
        if (links.length > 25) {
            console.log(`   ... and ${links.length - 25} more links`);
        }
        
        console.log(`\n🎉 COMPLETE CRAWLING FINISHED!`);
    }

    /**
     * MAIN EXECUTION
     */
    async execute(startURL) {
        try {
            console.log('🚀 EXECUTING COMPLETE SITE CRAWL...');
            console.log('='.repeat(70));
            
            if (!await this.initializeBrowser()) {
                throw new Error('Browser initialization failed');
            }
            
            const links = await this.crawlSite(startURL);
            
            if (links.length === 0) {
                throw new Error('No links discovered during crawling');
            }
            
            this.statistics.execution.endTime = Date.now();
            this.statistics.execution.totalDuration = this.statistics.execution.endTime - this.statistics.execution.startTime;
            
            if (this.options.outputFormat === 'csv') {
                this.generateCSV(links, this.options.outputFile);
            } else {
                this.generateReport(links);
            }
            
            console.log(`\n✅ CRAWLING COMPLETED SUCCESSFULLY!`);
            console.log(`📊 ${links.length} total links discovered`);
            console.log(`🌐 ${this.statistics.crawling.pagesVisited} pages visited`);
            console.log(`🛡️  ${this.statistics.resources.blockedRequests} tracking requests blocked`);
            
            return {
                success: true,
                links: links,
                statistics: this.statistics
            };
            
        } catch (error) {
            this.statistics.execution.endTime = Date.now();
            this.statistics.execution.totalDuration = this.statistics.execution.endTime - this.statistics.execution.startTime;
            
            console.error('💥 CRAWLING FAILED:', error.message);
            
            return {
                success: false,
                error: error.message,
                links: Array.from(this.state.discoveredLinks),
                statistics: this.statistics
            };
            
        } finally {
            await this.cleanup();
        }
    }

    async cleanup() {
        try {
            if (this.state.browser) {
                await this.state.browser.close();
                console.log('🧹 CRAWLER CLEANUP COMPLETED');
            }
        } catch (error) {
            console.log('⚠️  Cleanup warning:', error.message);
        }
    }

    truncateURL(url, length = 60) {
        return url.length > length ? url.substring(0, length) + '...' : url;
    }
}

/**
 * COMMAND LINE INTERFACE
 */
async function main() {
    const args = process.argv.slice(2);
    const url = args[0] || 'https://www.theoutnet.com/en-us';
    
    const options = {
        headless: false,
        debugMode: args.includes('--debug'),
        outputFormat: args.includes('--output') ? args[args.indexOf('--output') + 1] : 'console',
        outputFile: args.includes('--file') ? args[args.indexOf('--file') + 1] : 'complete-links.csv',
        maxPages: 100, // Increase page limit
        maxDepth: 3
    };

    console.log('🚀 COMPLETE SITE CRAWLER - DISCOVERS ALL LINKS');
    console.log('='.repeat(80));
    console.log(`🌐 TARGET: ${url}`);
    console.log(`📊 MAX PAGES: ${options.maxPages}`);
    console.log(`🔍 STRATEGY: Navigation clicking + Category discovery + Pagination`);
    console.log('='.repeat(80));

    const crawler = new CompleteSiteCrawler(options);
    
    try {
        const result = await crawler.execute(url);
        
        if (result.success) {
            console.log(`\n🎉 SUCCESS! Discovered ${result.links.length} links`);
            process.exit(0);
        } else {
            console.log(`\n💥 FAILED: ${result.error}`);
            process.exit(1);
        }
        
    } catch (error) {
        console.error('💥 FATAL ERROR:', error);
        process.exit(1);
    }
}

module.exports = { CompleteSiteCrawler, main };

if (require.main === module) {
    main();
}
