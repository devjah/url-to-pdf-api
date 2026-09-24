/* eslint-env mocha */

const chai = require('chai');
const { BrowserPool } = require('../src/core/browser-pool');

const { expect } = chai;

describe('BrowserPool', () => {
  let pool;

  afterEach(() => pool.shutdown());

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
});
