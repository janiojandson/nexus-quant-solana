import type { PreFlightEngine, PreflightRequest, PreflightResult } from './preflightEngine.js';

export interface EntryCandidate {
  mint: string; symbol: string; name: string;
  priceUsd: number; liquidityUsd: number; pairAddress: string;
}
export interface EntryLease {
  mint: string; leaseId: string; assertLeaseActive(): Promise<void>;
}
export interface DurableEntryReceipt {
  durable: true; positionRegistered: true; accountingMode: 'SHADOW';
  entryIntentId: string; traceId: string;
}
export interface DurableEntryRegistrar {
  /** Task 5 owns atomic durable registration, active-mint uniqueness and fenced lease acceptance.
   * Implementations guard the lease before effects and after every await. */
  register(input: {
    candidate: EntryCandidate; stakeLamports: number;
    accepted: Extract<PreflightResult, {accepted:true}>;
    accountingMode: 'SHADOW'; abortSignal?: AbortSignal;
    lease?: EntryLease;
  }): Promise<DurableEntryReceipt>;
}
export interface EntryAttempt {
  candidate: EntryCandidate; stakeLamports: number;
  availableLamports: number; reservedGasLamports: number; poolHints?: readonly string[];
  verifySecurity(candidate: EntryCandidate): Promise<{safe:boolean;reason?:string}>;
  signal?: AbortSignal; lease?: EntryLease;
}
export type EntryAdmissionResult = {accepted:false;reason:string}
  | {accepted:true;receipt:DurableEntryReceipt;preflight:Extract<PreflightResult,{accepted:true}>};

/** Shared admission for discovery and Sentinel handoff. No registration means no acceptance. */
export class EntryAdmission {
  constructor(private readonly preflight: Pick<PreFlightEngine,'run'>,
    private readonly registrar?: DurableEntryRegistrar) {}

  async attempt(input: EntryAttempt): Promise<EntryAdmissionResult> {
    const fail = (reason:string):EntryAdmissionResult => ({accepted:false,reason});
    const guard = async () => {
      if (input.signal?.aborted) throw new Error('LEASE_LOST');
      await input.lease?.assertLeaseActive();
      if (input.signal?.aborted) throw new Error('LEASE_LOST');
    };
    try {
      await guard();
      if (!Number.isSafeInteger(input.stakeLamports) || input.stakeLamports <= 0 ||
          !input.candidate.mint || !input.candidate.symbol || !input.candidate.name ||
          !Number.isFinite(input.candidate.priceUsd) || input.candidate.priceUsd <= 0 ||
          !Number.isFinite(input.candidate.liquidityUsd) || input.candidate.liquidityUsd <= 0 ||
          !input.candidate.pairAddress) return fail('DADOS_INSUFICIENTES');
      const security = await input.verifySecurity(input.candidate);
      await guard();
      if (!security.safe) return fail(security.reason || 'SECURITY_VETO');
      const request: PreflightRequest = { mint:input.candidate.mint,stakeLamports:input.stakeLamports,
        availableLamports:input.availableLamports,reservedGasLamports:input.reservedGasLamports,
        poolHints:input.poolHints ?? [input.candidate.pairAddress],
        signal:input.signal,assertLeaseActive:input.lease?.assertLeaseActive };
      const preflight = await this.preflight.run(request);
      await guard();
      if (!preflight.accepted) return fail(preflight.reason);
      if (!this.registrar) return fail('PERSISTENCE_UNAVAILABLE');
      await guard();
      const receipt = await this.registrar.register({candidate:input.candidate,
        stakeLamports:input.stakeLamports,accepted:preflight,
        accountingMode:'SHADOW',abortSignal:input.signal,lease:input.lease});
      await guard();
      if (receipt?.durable !== true || receipt.positionRegistered !== true ||
          receipt.accountingMode !== 'SHADOW' || !receipt.entryIntentId || !receipt.traceId)
        return fail('PERSISTENCE_UNAVAILABLE');
      return {accepted:true,receipt,preflight};
    } catch(error) {
      return fail(input.signal?.aborted || (error instanceof Error && error.message === 'LEASE_LOST')
        ? 'LEASE_LOST' : 'PERSISTENCE_UNAVAILABLE');
    }
  }
}
