'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRetryAfter, backoffMs, nextDelay } = require('../src/retryAfter');

test('parseRetryAfter: parses delta-seconds string', () => {
  assert.equal(parseRetryAfter('120'), 120000);
  assert.equal(parseRetryAfter('0'), 0);
});

test('parseRetryAfter: parses whitespace-padded seconds', () => {
  assert.equal(parseRetryAfter(' 120 '), 120000);
  assert.equal(parseRetryAfter('\t45\n'), 45000);
});

test('parseRetryAfter: accepts numeric input', () => {
  assert.equal(parseRetryAfter(120), 120000);
  assert.equal(parseRetryAfter(0), 0);
  assert.equal(parseRetryAfter(1.5), 1500);
});

test('parseRetryAfter: parses HTTP-date (IMF-fixdate) in the future', () => {
  const nowMs = Date.parse('Wed, 11 Nov 2026 07:59:10 GMT');
  const header = 'Wed, 11 Nov 2026 08:00:00 GMT';
  assert.equal(parseRetryAfter(header, nowMs), 50000);
});

test('parseRetryAfter: returns 0 for HTTP-date in the past or present', () => {
  const nowMs = Date.parse('Wed, 11 Nov 2026 08:01:00 GMT');
  const pastHeader = 'Wed, 11 Nov 2026 08:00:00 GMT';
  assert.equal(parseRetryAfter(pastHeader, nowMs), 0);
  assert.equal(parseRetryAfter('Wed, 11 Nov 2026 08:01:00 GMT', nowMs), 0);
});

test('parseRetryAfter: returns null for garbage, empty, NaN, and negative numbers', () => {
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter('   '), null);
  assert.equal(parseRetryAfter('not-a-date'), null);
  assert.equal(parseRetryAfter('foo 123'), null);
  assert.equal(parseRetryAfter('-5'), null);
  assert.equal(parseRetryAfter(-5), null);
  assert.equal(parseRetryAfter(NaN), null);
  assert.equal(parseRetryAfter(Infinity), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(undefined), null);
});

test('backoffMs: respects exponential progression and capMs', () => {
  const opts = { baseMs: 1000, capMs: 10000, jitterRatio: 0, random: () => 0 };
  assert.equal(backoffMs(1, opts), 1000);
  assert.equal(backoffMs(2, opts), 2000);
  assert.equal(backoffMs(3, opts), 4000);
  assert.equal(backoffMs(4, opts), 8000);
  assert.equal(backoffMs(5, opts), 10000);
  assert.equal(backoffMs(10, opts), 10000);
});

test('backoffMs: applies jitter within [0, jitterRatio * delay] using injected random', () => {
  const minDelay = backoffMs(2, {
    baseMs: 1000,
    capMs: 60000,
    jitterRatio: 0.2,
    random: () => 0,
  });
  const midDelay = backoffMs(2, {
    baseMs: 1000,
    capMs: 60000,
    jitterRatio: 0.2,
    random: () => 0.5,
  });
  const maxDelay = backoffMs(2, {
    baseMs: 1000,
    capMs: 60000,
    jitterRatio: 0.2,
    random: () => 1,
  });

  // attempt 2 base delay = 2000ms, jitter range = [0, 400]
  assert.equal(minDelay, 2000);
  assert.equal(midDelay, 2200);
  assert.equal(maxDelay, 2400);
});

test('nextDelay: returns done when status is not in retryable set', () => {
  const res200 = nextDelay({ status: 200, headers: {}, attempt: 1 });
  assert.equal(res200.action, 'done');
  assert.equal(res200.delayMs, 0);

  const res404 = nextDelay({ status: 404, headers: { 'Retry-After': '10' }, attempt: 1 });
  assert.equal(res404.action, 'done');
  assert.equal(res404.delayMs, 0);
});

test('nextDelay: returns give_up when attempt exceeds maxAttempts', () => {
  const res = nextDelay({
    status: 429,
    headers: { 'Retry-After': '5' },
    attempt: 6,
    options: { maxAttempts: 5 },
  });
  assert.equal(res.action, 'give_up');
  assert.equal(res.delayMs, 0);
});

test('nextDelay: looks up Retry-After header case-insensitively', () => {
  const r1 = nextDelay({ status: 429, headers: { 'Retry-After': '12' }, attempt: 1 });
  assert.equal(r1.action, 'retry');
  assert.equal(r1.delayMs, 12000);

  const r2 = nextDelay({ status: 503, headers: { 'retry-after': '7' }, attempt: 1 });
  assert.equal(r2.action, 'retry');
  assert.equal(r2.delayMs, 7000);

  const r3 = nextDelay({ status: 429, headers: { 'RETRY-AFTER': '15' }, attempt: 1 });
  assert.equal(r3.action, 'retry');
  assert.equal(r3.delayMs, 15000);
});

test('nextDelay: falls back to exponential backoff when Retry-After header is missing or invalid', () => {
  const missing = nextDelay({
    status: 429,
    headers: {},
    attempt: 3,
    options: { baseMs: 1000, jitterRatio: 0 },
  });
  assert.equal(missing.action, 'retry');
  assert.equal(missing.delayMs, 4000);

  const invalid = nextDelay({
    status: 503,
    headers: { 'Retry-After': 'invalid-value' },
    attempt: 2,
    options: { baseMs: 1000, jitterRatio: 0, minMs: 2500 },
  });
  assert.equal(invalid.action, 'retry');
  assert.equal(invalid.delayMs, 2500);
});

test('nextDelay: returns defer when delay exceeds budgetMs', () => {
  const fromHeader = nextDelay({
    status: 429,
    headers: { 'Retry-After': '120' },
    attempt: 1,
    options: { budgetMs: 60000 },
  });
  assert.equal(fromHeader.action, 'defer');
  assert.equal(fromHeader.delayMs, 120000);

  const nowMs = Date.parse('Wed, 11 Nov 2026 08:00:00 GMT');
  const fromDate = nextDelay({
    status: 429,
    headers: { 'Retry-After': 'Wed, 11 Nov 2026 08:05:00 GMT' },
    attempt: 1,
    nowMs,
    options: { budgetMs: 60000 },
  });
  assert.equal(fromDate.action, 'defer');
  assert.equal(fromDate.delayMs, 300000);
});
