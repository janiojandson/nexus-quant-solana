import test from 'node:test';
import assert from 'node:assert/strict';
import { logFeed, getLogFeedEntries } from './logFeed.js';

test('logFeed appends typed entries with ISO timestamp', () => {
  logFeed('info', 'telemetry-info');
  logFeed('warn', 'telemetry-warn');
  const entries = getLogFeedEntries();
  const tail = entries.slice(-2);
  assert.equal(tail[0].message, 'telemetry-info');
  assert.equal(tail[0].type, 'info');
  assert.equal(tail[1].message, 'telemetry-warn');
  assert.equal(tail[1].type, 'warn');
  assert.ok(!Number.isNaN(Date.parse(tail[1].timestamp)), 'timestamp must be ISO-parseable');
});

test('logFeed caps the ring buffer at 200 entries', () => {
  for (let i = 0; i < 230; i++) logFeed('info', `fill-${i}`);
  const entries = getLogFeedEntries();
  assert.ok(entries.length <= 200, 'buffer must not exceed 200 entries');
  assert.equal(entries[entries.length - 1].message, 'fill-229');
});
