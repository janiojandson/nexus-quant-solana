import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the current handoff handler without booting providers, wallet or DB.
const source = ts.createSourceFile('index.ts', readFileSync(join(__dirname, '../index.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) &&
  node.name?.text === 'handleSentinelGraduationDip');
assert.ok(declaration);
const js = ts.transpileModule(declaration.getText(source), {
  compilerOptions: {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}
}).outputText;
function scenario(options: {metadata?: boolean; decision?: {accepted:boolean;reason?:string}; loseAfterMetadata?: boolean} = {}) {
  const events:string[]=[];
  let active=true;
  const token={mint:'mint',symbol:'SYM',leaseId:'lease',poolHints:['hint'],createdAt:new Date(0),
    poolEvidence:{kind:'PHYSICAL_POOL_CONFIRMED',poolAddress:'pool',slot:123},
    leaseSignal:{get aborted(){return !active;}},
    assertLeaseActive:async()=>{if(!active)throw new Error('LEASE_LOST');}};
  const dependencies={
    sentinelActiveGraduations:new Set<string>(),latestState:{sentinelHandoffQueue:0,circuitBreakerActive:false},
    sentinelHandoffScanner:{release:async(_mint:string,_lease:string,reason:string)=>{events.push(`release:${reason}`);},
      acknowledgeAccepted:async()=>{events.push('ack');return true;}},
    scanner:{fetchCandidate:async()=>{events.push('metadata');if(options.loseAfterMetadata)active=false;
      return options.metadata===false?null:{mint:'mint',symbol:'SYM',name:'Name',priceUsd:0.01,liquidityUsd:30000};}},
    executionUncertainReason:null, IS_DRY_RUN:true,
    positionLedger:{recover:async()=>null},
    positionEngine:{getAllPositions:()=>[]},MAX_CONCURRENT_POSITIONS:2,
    exitPathHealth:{snapshot:()=>({canOpenNewPosition:true})},
    wallet:{getBalanceSol:async()=>1,readFreshBalance:async()=>({available:true,lamports:1_000_000_000,slot:123,observedAtMs:1750000000000,provenance:'FRESH_CONFIRMED_RPC'})},
    buildEquitySizingPolicy:()=>({canOpenNextPosition:true,ladderSol:[0.025],gasReserveSol:0.005}),
    ENTRY_EQUITY_PCT:0.1,MAX_TOTAL_ALLOCATION_PCT:0.2,BUY_AMOUNT_SOL:0.025,
    MAX_TOTAL_ALLOCATION_SOL:0.1,GAS_RESERVE_EQUITY_PCT:0.1,
    MIN_GAS_RESERVE_SOL:0.005,MAX_GAS_RESERVE_SOL:0.05,
    entryAdmission:{attempt:async()=>{events.push('admission');return options.decision??{accepted:false,reason:'PERSISTENCE_UNAVAILABLE'};}},
    entryGatekeeper:{auditToken:async()=>({safe:true})},
    console:{warn(){}},Error,Math
  };
  const handler=vm.runInNewContext(`${js}\nhandleSentinelGraduationDip;`,dependencies) as (token:unknown)=>Promise<void>;
  return {handler,token,events};
}

test('handoff without exact-mint market facts releases lease before admission',async()=>{
  const f=scenario({metadata:false});
  await f.handler(f.token);
  assert.deepEqual(f.events,['metadata','release:DADOS_INSUFICIENTES']);
});

test('typed admission rejection never acknowledges handoff',async()=>{
  const f=scenario({decision:{accepted:false,reason:'ROUND_TRIP_LOSS'}});
  await f.handler(f.token);
  assert.deepEqual(f.events,['metadata','admission','release:ROUND_TRIP_LOSS']);
});

test('lease lost across metadata await prevents admission and acknowledgement',async()=>{
  const f=scenario({loseAfterMetadata:true});
  await f.handler(f.token);
  assert.deepEqual(f.events,['metadata','release:LEASE_LOST']);
});

test('only a durable accepted admission can acknowledge handoff',async()=>{
  const f=scenario({decision:{accepted:true}});
  await f.handler(f.token);
  assert.deepEqual(f.events,['metadata','admission','ack']);
});
