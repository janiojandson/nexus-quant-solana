import test from 'node:test';
import assert from 'node:assert';
import {
  DEFAULT_ENTRY_MOMENTUM_CONFIG,
  evaluateEntryMomentum,
  observeEntryMomentum
} from './entryMomentumGate.js';

function sample(priceUsd: number) {
  return { timestamp: Date.now(), priceUsd };
}

test('EntryMomentumGate: aprova sequência consistente de alta', () => {
  const result = evaluateEntryMomentum(
    [sample(1.0000), sample(1.0030), sample(1.0060), sample(1.0100)],
    DEFAULT_ENTRY_MOMENTUM_CONFIG
  );
  assert.strictEqual(result.pass, true);
  assert.ok(result.risePct >= 0.4);
  assert.strictEqual(result.risingSteps, 3);
});

test('EntryMomentumGate: rejeita preço lateral ou queda', () => {
  const lateral = evaluateEntryMomentum(
    [sample(1.0000), sample(1.0002), sample(1.0001), sample(1.0003)],
    DEFAULT_ENTRY_MOMENTUM_CONFIG
  );
  assert.strictEqual(lateral.pass, false);

  const falling = evaluateEntryMomentum(
    [sample(1.0000), sample(0.9980), sample(0.9960), sample(0.9940)],
    DEFAULT_ENTRY_MOMENTUM_CONFIG
  );
  assert.strictEqual(falling.pass, false);
});

test('EntryMomentumGate: rejeita pump rápido demais', () => {
  const result = evaluateEntryMomentum(
    [sample(1.0000), sample(1.0200), sample(1.0500), sample(1.0800)],
    DEFAULT_ENTRY_MOMENTUM_CONFIG
  );
  assert.strictEqual(result.pass, false);
  assert.match(result.reason, /rápida demais/);
});

test('EntryMomentumGate: rejeita pullback excessivo durante a sequência', () => {
  const result = evaluateEntryMomentum(
    [sample(1.0000), sample(1.0080), sample(1.0030), sample(1.0120)],
    DEFAULT_ENTRY_MOMENTUM_CONFIG
  );
  assert.strictEqual(result.pass, false);
  assert.match(result.reason, /Pullback excessivo|Sequência sem continuidade/);
});

test('observeEntryMomentum: coleta preços sem executar transação', async () => {
  const prices = [1.0000, 1.0040, 1.0080, 1.0120];
  let calls = 0;
  const result = await observeEntryMomentum(
    async () => prices[calls++] ?? null,
    { ...DEFAULT_ENTRY_MOMENTUM_CONFIG, intervalMs: 0 }
  );

  assert.strictEqual(calls, 4);
  assert.strictEqual(result.pass, true);
});
