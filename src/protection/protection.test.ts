import test from 'node:test';
import assert from 'node:assert/strict';
import { NonBlockingTelemetry } from './nonBlockingTelemetry.js';
import { evaluateProfitProtectionShadow } from './profitProtectionShadow.js';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
test('unresolved telemetry never blocks price evaluation or duplicates in-flight requests', async () => {
 const cache = new NonBlockingTelemetry<number>(50);
 let calls = 0; let resolve!: (v:number)=>void;
 const fetch = () => { calls++; return new Promise<number>(r=>{resolve=r;}); };
 assert.equal(cache.sample('pool',fetch,100),undefined);
 await flush();
 assert.equal(cache.sample('pool',fetch,110),undefined);
 assert.equal(calls,1);
 resolve(7); await flush();
 assert.equal(cache.sample('pool',fetch,120),7);
 assert.equal(cache.sample('other-pool',()=>Promise.resolve(9),120),undefined);
});
test('slow result retains request age and errors invalidate previous success', async () => {
 const cache = new NonBlockingTelemetry<number>(50);
 cache.sample('pool',()=>Promise.resolve(7),100); await flush();
 assert.equal(cache.sample('pool',()=>Promise.reject(Error('offline')),151),undefined);
 await flush();
 assert.equal(cache.sample('pool',()=>Promise.resolve(8),152),undefined);
});
const base = {remainingCost:1,initialCost:1,confirmedProceeds:0,executableValue:2,peakValue:2,remainingFraction:1,quoteAgeMs:0,estimatedExitFee:0,maxSlippageBps:750};
test('capital recovery is an estimate requiring a separate exact partial quote',()=>{
 const input={...base}; const result=evaluateProfitProtectionShadow(input);
 assert.equal(result.action,'RECOVER_CAPITAL');
 assert.equal(result.requiresPartialQuote,true);
 assert.ok(Math.abs(result.fraction - 1/1.85)<1e-12);
 assert.deepEqual(input,base);
});
test('Tesla gap yields full exit at observed quote, never a fabricated fill at trailing price',()=>{
 const result=evaluateProfitProtectionShadow({...base,remainingCost:0.01,initialCost:0.02,peakValue:0.047647,executableValue:0.000041149,confirmedProceeds:undefined});
 assert.equal(result.action,'EXIT_ALL');assert.equal(result.fraction,1);assert.equal(result.mode,'SHADOW');
 assert.equal('fillPrice' in result,false);
});
test('stale quotes require refresh and unknown proceeds cannot claim recovered capital',()=>{
 assert.equal(evaluateProfitProtectionShadow({...base,quoteAgeMs:3001}).action,'REQUOTE');
 assert.equal(evaluateProfitProtectionShadow({...base,confirmedProceeds:undefined}).action,'UNKNOWN');
 assert.equal(evaluateProfitProtectionShadow({...base,maxSlippageBps:2000}).action,'UNKNOWN');
 assert.equal(evaluateProfitProtectionShadow({...base,confirmedProceeds:undefined,executableValue:4,peakValue:4}).action,'HARVEST');
});
