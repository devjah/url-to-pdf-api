const crypto = require('crypto');
const config = require('../config');
const logger = require('../util/logger')(__filename);

const IGNORED_KEYS = new Set(['attachmentName', 'nocache', 'refresh']);

const state = {
  entries: new Map(),
  totalBytes: 0,
  totalRequests: 0,
  hits: 0,
  unversioned: 0,
  bypassed: 0,
  refreshed: 0,
  refusedFull: 0,
  expired: 0,
  sweepTimer: null,
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
  const canonical = JSON.stringify(canonicalize(opts));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function ttlMs() {
  return config.CACHE_TTL_SECONDS * 1000;
}

function dropEntry(key, entry) {
  state.entries.delete(key);
  state.totalBytes -= entry.byteSize;
}

function get(opts) {
  if (!config.CACHE_ENABLED) return null;
  try {
    const key = hashOpts(opts);
    state.totalRequests += 1;
    const entry = state.entries.get(key);
    if (!entry) return null;
    const now = Date.now();
    if (now - entry.lastAccess > ttlMs()) {
      dropEntry(key, entry);
      state.expired += 1;
      return null;
    }
    entry.hits += 1;
    entry.lastAccess = now;
    state.hits += 1;
    // Refresh iteration order so the most recently used entry sits at the end of the Map.
    state.entries.delete(key);
    state.entries.set(key, entry);
    return entry.buffer;
  } catch (err) {
    logger.warn(`Cache get failed: ${err.message}`);
    return null;
  }
}

// Concurrent misses for the same key both render; the second set short-circuits
// because the key already exists.
function set(opts, buffer) {
  if (!config.CACHE_ENABLED) return false;
  try {
    const key = hashOpts(opts);
    if (state.entries.has(key)) return true;
    const byteSize = buffer.length;
    if (state.totalBytes + byteSize > config.CACHE_MAX_BYTES) {
      state.refusedFull += 1;
      return false;
    }
    const now = Date.now();
    state.entries.set(key, {
      buffer,
      byteSize,
      hits: 0,
      lastAccess: now,
    });
    state.totalBytes += byteSize;
    return true;
  } catch (err) {
    logger.warn(`Cache set failed: ${err.message}`);
    return false;
  }
}

function recordUnversioned() {
  if (!config.CACHE_ENABLED) return;
  state.unversioned += 1;
}

function recordBypass() {
  if (!config.CACHE_ENABLED) return;
  state.bypassed += 1;
}

function recordRefresh() {
  if (!config.CACHE_ENABLED) return;
  state.refreshed += 1;
}

function invalidate(opts) {
  if (!config.CACHE_ENABLED) return false;
  try {
    const key = hashOpts(opts);
    const entry = state.entries.get(key);
    if (!entry) return false;
    dropEntry(key, entry);
    return true;
  } catch (err) {
    logger.warn(`Cache invalidate failed: ${err.message}`);
    return false;
  }
}

function sweep() {
  if (!config.CACHE_ENABLED) return;
  const now = Date.now();
  const ttl = ttlMs();
  state.entries.forEach((entry, key) => {
    if (now - entry.lastAccess > ttl) {
      dropEntry(key, entry);
      state.expired += 1;
    }
  });
}

function startSweep() {
  if (!config.CACHE_ENABLED || state.sweepTimer) return;
  const intervalMs = config.CACHE_SWEEP_INTERVAL_SECONDS * 1000;
  state.sweepTimer = setInterval(sweep, intervalMs);
  if (typeof state.sweepTimer.unref === 'function') {
    state.sweepTimer.unref();
  }
}

function stop() {
  if (state.sweepTimer) {
    clearInterval(state.sweepTimer);
    state.sweepTimer = null;
  }
}

function getStats() {
  if (!config.CACHE_ENABLED) {
    return { enabled: false };
  }
  const topN = [];
  state.entries.forEach((entry, key) => {
    topN.push({ key: key.slice(0, 12), hits: entry.hits, byteSize: entry.byteSize });
  });
  topN.sort((a, b) => b.hits - a.hits);
  const hitRate = state.totalRequests > 0 ? state.hits / state.totalRequests : 0;
  return {
    enabled: true,
    totalRequests: state.totalRequests,
    hits: state.hits,
    misses: state.totalRequests - state.hits,
    hitRate: Number(hitRate.toFixed(4)),
    unversioned: state.unversioned,
    bypassed: state.bypassed,
    refreshed: state.refreshed,
    liveEntries: state.entries.size,
    totalBytes: state.totalBytes,
    maxBytes: config.CACHE_MAX_BYTES,
    refusedFull: state.refusedFull,
    expired: state.expired,
    ttlSeconds: config.CACHE_TTL_SECONDS,
    topN: topN.slice(0, 10),
  };
}

function logSnapshot() {
  if (!config.CACHE_ENABLED) return;
  const stats = getStats();
  logger.info(`[cache] snapshot: ${JSON.stringify(stats)}`);
}

module.exports = {
  get,
  set,
  invalidate,
  recordUnversioned,
  recordBypass,
  recordRefresh,
  startSweep,
  stop,
  getStats,
  logSnapshot,
};
