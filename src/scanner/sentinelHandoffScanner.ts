import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ConfirmedPoolReader, type ConfirmedPoolEvidence, type PoolEvidenceReader } from '../pump/confirmedPoolReader.js';
import type { HeliusRpcHub } from '../hubs/heliusRpcHub.js';

export interface CandidateLease {
  mint:string; symbol:string; devWallet:string|null; layaScore:number|null; pnlPercent:number|null;
  /** Sentinel observation time, never pool creation time. */
  createdAt:Date; leaseId:string; poolHints:string[];
}
export interface SentinelHandoffToken extends CandidateLease {
  isSentinelPreAudited:true;
  poolEvidence:ConfirmedPoolEvidence;
  /** Consumers must check this before preflight and acceptance effects, and after awaits. */
  leaseSignal:AbortSignal;
  assertLeaseActive:()=>Promise<void>;
}
export interface SentinelCrossMemoryResult {
  found:boolean; isGraduated:boolean; layaScore:number|null; pnlPercent:number|null; status:string|null; devWallet:string|null;
}
export interface CandidateStore {
  claim():Promise<CandidateLease[]>;
  confirm(mint:string,leaseId:string,evidence:ConfirmedPoolEvidence):Promise<boolean>;
  renew(mint:string,leaseId:string):Promise<boolean>;
  acknowledgeAccepted(mint:string,leaseId:string):Promise<boolean>;
  release(mint:string,leaseId:string,reason:string):Promise<void>;
}
const finite = (n:unknown):number|null => n===null||n===undefined||!Number.isFinite(Number(n))?null:Number(n);
const LEASE_MS=120_000;
/** Requires additive schema_sentinel_handoff.sql migration; no implicit production migration. */
export class PostgresCandidateStore implements CandidateStore {
  constructor(private readonly pool:Pool) {}
  async claim():Promise<CandidateLease[]> {
    const result=await this.pool.query(`
      WITH eligible AS (
        SELECT mint FROM sentinel_handoff
        WHERE consumed_by_quant = FALSE
          AND status IN ('CANDIDATE','PENDING_POOL','POOL_CONFIRMED')
          AND next_check_at <= NOW()
          AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
        ORDER BY next_check_at, created_at
        FOR UPDATE SKIP LOCKED LIMIT 5
      )
      UPDATE sentinel_handoff h
      SET lease_id = $1, lease_expires_at = NOW() + INTERVAL '120 seconds',
          retry_count = retry_count + 1
      FROM eligible e WHERE h.mint = e.mint RETURNING h.*`,[randomUUID()]);
    return result.rows.map(row=>({mint:row.mint,symbol:row.symbol||row.mint.slice(0,6),devWallet:row.dev_wallet,
      layaScore:finite(row.laya_score),pnlPercent:finite(row.pnl_percent),createdAt:new Date(row.created_at),
      leaseId:row.lease_id,poolHints:Array.isArray(row.pool_hints)?row.pool_hints.filter((h:unknown)=>typeof h==='string').slice(0,4):[]}));
  }
  async confirm(mint:string,leaseId:string,evidence:ConfirmedPoolEvidence):Promise<boolean> {
    const result=await this.pool.query(`UPDATE sentinel_handoff
      SET status = 'POOL_CONFIRMED', pool_proof = $3::jsonb, pool_confirmed_at = NOW(), last_error = NULL
      WHERE mint = $1 AND lease_id = $2 AND consumed_by_quant = FALSE AND lease_expires_at > NOW()`,
      [mint,leaseId,JSON.stringify(evidence)]);
    return result.rowCount===1;
  }
  async renew(mint:string,leaseId:string):Promise<boolean> {
    const result=await this.pool.query(`UPDATE sentinel_handoff SET lease_expires_at = NOW() + INTERVAL '120 seconds'
      WHERE mint = $1 AND lease_id = $2 AND consumed_by_quant = FALSE AND lease_expires_at > NOW()`,[mint,leaseId]);
    return result.rowCount===1;
  }
  async acknowledgeAccepted(mint:string,leaseId:string):Promise<boolean> {
    const result=await this.pool.query(`UPDATE sentinel_handoff
      SET consumed_by_quant = TRUE, consumed_at = COALESCE(consumed_at,NOW()), status = 'ACCEPTED', lease_expires_at = NULL
      WHERE mint = $1 AND lease_id = $2 AND pool_proof IS NOT NULL
        AND ((status = 'POOL_CONFIRMED' AND consumed_by_quant = FALSE AND lease_expires_at > NOW())
          OR (status = 'ACCEPTED' AND consumed_by_quant = TRUE))`,[mint,leaseId]);
    return result.rowCount===1;
  }
  async release(mint:string,leaseId:string,reason:string):Promise<void> {
    await this.pool.query(`UPDATE sentinel_handoff
      SET status = CASE WHEN pool_proof IS NULL THEN 'PENDING_POOL' ELSE 'POOL_CONFIRMED' END,
          lease_id = NULL, lease_expires_at = NULL,
          next_check_at = NOW() + LEAST(60, GREATEST(3, retry_count * 3)) * INTERVAL '1 second', last_error = $3
      WHERE mint = $1 AND lease_id = $2 AND consumed_by_quant = FALSE`,
      [mint,leaseId,/^[A-Z_]+$/.test(reason)?reason:'HANDOFF_RETRY']);
  }
}

