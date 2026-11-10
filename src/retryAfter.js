'use strict';

/**
 * Parse an HTTP Retry-After value (delta-seconds or HTTP-date per RFC 9110 §10.2.3)
 * into a delay in milliseconds.
 *
 * @param {string | number | null | undefined} value - Raw Retry-After header value
 * @param {number} [nowMs=Date.now()] - Current timestamp in ms (for deterministic testing)
 * @returns {number | null} Delay in milliseconds (>= 0), or null if invalid/missing
 */
function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      return null;
    }
    return Math.round(value * 1000);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  // Delta-seconds (or any numeric string, including negative numbers which must return null)
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }
    return Math.round(seconds * 1000);
  }

  // Require an HTTP-date month token (IMF-fixdate / RFC 850 / asctime) or ISO-8601 date prefix
  // so arbitrary strings containing digits (e.g. "foo 1") are not misparsed by Date.parse().
  if (!/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|\d{4}-\d{2}-\d{2}/i.test(trimmed)) {
    return null;
  }

  const targetMs = Date.parse(trimmed);
  if (Number.isNaN(targetMs)) {
    return null;
  }

  const diffMs = targetMs - nowMs;
  return diffMs > 0 ? diffMs : 0;
}

/**
 * Compute exponential backoff with additive jitter in [0, jitterRatio * delay].
 *
 * @param {number} attempt - 1-based attempt number (1, 2, 3, ...)
 * @param {object} [options]
 * @param {number} [options.baseMs=1000] - Base backoff in ms
 * @param {number} [options.capMs=60000] - Maximum backoff cap in ms (before jitter)
 * @param {number} [options.jitterRatio=0.2] - Jitter ratio relative to delay
 * @param {() => number} [options.random=Math.random] - Random generator returning [0, 1)
 * @returns {number} Backoff delay in ms
 */
function backoffMs(
  attempt,
  { baseMs = 1000, capMs = 60000, jitterRatio = 0.2, random = Math.random } = {}
) {
  const safeAttempt = Math.max(1, Number(attempt) || 1);
  const delay = Math.min(capMs, baseMs * 2 ** (safeAttempt - 1));
  const jitter = jitterRatio > 0 ? random() * jitterRatio * delay : 0;
  return delay + jitter;
}

/**
 * Extract Retry-After header case-insensitively from a headers object or Headers instance.
 *
 * @param {object | null | undefined} headers
 * @returns {string | number | null}
 */
function getRetryAfterHeader(headers) {
  if (!headers || typeof headers !== 'object') {
    return null;
  }

  if (typeof headers.get === 'function') {
    return headers.get('retry-after');
  }

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'retry-after') {
      const raw = headers[key];
      return Array.isArray(raw) ? raw[0] : raw;
    }
  }

  return null;
}

/**
 * Decide whether to retry in-process, defer to a queue, give up, or complete.
 *
 * @param {object} params
 * @param {number} params.status - HTTP status code
 * @param {object} [params.headers] - HTTP response headers (case-insensitive)
 * @param {number} [params.attempt=1] - Current 1-based attempt number
 * @param {number} [params.nowMs=Date.now()] - Current time in ms
 * @param {object} [params.options]
 * @param {number[]} [params.options.retryableStatuses=[429, 503]] - Status codes eligible for retry
 * @param {number} [params.options.maxAttempts=5] - Max attempts allowed before giving up
 * @param {number} [params.options.minMs=0] - Minimum retry delay in ms
 * @param {number} [params.options.budgetMs=60000] - Maximum in-execution wait budget in ms
 * @param {number} [params.options.baseMs=1000] - Backoff base in ms
 * @param {number} [params.options.capMs=60000] - Backoff cap in ms
 * @param {number} [params.options.jitterRatio=0.2] - Backoff jitter ratio
 * @param {() => number} [params.options.random=Math.random] - RNG for backoff jitter
 * @returns {{ action: 'retry' | 'defer' | 'give_up' | 'done', delayMs: number, reason: string }}
 */
function nextDelay({
  status,
  headers = {},
  attempt = 1,
  nowMs = Date.now(),
  options = {},
} = {}) {
  const {
    retryableStatuses = [429, 503],
    maxAttempts = 5,
    minMs = 0,
    budgetMs = 60000,
    baseMs = 1000,
    capMs = 60000,
    jitterRatio = 0.2,
    random = Math.random,
  } = options;

  const numericStatus = Number(status);
  if (!retryableStatuses.includes(numericStatus)) {
    return {
      action: 'done',
      delayMs: 0,
      reason: `status ${status} is not in retryable set [${retryableStatuses.join(', ')}]`,
    };
  }

  const numericAttempt = Number(attempt);
  if (numericAttempt > maxAttempts) {
    return {
      action: 'give_up',
      delayMs: 0,
      reason: `attempt ${numericAttempt} exceeds maxAttempts ${maxAttempts}`,
    };
  }

  const rawHeader = getRetryAfterHeader(headers);
  const parsedHeaderMs = parseRetryAfter(rawHeader, nowMs);
  const source = parsedHeaderMs !== null ? 'retry-after header' : 'exponential backoff';
  const computedMs =
    parsedHeaderMs !== null
      ? parsedHeaderMs
      : backoffMs(numericAttempt, { baseMs, capMs, jitterRatio, random });

  const delayMs = Math.max(minMs, computedMs);

  if (delayMs > budgetMs) {
    return {
      action: 'defer',
      delayMs,
      reason: `delay ${delayMs}ms (${source}) exceeds budget ${budgetMs}ms`,
    };
  }

  return {
    action: 'retry',
    delayMs,
    reason: `waiting ${delayMs}ms (${source}) before attempt ${numericAttempt + 1}`,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseRetryAfter,
    backoffMs,
    nextDelay,
  };
}
