/* eslint-disable no-process-env */

// Env vars should be casted to correct types
const config = {
  PORT: Number(process.env.PORT) || 9000,
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  ALLOW_HTTP: process.env.ALLOW_HTTP === 'true',
  DEBUG_MODE: process.env.DEBUG_MODE === 'true',
  DISABLE_HTML_INPUT: process.env.DISABLE_HTML_INPUT === 'true',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  BROWSER_WS_ENDPOINT: process.env.BROWSER_WS_ENDPOINT,
  BROWSER_EXECUTABLE_PATH: process.env.BROWSER_EXECUTABLE_PATH,
  USE_BROWSER_POOL: process.env.USE_BROWSER_POOL !== 'false',
  AUTO_RESTART_INTERVAL_MINUTES: Number(process.env.AUTO_RESTART_INTERVAL_MINUTES) || 0,
  CACHE_ENABLED: process.env.CACHE_ENABLED === 'true',
  CACHE_MAX_BYTES: Number(process.env.CACHE_MAX_BYTES) || 64 * 1024 * 1024,
  CACHE_TTL_SECONDS: Number(process.env.CACHE_TTL_SECONDS) || 8 * 60 * 60,
  CACHE_SWEEP_INTERVAL_SECONDS: Number(process.env.CACHE_SWEEP_INTERVAL_SECONDS) || 60,
  CACHE_IGNORED_QUERY_PARAMS: ['api_token'],
  API_TOKENS: [],
  ALLOW_URLS: [],
};

if (process.env.CACHE_IGNORED_QUERY_PARAMS) {
  config.CACHE_IGNORED_QUERY_PARAMS = process.env.CACHE_IGNORED_QUERY_PARAMS
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

if (process.env.API_TOKENS) {
  config.API_TOKENS = process.env.API_TOKENS.split(',');
}

if (process.env.ALLOW_URLS) {
  config.ALLOW_URLS = process.env.ALLOW_URLS.split(',');
}

module.exports = config;
