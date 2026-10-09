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
    console: { log() {}, warn() {}, error(e: unknown) { throw new Error(String(e)); } },
    ...dependencies
  }) as (...args: any[]) => Promise<void>;
}

test('physical handoff fails explicitly without Task3 metadata and preserves candidate for retry', async () => {
  const released:any[]=[];const warnings:string[]=[];let executed=0;
  const handler=loadHandler('handleSentinelGraduationDip',{
    sentinelHandoffScanner:{release:async(...args:any[])=>{released.push(args);}},
    executeSentinelEntryCandidate:async()=>{executed++;},
    console:{log(){},warn:(s:string)=>warnings.push(s),error(){}},
    antiSpamMemory:{shouldSkip:()=>({skip:false})},
    setTimeout:(resolve:()=>void)=>resolve(),Date:{now:()=>200000}
  });
  await handler({mint:'mint',symbol:'SYM',leaseId:'lease',createdAt:new Date(0),
    poolEvidence:{kind:'PHYSICAL_POOL_CONFIRMED',poolAddress:'pool',poolCreatedAt:null}});
  assert.equal(executed,0);assert.deepEqual(released,[['mint','lease','DADOS_INSUFICIENTES']]);
  assert.ok(warnings.some(s=>s.includes('DADOS_INSUFICIENTES')));
});
test('only registered entry acknowledges its durable lease; hypothetical execution cannot consume',async()=>{
  for(const hypothetical of [true,false]){
    const actions:string[]=[];const handler=loadHandler('executeSentinelEntryCandidate',{
      executionUncertainReason:null,MAX_CONCURRENT_POSITIONS:2,
      positionEngine:{getAllPositions:()=>[],addPosition:()=>actions.push('registered')},
      entryGatekeeper:{auditToken:async()=>({safe:true,score:90})},wallet:{getBalanceSol:async()=>1},
      buildEquitySizingPolicy:()=>({canOpenNextPosition:true,ladderSol:[0.01]}),
      ENTRY_EQUITY_PCT:0.1,MAX_TOTAL_ALLOCATION_PCT:0.2,BUY_AMOUNT_SOL:0.025,MAX_TOTAL_ALLOCATION_SOL:0.1,
      GAS_RESERVE_EQUITY_PCT:0.1,MIN_GAS_RESERVE_SOL:0.01,MAX_GAS_RESERVE_SOL:0.05,
      priorityForJupiterWork:(p:string)=>p,adaptiveSizer:{findExecutableSize:async()=>({success:true,quote:{rawQuote:{routePlan:[]}},sizeSol:0.01})},
      referencesProgram:()=>false,PUMP_PROGRAM_ID:{toBase58:()=> 'curve'},randomUUID:()=> 'trace',OFFICIAL_PHANTOM_WALLET:'wallet',getExecutionSigner:()=>undefined,
      jupiterEngine:{executeSwap:async()=>({status:'SUCCESS',isDryRun:true,outAmount:100,inAmount:10000000})},
      isHypotheticalExecution:()=>hypothetical,
      PositionExitEngine:{DEFAULT_STOP_LOSS_PCT:10,TP1_TRIGGER_PCT:20},
      sentinelHandoffScanner:{acknowledgeAccepted:async(m:string,l:string)=>{assert.equal(m,'mint');assert.equal(l,'lease');actions.push('acknowledged');return true;}},
      journal:{logDecision(){}},DecisionLogger:{evaluateGate:()=>({})}
    });
    await handler({mint:'mint',symbol:'SYM',liquidityUsd:20000,priceUsd:1,pairCreatedAt:Date.now()}, {leaseId:'lease',createdAt:new Date(),layaScore:null});
    assert.deepEqual(actions,hypothetical?[]:['registered','acknowledged']);
  }
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
