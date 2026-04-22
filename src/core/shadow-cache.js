const crypto = require('crypto');
const { URL } = require('url');
const config = require('../config');
const logger = require('../util/logger')(__filename);

const IGNORED_KEYS = new Set(['attachmentName']);

function stripQueryParams(rawUrl) {
  if (!rawUrl || config.SHADOW_CACHE_STRIP_QUERY_PARAMS.length === 0) return rawUrl;
  try {
    const u = new URL(rawUrl);
    config.SHADOW_CACHE_STRIP_QUERY_PARAMS.forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch (e) {
    return rawUrl;
  }
}

const state = {
  entries: new Map(),
  totalRequests: 0,
  hits: 0,
  evicted: 0,
};

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  return Object.keys(value)
    .sort()
    .filter(key => !IGNORED_KEYS.has(key) && value[key] !== undefined)
    .reduce((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
}

function hashOpts(opts) {
  const normalized = Object.assign({}, opts, { url: stripQueryParams(opts.url) });
  const canonical = JSON.stringify(canonicalize(normalized));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function record(opts, byteSize) {
  if (!config.SHADOW_CACHE_ENABLED) return;
  try {
    const key = hashOpts(opts);
    state.totalRequests += 1;
    const now = Date.now();
    const existing = state.entries.get(key);
    if (existing) {
      existing.hits += 1;
      existing.lastSeen = now;
      existing.lastByteSize = byteSize;
      state.hits += 1;
      // Refresh LRU ordering
      state.entries.delete(key);
      state.entries.set(key, existing);
    } else {
      state.entries.set(key, {
        hits: 0,
        firstSeen: now,
        lastSeen: now,
        lastByteSize: byteSize,
      });
      if (state.entries.size > config.SHADOW_CACHE_MAX_ENTRIES) {
        const oldestKey = state.entries.keys().next().value;
        state.entries.delete(oldestKey);
        state.evicted += 1;
      }
    }
  } catch (err) {
    logger.warn(`Shadow cache record failed: ${err.message}`);
  }
}

function getStats() {
  if (!config.SHADOW_CACHE_ENABLED) {
    return { enabled: false };
  }
  let estimatedLiveBytes = 0;
  const topN = [];
  state.entries.forEach((entry, key) => {
    estimatedLiveBytes += entry.lastByteSize || 0;
    topN.push({ key: key.slice(0, 12), hits: entry.hits, lastByteSize: entry.lastByteSize });
  });
  topN.sort((a, b) => b.hits - a.hits);
  const uniqueKeys = state.entries.size + state.evicted;
  const hitRate = state.totalRequests > 0 ? state.hits / state.totalRequests : 0;
  return {
    enabled: true,
    totalRequests: state.totalRequests,
    hits: state.hits,
    misses: state.totalRequests - state.hits,
    hitRate: Number(hitRate.toFixed(4)),
    uniqueKeys,
    liveEntries: state.entries.size,
    evicted: state.evicted,
    estimatedLiveBytes,
    maxEntries: config.SHADOW_CACHE_MAX_ENTRIES,
    topN: topN.slice(0, 10),
  };
}

function logSnapshot() {
  if (!config.SHADOW_CACHE_ENABLED) return;
  const stats = getStats();
  logger.info(`[shadow-cache] snapshot: ${JSON.stringify(stats)}`);
}

module.exports = {
  record,
  getStats,
  logSnapshot,
};
