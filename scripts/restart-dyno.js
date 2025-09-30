#!/usr/bin/env node
/* eslint-disable no-process-env */

const https = require('https');

/**
 * External Heroku Dyno Restart Script
 *
 * This script can be used with Heroku Scheduler or cron jobs to restart
 * the dyno externally via the Heroku API. This is an alternative to the
 * built-in AUTO_RESTART_INTERVAL feature in src/index.js.
 *
 * Required environment variables:
 * - HEROKU_API_KEY: Your Heroku API key
 * - HEROKU_APP_NAME: Your Heroku app name
 *
 * To use with Heroku Scheduler:
 * 1. heroku addons:create scheduler:standard
 * 2. heroku addons:open scheduler
 * 3. Add job: node scripts/restart-dyno.js
 * 4. Set frequency: every 12 hours
 */

const apiKey = process.env.HEROKU_API_KEY;
const appName = process.env.HEROKU_APP_NAME;

if (!apiKey || !appName) {
  console.error('Error: HEROKU_API_KEY and HEROKU_APP_NAME must be set');
  process.exit(1);
}

const options = {
  hostname: 'api.heroku.com',
  path: `/apps/${appName}/dynos`,
  method: 'DELETE',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/vnd.heroku+json; version=3',
    'Content-Type': 'application/json',
  },
};

const req = https.request(options, (res) => {
  console.log(`Dyno restart initiated. Status: ${res.statusCode}`);
  res.on('data', (chunk) => {
    console.log(chunk.toString());
  });
});

req.on('error', (error) => {
  console.error('Error restarting dyno:', error);
  process.exit(1);
});

req.end();
