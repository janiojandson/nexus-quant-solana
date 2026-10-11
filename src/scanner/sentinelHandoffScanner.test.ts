import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SentinelHandoffScanner, PostgresCandidateStore, type CandidateStore, type CandidateLease, type SentinelHandoffToken } from './sentinelHandoffScanner.js';
import type { ConfirmedPoolEvidence, PoolReadResult } from '../pump/confirmedPoolReader.js';

describe('recordHandoffOutcome (main)', () => {
  function makePool(overrides: Partial<{
    queryResults: Record<string, any>;
    lockRowCount: number;
    throwOnTable: boolean;
    throwOnLock: boolean;
  }> = {}) {
    const results: Record<string, any> = overrides.queryResults ?? {};
    const lockRowCount = overrides.lockRowCount ?? 1;

    return {
      query: async (sql: string, params?: unknown[]) => {
        const sqlTrimmed = String(sql).trim().toLowerCase();

        // Schema migration
        if (sqlTrimmed.includes('alter table')) {
          if (overrides.throwOnTable) throw new Error('relation "sentinel_handoff" does not exist');
          return { rowCount: 0, rows: [] };
        }

        // Lock atomico UPDATE
        if (sqlTrimmed.includes('update sentinel_handoff')) {
          if (overrides.throwOnLock) throw new Error('lock error');
          return { rowCount: lockRowCount, rows: [] };
        }

        // SELECT de candidatos
        if (sqlTrimmed.includes('select mint')) {
          const key = params ? String(params[0]) : 'default';
          return { rowCount: (results[key] ?? results['default'] ?? []).length, rows: results[key] ?? results['default'] ?? [] };
        }

        return { rowCount: 0, rows: [] };
      }
    };
  }

  test('handoff outcome persists exact status and detail without propagating database errors', async () => {
    const calls: any[] = [];
    const scanner = new SentinelHandoffScanner({ query: async (config: any) => {
      calls.push({ sql: config.text, params: config.values, timeout: config.query_timeout }); return { rowCount: 1 };
    } } as any);
    await scanner.recordHandoffOutcome('mint', 'DISCARDED_RUGCHECK', 'Top5 81.5%');
    assert.deepEqual(calls[0].params, ['DISCARDED_RUGCHECK', 'Top5 81.5%', 'mint']);
    assert.match(calls[0].sql, /outcome_recorded_at = NOW\(\)/);
    assert.equal(calls[0].timeout, 5000);
    await new SentinelHandoffScanner(null).recordHandoffOutcome('mint', 'FAILED_SWAP');
    await new SentinelHandoffScanner({ query: async () => { throw new Error('db unavailable'); } } as any)
      .recordHandoffOutcome('mint', 'FAILED_SWAP', 'timeout');
  });
});

