import assert from 'node:assert/strict';
import test from 'node:test';
import { PumpDexTimingRuntime } from './pumpDexTimingRuntime.js';

test('runtime samples immediately, repeats on timer, and stops cleanly', async () => {
  let samples = 0;
  let timerCallback: (() => void) | undefined;
  let cleared = false;
  const fakeTimer = { unref() {} };

  const runtime = new PumpDexTimingRuntime(
    { async sample() { samples++; } },
    {
      enabled: true,
      intervalMs: 5000,
      setIntervalFn(callback: () => void) {
        timerCallback = callback;
        return fakeTimer as any;
      },
      clearIntervalFn(timer) {
        assert.equal(timer, fakeTimer);
        cleared = true;
      }
    }
  );

  runtime.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(samples, 1);
  assert.equal(typeof timerCallback, 'function');

  timerCallback!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(samples, 2);

  runtime.stop();
  assert.equal(cleared, true);
});

test('disabled runtime never samples or schedules', async () => {
  let samples = 0;
  let scheduled = false;
  const runtime = new PumpDexTimingRuntime(
    { async sample() { samples++; } },
    {
      enabled: false,
      setIntervalFn() {
        scheduled = true;
        return {} as any;
      }
    }
  );

  runtime.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(samples, 0);
  assert.equal(scheduled, false);
});
