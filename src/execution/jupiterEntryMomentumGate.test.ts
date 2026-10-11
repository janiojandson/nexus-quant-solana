import test from 'node:test';
import assert from 'node:assert/strict';
import { observeJupiterEntryMomentum, DEFAULT_ENTRY_MOMENTUM_CONFIG } from './entryMomentumGate.js';
import type { SwapQuoteResult } from '../blockchain/dexAggregator.js';

function quote(outAmount:number,pool='pool',impact=1):SwapQuoteResult {
  return {inputMint:'sol',outputMint:'token',inAmount:25_000_000,outAmount,slippageBps:250,priceImpactPct:impact,
    routePlanSummary:'Raydium',observedAtMs:Date.now(),rawQuote:{priceImpact:impact,routePlan:[{swapInfo:{ammKey:pool,outputMint:'token'}}]}};
}
const config={...DEFAULT_ENTRY_MOMENTUM_CONFIG,samples:2,intervalMs:0};
test('Jupiter preflight measures executable price rise with the same SOL input',async()=>{
  const quotes=[quote(1_000_000),quote(990_000)];
  const result=await observeJupiterEntryMomentum(async()=>quotes.shift()!,'token','pool',config);
  assert.equal(result.pass,true);assert.ok(result.risePct>1);
  assert.equal(result.samples[0].priceUsd,undefined);
  assert.ok(result.samples[0].priceSolPerAtomicToken!>0);
});
test('Jupiter flat price is insufficient positive momentum rather than proof of stale upstream',async()=>{
  const result=await observeJupiterEntryMomentum(async()=>quote(100),'token','pool',config);
  assert.equal(result.pass,false);assert.equal(result.staleSource,false);
  assert.match(result.reason,/NO_POSITIVE_MOMENTUM/);
});
test('Jupiter preflight rejects changed pool, changed input, and unknown or excessive impact',async()=>{
  for(const bad of [quote(90,'other'),{...quote(90),inAmount:26_000_000},quote(90,'pool',3),{...quote(90),rawQuote:{routePlan:[{swapInfo:{ammKey:'pool',outputMint:'token'}}]}}]) {
    const quotes=[quote(100),bad];
    assert.equal((await observeJupiterEntryMomentum(async()=>quotes.shift()!,'token','pool',config)).pass,false);
  }
});
test('Jupiter missing route fails closed and a dump cannot pass',async()=>{
  assert.equal((await observeJupiterEntryMomentum(async()=>{throw new Error('no route');},'token','pool',config)).pass,false);
  const quotes=[quote(100),quote(105)];
  assert.equal((await observeJupiterEntryMomentum(async()=>quotes.shift()!,'token','pool',config)).pass,false);
});