describe('lease flow (codex)', () => {
  const proof:ConfirmedPoolEvidence={kind:'PHYSICAL_POOL_CONFIRMED',venue:'PumpSwap',slot:100,observedAt:new Date().toISOString(),programId:'fixture-program',poolAddress:'fixture-pool',baseMint:'mint',quoteMint:'sol',baseVault:'base',quoteVault:'quote',physicalSolLamports:'20000000000',tokenReserveAtomic:'5000000',poolCreatedAt:null};
  // Durable fixture survives scanner destruction; its clock models database lease expiry.
  class MemoryStore implements CandidateStore {
    now=0; id=0; consumed=false; status='CANDIDATE'; next=0; expiry=0; lease=''; saved:ConfirmedPoolEvidence|null=null; retries=0;
    async claim():Promise<CandidateLease[]> {
      if(this.consumed||this.next>this.now||this.expiry>this.now)return [];
      this.lease=String(++this.id);this.expiry=this.now+120000;this.retries++;
      return [{mint:'mint',symbol:'SYM',devWallet:null,layaScore:null,pnlPercent:null,createdAt:new Date(0),leaseId:this.lease,poolHints:[]}];
    }
    async confirm(mint:string,lease:string,evidence:ConfirmedPoolEvidence){if(!this.owned(lease))return false;this.saved=evidence;this.status='POOL_CONFIRMED';return true;}
    async renew(mint:string,lease:string){if(!this.owned(lease))return false;this.expiry=this.now+120000;return true;}
    async acknowledgeAccepted(mint:string,lease:string){if(this.consumed)return this.lease===lease;if(!this.owned(lease)||!this.saved)return false;this.consumed=true;this.status='ACCEPTED';return true;}
    async release(mint:string,lease:string,reason:string){if(!this.owned(lease)||this.consumed)return;this.expiry=0;this.lease='';this.next=this.now+1000;if(!this.saved)this.status='PENDING_POOL';}
    private owned(lease:string){return this.lease===lease&&this.expiry>this.now;}
  }
function scanner(store:MemoryStore,result:PoolReadResult={ok:true,evidence:proof}) {
  return new SentinelHandoffScanner(null,{store,reader:{read:async()=>result},pollingIntervalMs:999999});
}
test('null RPC retry survives scanner restart and old candidate age',async()=>{
  const store=new MemoryStore();let emitted=0;
  const first=scanner(store,{ok:false,code:'POOL_NOT_FOUND'});first.on('sentinelGraduationToken',()=>{emitted++;});
  await first.poll();first.stop();assert.equal(store.consumed,false);assert.equal(emitted,0);
  store.now=86400000;const restarted=scanner(store);
  restarted.on('sentinelGraduationToken',async(token:SentinelHandoffToken)=>{emitted++;assert.equal(token.poolEvidence.slot,100);await restarted.acknowledgeAccepted(token.mint,token.leaseId);});
  await restarted.poll();assert.equal(emitted,1);assert.equal(store.consumed,true);assert.equal(store.retries,2);
});
test('emit/early return do not consume and retained proof is refreshed on retry',async()=>{
  const store=new MemoryStore();const s=scanner(store);s.on('sentinelGraduationToken',async()=>{});
  await s.poll();assert.equal(store.consumed,false);assert.equal(store.status,'POOL_CONFIRMED');assert.equal(store.saved?.slot,100);
  store.now+=2000;const next=scanner(store,{ok:false,code:'RPC_UNAVAILABLE'});let count=0;next.on('sentinelGraduationToken',()=>{count++;});
  await next.poll();assert.equal(count,0);assert.equal(store.consumed,false);
});
test('handler failure releases for retry and missing reader never emits',async()=>{
  const store=new MemoryStore();const s=scanner(store);s.on('sentinelGraduationToken',()=>{throw new Error('handler');});await s.poll();
  assert.equal(store.consumed,false);assert.equal(store.lease,'');
  store.now+=2000;const empty=new SentinelHandoffScanner(null,{store});let emitted=0;empty.on('sentinelGraduationToken',()=>{emitted++;});await empty.poll();assert.equal(emitted,0);
});
test('concurrent scanners cannot lease twice; acknowledgement is fenced and idempotent',async()=>{
  const store=new MemoryStore();const s=scanner(store);const other=scanner(store);let entered=0;
  s.on('sentinelGraduationToken',async(token:SentinelHandoffToken)=>{
    entered++;await other.poll();assert.equal(await s.acknowledgeAccepted('mint','old'),false);
    assert.equal(await s.acknowledgeAccepted('mint',token.leaseId),true);assert.equal(await s.acknowledgeAccepted('mint',token.leaseId),true);
  });other.on('sentinelGraduationToken',()=>{entered++;});await s.poll();await other.poll();assert.equal(entered,1);
});
test('crashed lease expires and old owner cannot consume new lease',async()=>{
  const store=new MemoryStore();const old=(await store.claim())[0];store.now=120001;
  const s=scanner(store);s.on('sentinelGraduationToken',async(token:SentinelHandoffToken)=>{assert.equal(await s.acknowledgeAccepted('mint',old.leaseId),false);await s.acknowledgeAccepted('mint',token.leaseId);});
  await s.poll();assert.equal(store.consumed,true);
});
for(const failure of ['false','error'] as const){
  test(`renewal ${failure} cancels a slow consumer before acceptance effects`,async()=>{
    const store=new MemoryStore();
    const renewals:Array<()=>void>=[];const originalInterval=globalThis.setInterval;
    (globalThis as any).setInterval=(callback:()=>void)=>{renewals.push(callback);return {unref(){}};};
    let enter!:()=>void;let resume!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve;});
    const waiting=new Promise<void>(resolve=>{resume=resolve;});
    let firstEffects=0, firstAborted=false, secondEffects=0;
    const first=scanner(store),second=scanner(store);
    first.on('sentinelGraduationToken',async(token:SentinelHandoffToken)=>{
      enter();await waiting;
      firstAborted=token.leaseSignal.aborted;
      try {await token.assertLeaseActive();firstEffects++;await first.acknowledgeAccepted(token.mint,token.leaseId);} catch {}
    });
    second.on('sentinelGraduationToken',async(token:SentinelHandoffToken)=>{
      await token.assertLeaseActive();secondEffects++;await second.acknowledgeAccepted(token.mint,token.leaseId);
    });
    try {
      const running=first.poll();await entered;
      if(failure==='error'){
        const realRenew=store.renew.bind(store);
        store.renew=async(mint,lease)=>lease==='1' ? Promise.reject(new Error('DB unavailable')) : realRenew(mint,lease);
      }
      store.now=120001;
      await second.poll();
      await renewals[0]();
      for(let i=0;i<4;i++)await Promise.resolve();
      resume();await running;
      assert.equal(firstAborted,true);assert.equal(firstEffects,0);assert.equal(secondEffects,1);assert.equal(store.consumed,true);
    } finally {globalThis.setInterval=originalInterval;resume?.();}
  });
}
test('local lease expiry aborts a stalled consumer even if renewal has not returned',async()=>{
  const store=new MemoryStore();const originalTimeout=globalThis.setTimeout;
  let expire!:()=>void;
  (globalThis as any).setTimeout=(callback:()=>void)=>{expire=callback;return {unref(){}};};
  let enter!:()=>void;let resume!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;});
  const waiting=new Promise<void>(resolve=>{resume=resolve;});
  let aborted=false,effects=0;
  const s=scanner(store);
  s.on('sentinelGraduationToken',async(token:SentinelHandoffToken)=>{
    enter();await waiting;aborted=token.leaseSignal.aborted;
    try {await token.assertLeaseActive();effects++;} catch {}
  });
  try {
    const running=s.poll();await entered;
    assert.equal(typeof expire,'function');
    expire();resume();await running;
    assert.equal(aborted,true);assert.equal(effects,0);
  } finally {globalThis.setTimeout=originalTimeout;resume?.();}
});
test('candidate and legacy graduating labels are not physical graduation',async()=>{
  for(const status of ['CANDIDATE','GRADUATING_HIGH_STRENGTH','PENDING_POOL','POOL_CONFIRMED','ACCEPTED']) {
    const pool={query:async()=>({rows:[{status,laya_score:null,pnl_percent:null,dev_wallet:null,pool_proof:status==='POOL_CONFIRMED'||status==='ACCEPTED'?proof:null}]})};
    const s=new SentinelHandoffScanner(pool as any);const result=await s.checkCrossMemory('mint');
    assert.equal(result.isGraduated,status==='POOL_CONFIRMED'||status==='ACCEPTED');
  }
});
test('Postgres queries lock atomically, serialize evidence, and ACK only confirmed lease',async()=>{
  const calls:{sql:string;params:any[]}[]=[];
  const pool={query:async(sql:string,params:any[]=[])=>{calls.push({sql,params});return {rows:[],rowCount:1};}};
  const store=new PostgresCandidateStore(pool as any);await store.claim();await store.confirm('mint','lease',proof);await store.acknowledgeAccepted('mint','lease');await store.release('mint','lease','RPC_UNAVAILABLE');
  assert.match(calls[0].sql,/FOR UPDATE SKIP LOCKED/);assert.doesNotMatch(calls[0].sql,/created_at\s*>/);
  assert.match(calls[0].sql,/lease_expires_at/);assert.doesNotMatch(calls[0].sql,/consumed_by_quant\s*=\s*TRUE/i);
  assert.equal(JSON.parse(calls[1].params[2]).physicalSolLamports,'20000000000');
  assert.match(calls[2].sql,/POOL_CONFIRMED/);assert.match(calls[2].sql,/consumed_by_quant = TRUE/);assert.ok(calls[2].sql.includes('lease_id = $2'));
  assert.match(calls[3].sql,/consumed_by_quant = FALSE/);
});
});

