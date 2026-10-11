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
function scenario(options: {metadata?: boolean; decision?: {accepted:boolean;reason?:string;receipt?:any}; loseAfterMetadata?: boolean; loseLease?: boolean; poolEvidence?: any} = {}) {
  const events:string[]=[];
  const token={mint:'test-mint-11111111111111111111111111111111',symbol:'MOCK',leaseId:'lease-test-123',poolHints:['hint'],createdAt:new Date(0),
    poolEvidence:'poolEvidence' in options?options.poolEvidence:(options.metadata===false?undefined:{kind:'PHYSICAL_POOL_CONFIRMED'}),
    leaseSignal:{get aborted(){return false;}},
    assertLeaseActive:()=>{if(options.loseLease||options.loseAfterMetadata)throw new Error('LEASE_LOST');}};
  const dependencies={
    sentinelActiveGraduations:new Set<string>(),latestState:{sentinelHandoffQueue:0,circuitBreakerActive:false},
    sentinelHandoffScanner:{recordHandoffOutcome:async()=>{},
      acknowledgeAccepted:async()=>{events.push('ack');},
      release:async(_m:string,_l:string,reason:string)=>{events.push(`release:${reason}`);}},
    executionUncertainReason:null, IS_DRY_RUN:true,
    positionLedger:{recover:async()=>null},
    positionEngine:{getAllPositions:()=>[]},MAX_CONCURRENT_POSITIONS:2,
    exitPathHealth:{snapshot:()=>({canOpenNewPosition:true})},
    wallet:{getBalanceSol:async()=>1,readFreshBalance:async()=>({available:true,lamports:1_000_000_000,slot:123,observedAtMs:1750000000000,provenance:'FRESH_CONFIRMED_RPC'})},
    buildEquitySizingPolicy:()=>({canOpenNextPosition:true,ladderSol:[0.025],gasReserveSol:0.005}),
    ENTRY_EQUITY_PCT:0.1,MAX_TOTAL_ALLOCATION_PCT:0.2,BUY_AMOUNT_SOL:0.025,
    MAX_TOTAL_ALLOCATION_SOL:0.1,GAS_RESERVE_EQUITY_PCT:0.1,
    MIN_GAS_RESERVE_SOL:0.005,MAX_GAS_RESERVE_SOL:0.05,
    entryAdmission:{attempt:async()=>{events.push('admission');if(options.decision?.accepted){return {receipt:{durable:true,positionRegistered:true,accountingMode:'SHADOW',entryIntentId:'test-intent-id',traceId:'test-trace-id'},...options.decision};}return options.decision??{accepted:false,reason:'PERSISTENCE_UNAVAILABLE'};}},
    entryGatekeeper:{auditToken:async()=>({safe:true})},
    antiSpamMemory:{shouldSkip:(mint:string)=>({skip:false})},
    entrySlots:{reserve:(mint:string,source:string,positions:unknown[])=>true,release:(mint:string)=>{}},
    waitForSentinelJupiterRoute:async(mint:string,quoteFn:unknown)=>({quote:{inAmount:'25000000',outAmount:'1000000000',priceImpactPct:0.01,routePlan:[],swapMode:'ExactIn',otherAmountThreshold:'990000000'},poolAddress:'mock-pool-address'}),
    jupiterEngine:{getQuote:async(inputMint:any,outputMint:any,amountLamports:any,slippageBps?:any,trafficPriority?:any,taker?:any,signal?:any)=>({inAmount:String(amountLamports),outAmount:'1000000000',priceImpactPct:0.01,routePlan:[],swapMode:'ExactIn',otherAmountThreshold:'990000000'})},
    SOL_MINT_GLOBAL:'So11111111111111111111111111111111111111112',
    priorityForJupiterWork:()=>3,
    console: { warn() {}, log() {}, error() {} },Error,Math
  };
  const handler=vm.runInNewContext(`${js}\nhandleSentinelGraduationDip;`,dependencies) as (token:unknown)=>Promise<void>;
  return {handler,token,events};
}

test('handoff without confirmed physical pool evidence releases lease before admission', async () => {
  const f = scenario({ poolEvidence: undefined });
  await f.handler(f.token);
  assert.deepEqual(f.events, ['release:INVALID_POOL_PROOF']);
});

test('typed admission rejection never acknowledges handoff', async () => {
  const f = scenario({ decision: { accepted: false, reason: 'ROUND_TRIP_LOSS' } });
  await f.handler(f.token);
  assert.deepEqual(f.events, ['admission', 'release:ROUND_TRIP_LOSS']);
});

test('lease lost during preflight prevents admission and acknowledgement', async () => {
  const f = scenario({ loseLease: true });
  await f.handler(f.token);
  assert.deepEqual(f.events, ['release:LEASE_LOST']);
});

test('only a durable accepted admission can acknowledge handoff', async () => {
  const f = scenario({
    decision: {
      accepted: true,
      receipt: {
        durable: true,
        positionRegistered: true,
        accountingMode: 'SHADOW',
        entryIntentId: 'test-intent-id',
        traceId: 'test-trace-id',
      },
    },
  });
  await f.handler(f.token);
  assert.deepEqual(f.events, ['admission', 'ack']);
});
