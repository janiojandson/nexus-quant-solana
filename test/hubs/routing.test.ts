import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DexAggregatorService} from '../../src/blockchain/dexAggregator.js';
import {JupiterExecutionEngine} from '../../src/blockchain/jupiterExecutionEngine.js';
test('missing hub fails closed before any global fetch and legacy URL cannot become a fallback',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Forbidden network');};
 try{
  await assert.rejects(new DexAggregatorService('https://fixture.invalid').getQuote({inputMint:'a',outputMint:'b',amountLamports:100}),/hub request failed/);
  assert.throws(()=>new JupiterExecutionEngine({rpcUrl:'https://fixture.invalid'}),/connection required/);
  assert.equal(calls,0);
 }finally{globalThis.fetch=previous;}
});
test('aggregator, including engine accessor, routes financial priorities and refuses research without using protection',async()=>{
 const calls:any[]=[]; const hub={request:async(work:string,endpoint:string,payload:unknown)=>{calls.push({work,endpoint,payload});return {status:200,headers:new Headers(),body:{inAmount:'100',outAmount:'200',slippageBps:250}};}};
 const dex=new DexAggregatorService(undefined,{hub,cacheTtlMs:0} as any);
 const engine=new JupiterExecutionEngine({jupiterHub:hub,connection:{} as any} as any);
 for(const priority of [0,1,2,3,4,5]) await dex.getQuote({inputMint:'a',outputMint:'b',amountLamports:100,trafficPriority:priority as any});
 await engine.getAggregator().getQuote({inputMint:'a',outputMint:'b',amountLamports:100,trafficPriority:4});
 await assert.rejects(dex.getQuote({inputMint:'a',outputMint:'b',amountLamports:100,trafficPriority:6}),/research/i);
 assert.deepEqual(calls.map(c=>c.work),['EXIT','EXIT','RECONCILE','RECONCILE','ENTRY','ENTRY','ENTRY']);
});
