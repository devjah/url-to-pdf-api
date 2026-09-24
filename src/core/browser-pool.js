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
    this.maxQueueLength = options.maxQueueLength || config.MAX_QUEUE_LENGTH;

    this.browsers = [];
    this.queue = [];
    this.isShuttingDown = false;
    this.healthCheckInterval = null;

    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rejectedRequests: 0,
      queuedRequests: 0,
      activeBrowsers: 0,
      activePages: 0,
    };

    this.startHealthCheck();
  }

  async acquire({ signal } = {}) {
    if (this.isShuttingDown) {
      throw new Error('Browser pool is shutting down');
    }
    if (signal && signal.aborted) {
      throw new Error('Request aborted before acquiring a page');
    }

    this.stats.totalRequests += 1;

    // A request behind a full queue would outlast the caller's own timeout,
    // so answer 503 at once instead of piling up more waiters.
    if (this.queue.length >= this.maxQueueLength) {
      this.stats.rejectedRequests += 1;
      throw unavailableError('Render queue is full');
    }

    return new Promise((resolve, reject) => {
      const request = { resolve, reject, timestamp: Date.now() };
      if (signal) {
        // A caller that has gone away should not hold a place in the queue.
        signal.addEventListener('abort', () => {
          const index = this.queue.indexOf(request);
          if (index > -1) {
            this.queue.splice(index, 1);
            reject(new Error('Request aborted while waiting in queue'));
          }
        }, { once: true });
      }
      this.queue.push(request);
      this.dispatch();
    });
  }

  // processQueue runs fire-and-forget from many places. A rejection there
  // (a failed Chrome launch) would be unhandled, which exits Node.
  dispatch() {
    this.processQueue().catch((err) => {
      logger.error('Error processing render queue:', err);
    });
  }

  async processQueue() {
    if (this.queue.length === 0 || this.isShuttingDown) {
      return;
    }

    let availableBrowser;
    try {
      availableBrowser = await this.getAvailableBrowser();
    } catch (err) {
      // No browser is coming for this request, so fail it rather than leave it
      // waiting for a trigger that may never arrive.
      logger.error('Failed to launch a browser for a queued request:', err);
      const failed = this.queue.shift();
      if (failed) {
        failed.reject(unavailableError(`Could not launch a browser: ${err.message}`));
        this.stats.failedRequests += 1;
      }
      setImmediate(() => this.dispatch());
      return;
    }
    if (!availableBrowser) {
      return;
    }

    const request = this.queue.shift();
    if (!request) {
      return;
    }

    if (Date.now() - request.timestamp > this.pageTimeout) {
      request.reject(unavailableError('Request timeout while waiting in queue'));
      this.stats.failedRequests += 1;
      this.dispatch();
      return;
    }

    try {
      const page = await this.createPage(availableBrowser);
      this.stats.activePages += 1;

      let released = false;
      const pageWrapper = {
        page,
        browser: availableBrowser,
        release: async () => {
          if (released) {
            return;
          }
          released = true;

          try {
            await page.close();
          } catch (err) {
            logger.warn('Error closing page:', err.message);
          }

          this.stats.activePages -= 1;
          availableBrowser.activePages -= 1;

          // A browser marked for restart gets no new pages, so it restarts once
          // its last in-flight page is done instead of killing the others.
          if (availableBrowser.shouldRestart && availableBrowser.activePages === 0) {
            await this.restartBrowser(availableBrowser);
          }

          setImmediate(() => this.dispatch());
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

      setImmediate(() => this.dispatch());
    }
  }

  async getAvailableBrowser() {
    const availableBrowsers = this.browsers.filter(
      bw => bw.isHealthy && !bw.isRestarting && !bw.shouldRestart &&
        bw.activePages < this.maxPagesPerBrowser,
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
        // restartBrowser launches its own replacement
        if (browserWrapper.isRestarting) {
          return;
        }
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
    // Count the page before it exists so a drain check can't restart the
    // browser while this page is still being opened.
    browserWrapper.activePages += 1;
    let page;
    try {
      page = await browser.newPage();
    } catch (err) {
      browserWrapper.activePages -= 1;
      throw err;
    }

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
      setImmediate(() => this.dispatch());
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
        setImmediate(() => this.dispatch());
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

          // Browsers launched together age out together; drain one at a time
          // so the pool never loses all of its capacity at once.
          const anotherDraining = this.browsers.some(
            bw => bw !== browserWrapper && (bw.shouldRestart || bw.isRestarting),
          );
          const browserAge = Date.now() - browserWrapper.createdAt;
          if (browserAge > 3600000 && !browserWrapper.shouldRestart && !anotherDraining) {
            browserWrapper.shouldRestart = true;
            logger.info('Marking browser for restart due to age');
          }

          if (browserWrapper.errorCount > 10 && !browserWrapper.shouldRestart) {
            browserWrapper.shouldRestart = true;
            logger.info('Marking browser for restart due to error count');
          }

          if (browserWrapper.shouldRestart && browserWrapper.activePages === 0) {
            await this.restartBrowser(browserWrapper);
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

function unavailableError(message) {
  const err = new Error(message);
  err.status = 503;
  return err;
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