export class SentinelHandoffScanner extends EventEmitter {
  private readonly store:CandidateStore|null;
  private readonly reader:PoolEvidenceReader|null;
  private readonly pollingIntervalMs:number;
  private pollingTimer:ReturnType<typeof setInterval>|null=null;
  private isPolling=false;
  constructor(private readonly pgPool:Pool|null,options:{pollingIntervalMs?:number;rpcHub?:HeliusRpcHub;reader?:PoolEvidenceReader;store?:CandidateStore}={}) {
    super();this.store=options.store??(pgPool?new PostgresCandidateStore(pgPool):null);
    this.reader=options.reader??(options.rpcHub?new ConfirmedPoolReader(options.rpcHub):null);
    this.pollingIntervalMs=options.pollingIntervalMs??3000;
  }
  async start():Promise<void> {
    if(!this.store||!this.reader||this.pollingTimer)return;
    this.pollingTimer=setInterval(()=>{void this.poll();},this.pollingIntervalMs);this.pollingTimer.unref?.();
  }
  stop():void {if(this.pollingTimer)clearInterval(this.pollingTimer);this.pollingTimer=null;}
  /** Explicit single poll also supports supervised callers without starting a timer. */
  async poll():Promise<void> {
    if(this.isPolling||!this.store||!this.reader)return;
    this.isPolling=true;
    try {
      const leases=await this.store.claim();
      await Promise.allSettled(leases.map(lease=>this.processLease(lease)));
    } catch {console.warn('[SentinelHandoff] HANDOFF_STORE_UNAVAILABLE');}
    finally {this.isPolling=false;}
  }
  async acknowledgeAccepted(mint:string,leaseId:string):Promise<boolean> {
    return this.store?this.store.acknowledgeAccepted(mint,leaseId):false;
  }
  async release(mint:string,leaseId:string,reason='ENTRY_NOT_ACCEPTED'):Promise<void> {
    await this.store?.release(mint,leaseId,reason);
  }
  private async processLease(lease:CandidateLease):Promise<void> {
    let reason='ENTRY_NOT_ACCEPTED';
    const controller=new AbortController();
    let deadline=Date.now()+LEASE_MS;
    let expiryTimer:ReturnType<typeof setTimeout>|null=null;
    const scheduleExpiry=():void=>{
      if(expiryTimer)clearTimeout(expiryTimer);
      expiryTimer=setTimeout(()=>controller.abort(),Math.max(0,deadline-Date.now()));
      expiryTimer.unref?.();
    };
    const assertLeaseActive=async():Promise<void>=>{
      if(controller.signal.aborted||Date.now()>=deadline){controller.abort();throw new Error('LEASE_LOST');}
      const requestedAt=Date.now();
      try {
        if(!await this.store!.renew(lease.mint,lease.leaseId)){
          controller.abort();throw new Error('LEASE_LOST');
        }
        if(controller.signal.aborted)throw new Error('LEASE_LOST');
        deadline=requestedAt+LEASE_MS;
        if(Date.now()>=deadline){controller.abort();throw new Error('LEASE_LOST');}
        scheduleExpiry();
      } catch(error) {
        controller.abort();throw error;
      }
    };
    scheduleExpiry();
    // A failed renewal cancels the cooperative consumer immediately.
    const renewal=setInterval(()=>{void assertLeaseActive().catch(()=>{});},LEASE_MS/3);
    renewal.unref?.();
    try {
      const result=await this.reader!.read(lease.mint,lease.poolHints);
      if(!result.ok){reason=result.code;return;}
      if(!await this.store!.confirm(lease.mint,lease.leaseId,result.evidence)){reason='LEASE_LOST';return;}
      await assertLeaseActive();
      const token:SentinelHandoffToken={...lease,isSentinelPreAudited:true,poolEvidence:result.evidence,
        leaseSignal:controller.signal,assertLeaseActive};
      // Await async consumers. emit() alone cannot acknowledge execution or observe early returns.
      const handlers=this.rawListeners('sentinelGraduationToken');
      if(!handlers.length){reason='NO_ACCEPTING_HANDLER';return;}
      for(const handler of handlers){await assertLeaseActive();await handler.call(this,token);}
    } catch {reason=controller.signal.aborted?'LEASE_LOST':'HANDOFF_PROCESSING_FAILED';}
    finally {
      clearInterval(renewal);
      if(expiryTimer)clearTimeout(expiryTimer);
      controller.abort();
      try {await this.release(lease.mint,lease.leaseId,reason);}
      catch {console.warn('[SentinelHandoff] HANDOFF_RELEASE_FAILED');}
    }
  }
  async checkCrossMemory(mint:string,devWallet?:string|null):Promise<SentinelCrossMemoryResult> {
    const missing:SentinelCrossMemoryResult={found:false,isGraduated:false,layaScore:null,pnlPercent:null,status:null,devWallet:null};
    if(!this.pgPool)return missing;
    try {
      const result=await this.pgPool.query(`SELECT mint,dev_wallet,status,laya_score,pnl_percent,pool_proof
        FROM sentinel_handoff WHERE mint = $1 OR ($2::text IS NOT NULL AND dev_wallet = $2::text)
        ORDER BY CASE WHEN mint = $1 THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,[mint,devWallet||null]);
      const row=result.rows[0];if(!row)return missing;
      return {found:true,isGraduated:['POOL_CONFIRMED','ACCEPTED'].includes(row.status)&&row.pool_proof?.kind==='PHYSICAL_POOL_CONFIRMED',
        layaScore:finite(row.laya_score),pnlPercent:finite(row.pnl_percent),status:row.status,devWallet:row.dev_wallet};
    } catch {return missing;}
  }
}

