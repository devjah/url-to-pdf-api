/* eslint-env mocha */
/* global AbortController */

const chai = require('chai');
const http = require('http');
const request = require('supertest');
const { BrowserPool, getPool, shutdownPool } = require('../src/core/browser-pool');
const createApp = require('../src/app');

const { expect } = chai;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('BrowserPool', () => {
  let pool;

  afterEach(() => pool.shutdown());

  it('rejects with 503 at once when the queue is full', async () => {
    pool = new BrowserPool({ maxBrowsers: 1, maxPagesPerBrowser: 1, maxQueueLength: 1 });
    const first = await pool.acquire();
    const queued = pool.acquire();

    const startedAt = Date.now();
    const err = await pool.acquire().catch(e => e);
    expect(err.status).to.equal(503);
    expect(Date.now() - startedAt).to.be.below(100);

    await first.release();
    const second = await queued;
    await second.release();
  });

  it('drops a queued request whose caller aborts', async () => {
    pool = new BrowserPool({ maxBrowsers: 1, maxPagesPerBrowser: 1, maxQueueLength: 1 });
    const first = await pool.acquire();
    const controller = new AbortController();
    const queued = pool.acquire({ signal: controller.signal });

    controller.abort();
    const err = await queued.catch(e => e);
    expect(err.message).to.match(/aborted/);
    expect(pool.queue).to.have.length(0);
    await first.release();
  });

  it('launches no more than maxBrowsers when requests arrive together', async () => {
    pool = new BrowserPool({ maxBrowsers: 1, maxPagesPerBrowser: 5 });
    const pages = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    expect(pool.browsers).to.have.length(1);
    await Promise.all(pages.map(wrapper => wrapper.release()));
  });

  it('drains a browser marked for restart instead of killing its other pages', async () => {
    pool = new BrowserPool({ maxBrowsers: 1, maxPagesPerBrowser: 5 });
    const first = await pool.acquire();
    const second = await pool.acquire();
    const oldBrowser = first.browser;
    oldBrowser.shouldRestart = true;

    const inFlight = second.page.evaluate(() => new Promise(resolve => setTimeout(() => resolve('done'), 500)));
    await first.release();
    expect(await inFlight).to.equal('done');
    expect(pool.browsers).to.deep.equal([oldBrowser]);

    // No new pages go to the draining browser, so this waits for the restart.
    const queued = pool.acquire();
    await second.release();
    const third = await queued;
    expect(third.browser).to.not.equal(oldBrowser);
    expect(pool.browsers).to.deep.equal([third.browser]);
    await third.release();
  });

  it('starts every queued request the restarted browser has room for', async () => {
    pool = new BrowserPool({ maxBrowsers: 1, maxPagesPerBrowser: 5 });
    const first = await pool.acquire();
    const oldBrowser = first.browser;
    oldBrowser.shouldRestart = true;

    const queued = [pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()];
    await first.release();

    // Nothing releases a page from here on, so every waiter has to start off
    // the dispatch the restart itself triggers.
    const started = await Promise.race([
      Promise.all(queued),
      sleep(3000).then(() => null),
    ]);
    expect(started, 'queued requests left waiting after the restart').to.not.equal(null);
    started.forEach(wrapper => expect(wrapper.browser).to.not.equal(oldBrowser));
    await Promise.all(started.map(wrapper => wrapper.release()));
  });

  it('does not relaunch a draining browser that crashed and was already replaced', async () => {
    pool = new BrowserPool({ maxBrowsers: 1, maxPagesPerBrowser: 5 });
    const first = await pool.acquire();
    const oldBrowser = first.browser;
    oldBrowser.shouldRestart = true;

    let launches = 0;
    const createBrowser = pool.createBrowser.bind(pool);
    pool.createBrowser = () => {
      launches += 1;
      return createBrowser();
    };

    oldBrowser.browser.process().kill('SIGKILL');
    while (pool.browsers.length !== 1 || pool.browsers[0] === oldBrowser) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(50);
    }
    expect(launches).to.equal(1);

    // The crashed browser's last page going away must not launch a third.
    await first.release();
    await sleep(500);
    expect(launches).to.equal(1);
    expect(pool.browsers).to.have.length(1);
  });
});

describe('Render abort on client disconnect', () => {
  let hangingServer;

  before(async () => {
    // Accepts the page request and never answers, so navigation hangs.
    hangingServer = http.createServer(() => {}).listen(0);
    // Launch Chrome up front so the render is past the queue when the caller gives up.
    const warmup = await getPool().acquire();
    await warmup.release();
  });

  after(async () => {
    hangingServer.close();
    await shutdownPool();
  });

  it('closes the page and frees its slot when the caller gives up', async () => {
    const url = `http://localhost:${hangingServer.address().port}/`;
    const err = await request(createApp())
      .get('/api/render')
      .query({ url })
      .timeout(1000)
      .catch(e => e);
    expect(err.timeout).to.equal(1000);

    await sleep(500);
    expect(getPool().getStats().activePages).to.equal(0);
    expect(getPool().getStats().queueLength).to.equal(0);
  });
});
