/* eslint-disable no-param-reassign */
const puppeteer = require('puppeteer');
const EventEmitter = require('events');
const config = require('../config');
const logger = require('../util/logger')(__filename);

class BrowserPool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxBrowsers = options.maxBrowsers || (config.NODE_ENV === 'production' ? 2 : 3);
    this.maxPagesPerBrowser = options.maxPagesPerBrowser || 10;
    this.browserTimeout = options.browserTimeout || 30000;
    this.pageTimeout = options.pageTimeout || 30000;
    this.retryLimit = options.retryLimit || 3;

    this.browsers = [];
    this.queue = [];
    this.isShuttingDown = false;
    this.healthCheckInterval = null;

    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      queuedRequests: 0,
      activeBrowsers: 0,
      activePages: 0,
    };

    this.startHealthCheck();
  }

  async acquire() {
    if (this.isShuttingDown) {
      throw new Error('Browser pool is shutting down');
    }

    this.stats.totalRequests += 1;

    return new Promise((resolve, reject) => {
      const request = { resolve, reject, timestamp: Date.now() };
      this.queue.push(request);
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.queue.length === 0 || this.isShuttingDown) {
      return;
    }

    const availableBrowser = await this.getAvailableBrowser();
    if (!availableBrowser) {
      return;
    }

    const request = this.queue.shift();
    if (!request) {
      return;
    }

    if (Date.now() - request.timestamp > this.pageTimeout) {
      request.reject(new Error('Request timeout while waiting in queue'));
      this.stats.failedRequests += 1;
      this.processQueue();
      return;
    }

    try {
      const page = await this.createPage(availableBrowser);
      this.stats.activePages += 1;

      const pageWrapper = {
        page,
        browser: availableBrowser,
        release: async () => {
          try {
            await page.close();
          } catch (err) {
            logger.warn('Error closing page:', err.message);
          }

          this.stats.activePages -= 1;
          availableBrowser.activePages -= 1;

          if (availableBrowser.shouldRestart) {
            await this.restartBrowser(availableBrowser);
          }

          setImmediate(() => this.processQueue());
        },
      };

      request.resolve(pageWrapper);
      this.stats.successfulRequests += 1;
    } catch (err) {
      logger.error('Error creating page:', err);
      request.reject(err);
      this.stats.failedRequests += 1;

      if (availableBrowser) {
        availableBrowser.errorCount += 1;
        if (availableBrowser.errorCount > this.retryLimit) {
          await this.restartBrowser(availableBrowser);
        }
      }

      setImmediate(() => this.processQueue());
    }
  }

  async getAvailableBrowser() {
    const availableBrowsers = this.browsers.filter(
      bw => bw.isHealthy && !bw.isRestarting && bw.activePages < this.maxPagesPerBrowser,
    );
    if (availableBrowsers.length > 0) {
      return availableBrowsers[0];
    }

    if (this.browsers.length < this.maxBrowsers) {
      const newBrowser = await this.createBrowser();
      return newBrowser;
    }

    return null;
  }

  async createBrowser() {
    const browserOpts = {
      ignoreHTTPSErrors: true,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--safebrowsing-disable-auto-update',
        '--js-flags=--max-old-space-size=920',
      ],
    };

    if (config.BROWSER_WS_ENDPOINT) {
      browserOpts.browserWSEndpoint = config.BROWSER_WS_ENDPOINT;
      return puppeteer.connect(browserOpts);
    }

    if (config.BROWSER_EXECUTABLE_PATH) {
      browserOpts.executablePath = config.BROWSER_EXECUTABLE_PATH;
    }

    try {
      const browser = await puppeteer.launch(browserOpts);
      const browserWrapper = {
        browser,
        activePages: 0,
        errorCount: 0,
        isHealthy: true,
        isRestarting: false,
        shouldRestart: false,
        createdAt: Date.now(),
      };

      browser.on('disconnected', () => {
        logger.warn('Browser disconnected');
        browserWrapper.isHealthy = false;
        this.handleBrowserDisconnect(browserWrapper);
      });

      this.browsers.push(browserWrapper);
      this.stats.activeBrowsers += 1;
      logger.info(`Created new browser instance (total: ${this.browsers.length})`);

      return browserWrapper;
    } catch (err) {
      logger.error('Failed to create browser:', err);
      throw err;
    }
  }

  async createPage(browserWrapper) {
    const { browser } = browserWrapper;
    const page = await browser.newPage();

    browserWrapper.activePages += 1;

    page.setDefaultTimeout(this.pageTimeout);
    page.setDefaultNavigationTimeout(this.pageTimeout);

    page.on('error', (err) => {
      logger.error('Page crashed:', err);
      browserWrapper.errorCount += 1;
    });

    page.on('pageerror', (err) => {
      logger.warn('Page error:', err.message);
    });

    return page;
  }

  async restartBrowser(browserWrapper) {
    if (browserWrapper.isRestarting) {
      return;
    }

    browserWrapper.isRestarting = true;
    browserWrapper.isHealthy = false;

    logger.info('Restarting browser instance...');

    try {
      await browserWrapper.browser.close();
    } catch (err) {
      logger.warn('Error closing browser during restart:', err.message);
    }

    const index = this.browsers.indexOf(browserWrapper);
    if (index > -1) {
      this.browsers.splice(index, 1);
      this.stats.activeBrowsers -= 1;
    }

    try {
      await this.createBrowser();
      logger.info('Browser restarted successfully');
      setImmediate(() => this.processQueue());
    } catch (err) {
      logger.error('Failed to restart browser:', err);
    }
  }

  async handleBrowserDisconnect(browserWrapper) {
    const index = this.browsers.indexOf(browserWrapper);
    if (index > -1) {
      this.browsers.splice(index, 1);
      this.stats.activeBrowsers -= 1;
    }

    if (!this.isShuttingDown) {
      try {
        await this.createBrowser();
        setImmediate(() => this.processQueue());
      } catch (err) {
        logger.error('Failed to replace disconnected browser:', err);
      }
    }
  }

  startHealthCheck() {
    this.healthCheckInterval = setInterval(async () => {
      const checkPromises = this.browsers.map(async (browserWrapper) => {
        try {
          await browserWrapper.browser.pages();
          browserWrapper.isHealthy = true;

          const browserAge = Date.now() - browserWrapper.createdAt;
          if (browserAge > 3600000) {
            browserWrapper.shouldRestart = true;
            logger.info('Marking browser for restart due to age');
          }

          if (browserWrapper.errorCount > 10) {
            browserWrapper.shouldRestart = true;
            logger.info('Marking browser for restart due to error count');
          }
        } catch (err) {
          logger.warn('Health check failed for browser:', err.message);
          browserWrapper.isHealthy = false;
          await this.restartBrowser(browserWrapper);
        }
      });
      await Promise.all(checkPromises);

      this.stats.queuedRequests = this.queue.length;
      logger.debug('Pool stats:', this.stats);
    }, 30000);
  }

  async shutdown() {
    logger.info('Shutting down browser pool...');
    this.isShuttingDown = true;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.queue.forEach((request) => {
      request.reject(new Error('Browser pool is shutting down'));
    });
    this.queue = [];

    const closePromises = this.browsers.map(async (browserWrapper) => {
      try {
        await browserWrapper.browser.close();
      } catch (err) {
        logger.warn('Error closing browser during shutdown:', err.message);
      }
    });

    await Promise.all(closePromises);
    this.browsers = [];

    logger.info('Browser pool shutdown complete');
  }

  getStats() {
    return {
      ...this.stats,
      queueLength: this.queue.length,
      browsers: this.browsers.map(b => ({
        activePages: b.activePages,
        errorCount: b.errorCount,
        isHealthy: b.isHealthy,
        age: Date.now() - b.createdAt,
      })),
    };
  }
}

let poolInstance = null;

function getPool() {
  if (!poolInstance) {
    poolInstance = new BrowserPool();
  }
  return poolInstance;
}

async function shutdownPool() {
  if (poolInstance) {
    await poolInstance.shutdown();
    poolInstance = null;
  }
}

module.exports = {
  BrowserPool,
  getPool,
  shutdownPool,
};

