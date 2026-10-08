import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { scheduleEntryAdvisory } from './entryAdvisory.js';
import axios from 'axios';
import { MemeRiskGatekeeper } from '../risk/memeRiskGatekeeper.js';

// Execute the actual handlers without importing index.ts and starting production services.
const source = ts.createSourceFile('index.ts', readFileSync(join(__dirname, '../index.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
function loadHandler(name: string, dependencies: Record<string, unknown>) {
  const nodes = source.statements.filter(node =>
    ts.isFunctionDeclaration(node) ? node.name?.text === name :
      ts.isVariableStatement(node) && node.declarationList.declarations.some(d =>
        ts.isIdentifier(d.name) && (d.name.text.startsWith('SENTINEL_') || ['SOL_MINT_GLOBAL', 'sentinelActiveGraduations'].includes(d.name.text) ||
          (dependencies.MemeRiskGatekeeper && ['gatekeeper', 'dexEntryGatekeeper', 'entryGatekeeper'].includes(d.name.text)))));
  const js = ts.transpileModule(nodes.map(n => n.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  return vm.runInNewContext(`${js}\n${name};`, {
    latestState: { sentinelHandoffQueue: 0 },
    sentinelHandoffScanner: { recordHandoffOutcome: async () => {} },
    ENTRY_MOMENTUM_GATE_ENABLED: false,
    console: { log() {}, warn() {}, error(e: unknown) { throw new Error(String(e)); } },
    ...dependencies
  }) as (...args: any[]) => Promise<void>;
}

test('SOL exit monitor still requests executable quotes when Sentinel USD entry price is unknown', async () => {
  let quotes=0;
  const handler=loadHandler('runUltraFastExitMonitor',{
    NEXUS_MAINTENANCE_MODE:false,isRunningFastExit:false,
    positionEngine:{getAllPositions:()=>[{mint:'mint',symbol:'S',entrySol:.025,entryPriceUsd:0,tokenAmount:100}],recordQuoteFailure:()=>({failures:1,shouldWarn:false,shouldEmergencyExit:false})},
    exitTelemetry:{sample(){}},scanner:{},assertStoredAtomicNumberToNumber:(n:number)=>n,
    priorityForJupiterWork:()=>1,
    jupiterEngine:{getQuote:async()=>{quotes++;throw Error('test stops after quote request');}},
    exitPathHealth:{recordFailure(){},snapshot:()=>({})}
  });
  await handler();assert.equal(quotes,1);
});

test('Sentinel composes real deterministic audit without waiting for native shadow enabled by environment', async () => {
  const originalGet = axios.get, originalShadow = process.env.SOLANA_LAYA_SHADOW_ENABLED;
  let completed = false, nativeCalls = 0;
  try {
    process.env.SOLANA_LAYA_SHADOW_ENABLED = 'true';
    axios.get = (async () => ({ data: { is_circuit_breaker_active: false, regime: 'NEUTRAL_RANGING' } })) as any;
    class ControlledGatekeeper extends MemeRiskGatekeeper {
      constructor(config: any) {
        super({ ...config,
          rugCheckService: { auditToken: async () => ({ mint: 'mint', score: 100, risks: [], isRugged: false, isSafe: true, verified: true, mintAuthority: null, freezeAuthority: null, holdersCount: 500, factsComplete: true, lpLockedPct: 100, topHoldersPct: 10 }) } as any,
          solanaLayaAdapter: { evaluate: () => { nativeCalls++; return new Promise(() => {}); } } as any
        });
      }
    }
    const handler = loadHandler('executeSentinelEntryCandidate', {
      MemeRiskGatekeeper: ControlledGatekeeper, MACRO_SENTINEL_URL: 'https://fake.invalid',
      executionUncertainReason: null, MAX_CONCURRENT_POSITIONS: 2,
      positionEngine: { getAllPositions: () => [] }, latestState: { circuitBreakerActive: false },
      wallet: { getBalanceSol: async () => 1 },
      buildEquitySizingPolicy: () => ({ canOpenNextPosition: true, ladderSol: [0.01] }),
      ENTRY_EQUITY_PCT: 0.1, MAX_TOTAL_ALLOCATION_PCT: 0.2, BUY_AMOUNT_SOL: 0.025,
      MAX_TOTAL_ALLOCATION_SOL: 0.1, GAS_RESERVE_EQUITY_PCT: 0.1, MIN_GAS_RESERVE_SOL: 0.01, MAX_GAS_RESERVE_SOL: 0.05,
      SOLANA_LAYA_TACTICAL_MODE: 'LIVE', process, scheduleEntryAdvisory,
      solanaLayaAdapter: { evaluateEntry: () => new Promise(() => {}) },
      antiSpamMemory: { recordTechnicalDiscard() {} }, priorityForJupiterWork: (p: string) => p,
      adaptiveSizer: { findExecutableSize: async () => ({ success: false, error: 'stop before sending' }) }
    });
    void handler({ mint: 'mint', symbol: 'BLANK', liquidityUsd: 562_491 }, { layaScore: null }).then(() => { completed = true; });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    assert.equal(completed, true);
    assert.equal(nativeCalls, 0);
  } finally {
    axios.get = originalGet;
    if (originalShadow === undefined) delete process.env.SOLANA_LAYA_SHADOW_ENABLED;
    else process.env.SOLANA_LAYA_SHADOW_ENABLED = originalShadow;
  }
});

test('null-score Sentinel entries reach sizing despite LIVE Laya veto, abstention, failure or pending response', async () => {
  for (const evaluate of [
    async () => ({ action: 'REJECT', score: 0 }),
    async () => ({ action: 'ABSTAIN', score: 0 }),
    async () => { throw new Error('timeout'); },
    () => new Promise(() => {})
  ]) {
    let sizingCalls = 0;
    const vetoes: string[] = [];
    const handler = loadHandler('executeSentinelEntryCandidate', {
      executionUncertainReason: null, MAX_CONCURRENT_POSITIONS: 2,
      positionEngine: { getAllPositions: () => [] }, latestState: { circuitBreakerActive: false },
      entryGatekeeper: { auditToken: async () => ({ safe: true, score: 90, layaFacts: {} }) },
      wallet: { getBalanceSol: async () => 1 },
      buildEquitySizingPolicy: () => ({ canOpenNextPosition: true, ladderSol: [0.01] }),
      ENTRY_EQUITY_PCT: 0.1, MAX_TOTAL_ALLOCATION_PCT: 0.2, BUY_AMOUNT_SOL: 0.025,
      MAX_TOTAL_ALLOCATION_SOL: 0.1, GAS_RESERVE_EQUITY_PCT: 0.1, MIN_GAS_RESERVE_SOL: 0.01, MAX_GAS_RESERVE_SOL: 0.05,
      SOLANA_LAYA_TACTICAL_MODE: 'LIVE', process: { env: {} }, scheduleEntryAdvisory,
      solanaLayaAdapter: { evaluateEntry: evaluate },
      shouldBlockSolanaEntryFromLaya: () => ({ blocked: true, score: 0 }),
      antiSpamMemory: { recordVeto: (_mint: string, reason: string) => vetoes.push(reason), recordTechnicalDiscard() {} },
      priorityForJupiterWork: (p: string) => p,
      adaptiveSizer: { findExecutableSize: async () => { sizingCalls++; return { success: false, error: 'test stops before execution' }; } }
    });
    // Bounded microtask flush: a pending Laya request must not hold the financial path.
    let completed = false;
    const running = handler({ mint: 'mint', symbol: 'BLANK', liquidityUsd: 562_491 }, { layaScore: null }).then(() => { completed = true; });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    assert.equal(sizingCalls, 1);
    assert.equal(completed, true);
    assert.deepEqual(vetoes, []);
    await running;
  }
});

test('actual Sentinel handler bypasses DEX and forwards the Jupiter pool directly', async () => {
  const outcomes: any[] = [], executions: any[] = [];
  const latestState = { sentinelHandoffQueue: 0 };
  const route = { quote: { priceImpactPct: 1 }, poolAddress: 'jupiter-pool' };
  const handler = loadHandler('handleSentinelGraduationDip', {
    latestState, antiSpamMemory: { shouldSkip: () => ({skip:false}) },
    waitForSentinelJupiterRoute: async () => route,
    scanner: { fetchCurrentTokenMarketSnapshot() { throw Error('DEX forbidden'); } },
    observeEntryMomentum() { throw Error('DEX momentum forbidden'); },
    sentinelHandoffScanner: { recordHandoffOutcome: async (...args: any[]) => {outcomes.push(args);} },
    executeSentinelEntryCandidate: async (...args: any[]) => {executions.push(args);}
  });
  await handler({ mint:'mint',symbol:'S',layaScore:null,createdAt:new Date() });
  assert.equal(executions.length,1);
  assert.equal(executions[0][0].pairAddress,'jupiter-pool');
  assert.equal(executions[0][0].sentinelJupiterDepthVerified,true);
  assert.equal(latestState.sentinelHandoffQueue,0);
  assert.deepEqual(outcomes,[]);
});
test('actual Sentinel handler records a Jupiter deadline discard and clears queue', async () => {
  const outcomes: any[] = [];
  const handler = loadHandler('handleSentinelGraduationDip', {
    antiSpamMemory: {shouldSkip:()=>({skip:false})},waitForSentinelJupiterRoute:async()=>null,
    sentinelHandoffScanner:{recordHandoffOutcome:async(...args:any[])=>{outcomes.push(args);}}
  });
  await handler({mint:'mint',symbol:'S',createdAt:new Date()});
  assert.equal(outcomes[0][1],'DISCARDED_PRICE_IMPACT');
  assert.match(outcomes[0][2],/45s/);
});
test('actual entry handler records RugCheck, sizing, swap failure and real buy outcomes', async () => {
  for(const stage of ['risk','size','swap','success','dry','uncertain','reconciled']) {
    const outcomes:any[]=[]; let swapped=0, registered=0;
    const handler=loadHandler('executeSentinelEntryCandidate',{
      console:{log(){},warn(){},error(){}},
      PositionExitEngine:{DEFAULT_STOP_LOSS_PCT:-.125,TP1_TRIGGER_PCT:.25},
      executionUncertainReason:null,MAX_CONCURRENT_POSITIONS:2,
      positionEngine:{getAllPositions:()=>[],addPosition(){registered++;}},latestState:{circuitBreakerActive:false},
      entryGatekeeper:{auditToken:async()=>({safe:stage!=='risk',score:90,reason:'Top 5 holders 81.5%'})},
      wallet:{getBalanceSol:async()=>1,getKeypair:()=>({}),getReceivedTokenDeltaAtomic:async()=>null},
      buildEquitySizingPolicy:()=>({canOpenNextPosition:true,ladderSol:[.025]}),
      ENTRY_EQUITY_PCT:.1,MAX_TOTAL_ALLOCATION_PCT:.2,BUY_AMOUNT_SOL:.025,
      MAX_TOTAL_ALLOCATION_SOL:.1,GAS_RESERVE_EQUITY_PCT:.1,MIN_GAS_RESERVE_SOL:.01,MAX_GAS_RESERVE_SOL:.05,
      SOLANA_LAYA_TACTICAL_MODE:'OFF',process:{env:{}},priorityForJupiterWork:(p:string)=>p,
      adaptiveSizer:{findExecutableSize:async()=>stage==='size'?{success:false,error:'impact >2.5%'}:{success:true,sizeSol:.025,quote:{priceImpactPct:1,rawQuote:{}}}},
      referencesProgram:()=>false,PUMP_PROGRAM_ID:{toBase58:()=> 'pump'},randomUUID:()=> 'trace',
      OFFICIAL_PHANTOM_WALLET:'wallet',antiSpamMemory:{recordVeto(){},recordTechnicalDiscard(){}},
      sentinelHandoffScanner:{recordHandoffOutcome:async(...args:any[])=>{
        if(['EXECUTED_BUY_SUCCESS','DRY_RUN_BUY_SUCCESS'].includes(args[1])) assert.equal(registered,1,'position must be monitored before outcome persistence');
        outcomes.push(args);
      }},
      postgresRepo:{saveQuarantine:async()=>{}},
      reconcileUncertainV2Execution:async()=>stage==='reconciled'?{signature:'confirmed',deltaAtomic:'100'}:null,
      jupiterEngine:{executeSwap:async(req:any)=>{swapped++;assert.equal(req.maxPriceImpactPct,2.5);return {status:stage==='swap'?'FAILED':stage==='dry'?'DRY_RUN_SUCCESS':['uncertain','reconciled'].includes(stage)?'SUBMITTED_UNCONFIRMED':'SUCCESS',error:'failed order',txSignature:'signature',isDryRun:stage==='dry',inAmount:25000000,outAmount:100};}},
      journal:{logDecision(){}},DecisionLogger:{evaluateGate:()=>({})}
    });
    await handler({mint:'mint',symbol:'S',liquidityUsd:0,priceUsd:0,sentinelJupiterDepthVerified:true},{layaScore:null,createdAt:new Date()});
    const expected:{[key:string]:string}={risk:'DISCARDED_RUGCHECK',size:'DISCARDED_PRICE_IMPACT',swap:'FAILED_SWAP',success:'EXECUTED_BUY_SUCCESS',dry:'DRY_RUN_BUY_SUCCESS',uncertain:'SWAP_SUBMITTED_UNCONFIRMED',reconciled:'EXECUTED_BUY_SUCCESS'};
    assert.equal(outcomes[0][1],expected[stage]);
    assert.equal(swapped,stage==='risk'||stage==='size'?0:1);
  }
});
