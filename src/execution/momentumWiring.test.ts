import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const source=ts.createSourceFile('index.ts',readFileSync(join(__dirname,'../index.ts'),'utf8'),
  ts.ScriptTarget.Latest,true);
let entryLoop:ts.ForOfStatement|undefined;
function visit(node:ts.Node) {
  if(ts.isForOfStatement(node) && node.expression.getText(source)==='discovered')entryLoop=node;
  ts.forEachChild(node,visit);
}
visit(source);
assert.ok(entryLoop);
const js=ts.transpileModule(`async function run(){let evaluatedCount=0;${entryLoop.getText(source)}};run;`,{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}
}).outputText;
const token={mint:'mint',symbol:'REAL',name:'Real',priceUsd:0.001,
  liquidityUsd:30000,pairAddress:'pool',priceChangeM5:0.1,buysM5:0,sellsM5:100,launchpad:'pump.fun'};
function run(decision:{accepted:boolean;reason?:string;receipt?:{traceId:string;entryIntentId:string}},
  opts:{isDryRun?:boolean;executeSwap?:(req:any)=>Promise<any>} = {}) {
  const decisions:any[]=[];
  const attempts:any[]=[];
  const discards:string[]=[];
  const execCalls:any[]=[];
  const context={discovered:[token],IS_DRY_RUN:opts.isDryRun ?? true,latestState:{incubator:{entryEligible:0,technicalDiscards:0}},
    TokenClassifier:{classify:()=>({isEligibleForMemeScan:true})},
    antiSpamMemory:{shouldSkip:()=>({skip:false}),recordTechnicalDiscard:(_mint:string,reason:string)=>discards.push(reason),
      recordVeto:()=>{throw new Error('unexpected durable veto');}},
    latestShadowEntryLadderLamports:[25_000_000],
    capitalObservation:{available:true,lamports:100_000_000,slot:123,observedAtMs:1750000000000,provenance:'FRESH_CONFIRMED_RPC'},
    capitalPolicy:{gasReserveSol:0.005},
    entryAdmission:{attempt:async(input:any)=>{attempts.push(input);
      await input.verifySecurity(input.candidate);return decision;}},
    entryGatekeeper:{auditToken:async()=>({safe:true,score:95})},
    journal:{logDecision:(value:any)=>decisions.push(value)},
    logFeed:()=>{},
    randomUUID:()=> 'trace',Math,Number,
    jupiterEngine:{executeSwap:async(req:any)=>{execCalls.push(req);
      if (opts.executeSwap) return opts.executeSwap(req);
      return {status:'SUCCESS',isDryRun:false,txSignature:'tx-live-sig',inAmount:req.amountLamports,outAmount:1000000,executionPath:'V2_META_AGGREGATOR'};}},
    getExecutionSigner:()=> undefined,
    OFFICIAL_PHANTOM_WALLET:'wallet',
    PUMP_PROGRAM_ID:{toBase58:()=> 'pump-program'}
  };
  const execute=vm.runInNewContext(js,context) as ()=>Promise<void>;
  return execute().then(()=>({decisions,attempts,discards,execCalls}));
}

test('DEX candidate uses actual token metadata and dynamic allocation in shared 4D admission',async()=>{
  const result=await run({accepted:false,reason:'MOMENTUM_STALE_SOURCE'});
  assert.equal(result.attempts.length,1);
  assert.equal(result.attempts[0].stakeLamports,25_000_000);
  assert.equal(result.attempts[0].candidate.priceUsd,0.001);
  assert.equal(result.attempts[0].candidate.pairAddress,'pool');
  assert.equal(result.decisions[0].decision,'ENTRY_REJECTED');
  assert.equal(result.decisions[0].rejectionReason,'MOMENTUM_STALE_SOURCE');
  assert.deepEqual(result.discards,['MOMENTUM_STALE_SOURCE']);
});

test('DEX records approval only for durable admitted SHADOW receipt',async()=>{
  const result=await run({accepted:true,receipt:{traceId:'durable-trace',entryIntentId:'intent'}});
  assert.equal(result.decisions.length,1);
  assert.equal(result.decisions[0].decision,'ENTRY_APPROVED');
  assert.equal(result.decisions[0].traceId,'durable-trace');
  assert.equal(result.decisions[0].metadata.entryIntentId,'intent');
});

test('SHADOW admission never calls executeSwap',async()=>{
  const result=await run({accepted:true,receipt:{traceId:'durable-trace',entryIntentId:'intent'}},
    {isDryRun:true,executeSwap:async()=>{throw new Error('SHADOW must not execute a real swap');}});
  assert.equal(result.execCalls.length,0);
  assert.equal(result.decisions[0].decision,'ENTRY_APPROVED');
  assert.equal(result.decisions[0].metadata.accountingMode,'SHADOW');
  assert.equal(result.decisions[0].metadata.txSignature,undefined);
});

test('LIVE admission calls executeSwap with audited pool and reconciles tx signature',async()=>{
  const result=await run({accepted:true,receipt:{traceId:'durable-trace',entryIntentId:'intent'}},
    {isDryRun:false,executeSwap:async(req)=>({status:'SUCCESS',isDryRun:false,txSignature:'tx-live-sig',inAmount:req.amountLamports,outAmount:1000000,executionPath:'V2_META_AGGREGATOR'})});
  assert.equal(result.execCalls.length,1);
  assert.equal(result.execCalls[0].inputMint,'So11111111111111111111111111111111111111112');
  assert.equal(result.execCalls[0].outputMint,'mint');
  assert.equal(result.execCalls[0].amountLamports,25_000_000);
  assert.equal(result.execCalls[0].requiredPoolAddress,'pool');
  assert.equal(result.execCalls[0].forbiddenProgramIds.length,1);
  assert.equal(result.execCalls[0].forbiddenProgramIds[0],'pump-program');
  assert.equal(result.execCalls[0].maxPriceImpactPct,2.5);
  assert.equal(result.execCalls[0].poolLiquidityUsd,30000);
  assert.equal(result.decisions[0].decision,'ENTRY_APPROVED');
  assert.equal(result.decisions[0].metadata.accountingMode,'LIVE');
  assert.equal(result.decisions[0].metadata.txSignature,'tx-live-sig');
});
