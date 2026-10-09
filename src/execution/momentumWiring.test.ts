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
  if(ts.isForOfStatement(node) && node.expression.getText(source)==='discovered.slice(0, 3)')entryLoop=node;
  ts.forEachChild(node,visit);
}
visit(source);
assert.ok(entryLoop);
const js=ts.transpileModule(`async function run(){${entryLoop.getText(source)}};run;`,{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}
}).outputText;
const token={mint:'mint',symbol:'REAL',name:'Real',priceUsd:0.001,
  liquidityUsd:30000,pairAddress:'pool',priceChangeM5:0.1,buysM5:0,sellsM5:100};
function run(decision:{accepted:boolean;reason?:string;receipt?:{traceId:string;entryIntentId:string}}) {
  const decisions:any[]=[];
  const attempts:any[]=[];
  const discards:string[]=[];
  const context={discovered:[token],latestState:{incubator:{entryEligible:0,technicalDiscards:0}},
    TokenClassifier:{classify:()=>({isEligibleForMemeScan:true})},
    antiSpamMemory:{shouldSkip:()=>({skip:false}),recordTechnicalDiscard:(_mint:string,reason:string)=>discards.push(reason),
      recordVeto:()=>{throw new Error('unexpected durable veto');}},
    latestShadowEntryLadderLamports:[25_000_000],balanceSol:1,
    capitalPolicy:{gasReserveSol:0.005},
    entryAdmission:{attempt:async(input:any)=>{attempts.push(input);
      await input.verifySecurity(input.candidate);return decision;}},
    entryGatekeeper:{auditToken:async()=>({safe:true,score:95})},
    journal:{logDecision:(value:any)=>decisions.push(value)},
    randomUUID:()=> 'trace',Math,Number
  };
  const execute=vm.runInNewContext(js,context) as ()=>Promise<void>;
  return execute().then(()=>({decisions,attempts,discards}));
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
