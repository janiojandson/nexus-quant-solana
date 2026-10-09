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
  const outputs = [1000000, 996016, 992063, 988142];
  let calls = 0;
  let t = 0;
  const result = await observeEntryMomentum(
    async () => ({ inputAmountAtomic: '1000000000', outputAmountAtomic: String(outputs[calls++]), tokenDecimals: 6, observedAtMs: t }),
    { ...DEFAULT_ENTRY_MOMENTUM_CONFIG, intervalMs: 500 },
    { now: () => t, wallNow: () => 1000 + t, sleep: async ms => { t += ms; } }
  );

  assert.strictEqual(calls, 4);
  assert.strictEqual(result.pass, true);
});

test('EntryMomentumGate: identifica fonte congelada como indeterminada, não como queda real', () => {
  const result = evaluateEntryMomentum(
    [sample(1.2345), sample(1.2345), sample(1.2345), sample(1.2345)],
    DEFAULT_ENTRY_MOMENTUM_CONFIG
  );
  assert.strictEqual(result.pass, false);
  assert.strictEqual(result.staleSource, true);
  assert.match(result.reason, /sem atualização|indeterminado/i);
});

test('four quote observations use absolute 500 ms starts, positive amounts, and no final sleep', async () => {
  let t = 0;
  const starts: number[] = [];
  const output = [1000000, 997009, 998004, 995025]; // SOL/token: 100, 100.3, 100.2, 100.5
  const result = await observeEntryMomentum(async (deadlineMs) => {
    starts.push(t);
    assert.ok(deadlineMs > 1000);
    const observedAtMs = t;
    t += 20;
    return { inputAmountAtomic: '1000000000', outputAmountAtomic: String(output[starts.length - 1]), tokenDecimals: 6, observedAtMs };
  }, { ...DEFAULT_ENTRY_MOMENTUM_CONFIG, intervalMs: 500 }, {
    now: () => t, wallNow: () => 1000 + t, sleep: async ms => { t += ms; }
  });
  assert.deepEqual(starts, [0, 500, 1000, 1500]);
  assert.equal(t, 1520);
  assert.equal(result.pass, true);
  assert.deepEqual(result.samples.map(s => s.latencyMs), [20, 20, 20, 20]);
  assert.deepEqual(result.samples.map(s => [s.requestedAtMs, s.completedAtMs]),
    [[0,20],[500,520],[1000,1020],[1500,1520]]);
});

test('late or nonpositive quote rejects instead of inventing a momentum pass', async () => {
  let t = 0;
  const clock = { now: () => t, wallNow: () => 1000 + t, sleep: async (ms: number) => { t += ms; } };
  const late = await observeEntryMomentum(async () => {
    t += 401;
    return { inputAmountAtomic: '1000000000', outputAmountAtomic: '1000000', tokenDecimals: 6, observedAtMs: t };
  }, { ...DEFAULT_ENTRY_MOMENTUM_CONFIG, intervalMs: 500 }, clock);
  assert.equal(late.pass, false);
  assert.match(late.reason, /LATE_SAMPLE/);
  t = 0;
  const zero = await observeEntryMomentum(async () => ({
    inputAmountAtomic: '1000000000', outputAmountAtomic: '0', tokenDecimals: 6, observedAtMs: t
  }), { ...DEFAULT_ENTRY_MOMENTUM_CONFIG, intervalMs: 500 }, clock);
  assert.equal(zero.pass, false);
  assert.match(zero.reason, /INVALID_QUOTE/);
});

test('400 ms quote RTT passes at absolute 500 ms starts; 401 ms and late start reject', async () => {
  const outputs = [1000000,996016,992063,988142];
  const run = async (rtt: number, sleepOverrun = 0) => {
    let t = 0; const starts: number[] = []; const deadlines: number[] = [];
    const result = await observeEntryMomentum(async deadline => {
      starts.push(t); deadlines.push(deadline); t += rtt;
      return {inputAmountAtomic:'1000000000',outputAmountAtomic:String(outputs[starts.length-1]),
        tokenDecimals:6,observedAtMs:t};
    }, DEFAULT_ENTRY_MOMENTUM_CONFIG, {
      now:()=>t,wallNow:()=>10_000+t,sleep:async ms=>{t+=ms+(sleepOverrun && starts.length===1 ? sleepOverrun : 0);}
    });
    return {result,starts,deadlines,t};
  };
  const allowed = await run(400);
  assert.equal(allowed.result.pass,true);
  assert.deepEqual(allowed.starts,[0,500,1000,1500]);
  assert.deepEqual(allowed.deadlines,[10400,10900,11400,11900]);
  assert.equal(allowed.t,1900);
  const slow = await run(401);
  assert.equal(slow.result.reason,'LATE_SAMPLE');
  const queued = await run(20,101);
  assert.equal(queued.result.reason,'LATE_SAMPLE');
});

test('invalid or unbounded momentum timing overrides fail closed', async () => {
  const result = await observeEntryMomentum(async () => {
    throw new Error('SHOULD_NOT_QUOTE');
  }, {...DEFAULT_ENTRY_MOMENTUM_CONFIG,maxQuoteLatencyMs:5000} as any);
  assert.equal(result.pass,false);
  assert.equal(result.reason,'INVALID_TIMING_CONFIG');
});
