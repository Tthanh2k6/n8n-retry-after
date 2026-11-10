// Paste into an n8n Code node ("Decide") set to mode: "Run Once for Each Item".
// Expects an upstream "Config" node with { url, method, maxAttempts, budgetSeconds, attempt }
// and an upstream "HTTP Request" node with "Include Response Headers and Status" + "Never Error" enabled.

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

  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }
    return Math.round(seconds * 1000);
  }

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

function backoffMs(
  attempt,
  { baseMs = 1000, capMs = 60000, jitterRatio = 0.2, random = Math.random } = {}
) {
  const safeAttempt = Math.max(1, Number(attempt) || 1);
  const delay = Math.min(capMs, baseMs * 2 ** (safeAttempt - 1));
  const jitter = jitterRatio > 0 ? random() * jitterRatio * delay : 0;
  return delay + jitter;
}

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

const config = $('Config').first().json;
let attempt = Number(config.attempt ?? 1);
try {
  if ($('Next attempt').isExecuted) {
    const looped = $('Next attempt').last().json;
    if (looped && looped.attempt !== undefined) {
      attempt = Number(looped.attempt);
    }
  } else if ($json.attempt !== undefined) {
    attempt = Number($json.attempt);
  }
} catch (_) {
  if ($json.attempt !== undefined) {
    attempt = Number($json.attempt);
  }
}

const statusCode = Number($json.statusCode ?? $json.status ?? 200);
const headers = $json.headers || {};
const maxAttempts = Number(config.maxAttempts ?? 5);
const budgetSeconds = Number(config.budgetSeconds ?? 60);

const decision = nextDelay({
  status: statusCode,
  headers,
  attempt,
  options: {
    maxAttempts,
    budgetMs: budgetSeconds * 1000,
  },
});

return {
  json: {
    action: decision.action,
    delayMs: decision.delayMs,
    reason: decision.reason,
    attempt,
    url: config.url,
    method: config.method || 'GET',
    maxAttempts,
    budgetSeconds,
    statusCode,
    headers,
    body: $json.body ?? null,
  },
};
