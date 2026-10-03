import { PublicKey } from '@solana/web3.js';
import { decodePumpCreateEventsFromLogs, type PumpCreateEvent } from './pumpCreateEvent.js';
import {
  PUMP_PROGRAM_ID,
  calculatePumpCurveProgress,
  decodePumpBondingCurve,
  derivePumpBondingCurvePda
} from './pumpBondingCurve.js';

export interface PumpRpc {
  onLogs(
    programId: PublicKey,
    callback: (
      logs: { err: unknown; logs: string[]; signature: string },
      context: { slot: number }
    ) => void | Promise<void>,
    commitment?: 'confirmed'
  ): number | Promise<number>;
  removeOnLogsListener(id: number): Promise<void>;
  getAccountInfo(address: PublicKey, commitment?: 'confirmed'): Promise<{ data: Buffer | Uint8Array } | null>;
  getMultipleAccountsInfo?(
    addresses: PublicKey[],
    commitment?: 'confirmed'
  ): Promise<Array<{ data: Buffer | Uint8Array } | null>>;
}

export interface PumpObservation {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  bondingCurve: string;
  slot: number;
  signature: string;
  eventTimestampMs: number;
  observedAtMs: number;
  createToObserverLagMs: number;
  initialRealTokenReserves: string;
  currentRealTokenReserves?: string;
  progressPct?: number;
  complete: boolean;
  curveUpdatedAt?: string;
  dexFirstSeenAtMs?: number;
  dexReadyAtMs?: number;
  pumpToDexFirstSeenLagMs?: number;
  pumpToDexReadyLagMs?: number;
  dexPairAddress?: string;
  dexPairCreatedAtMs?: number;
  dexTimestampSkewMs?: number;
  dexPriceUsd?: number;
  dexLiquidityUsd?: number;
  dexUrl?: string;
  solscanUrl: string;
  transactionUrl: string;
  pumpUrl: string;
}

export interface PumpObservatorySnapshot {
  enabled: boolean;
  running: boolean;
  readOnly: true;
  totalCreatedObserved: number;
  activeCurves: number;
  graduatedCount: number;
  lastCreateToObserverLagMs?: number;
  maxCreateToObserverLagMs?: number;
  dexIndexedCount: number;
  dexReadyCount: number;
  lastPumpToDexReadyLagMs?: number;
  lastObservedAt?: string;
  lastError?: string;
  recent: PumpObservation[];
}

export interface PumpObservatoryOptions {
  enabled?: boolean;
  now?: () => number;
  refreshIntervalMs?: number;
  maxRecent?: number;
  refreshBatchSize?: number;
}

export class PumpObservatory {
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly maxRecent: number;
  private readonly refreshBatchSize: number;
  private readonly observations = new Map<string, PumpObservation>();
  private readonly seenEvents = new Set<string>();
  private subscriptionId: number | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private totalCreatedObserved = 0;
  private lastCreateToObserverLagMs: number | undefined;
  private maxCreateToObserverLagMs: number | undefined;
  private lastPumpToDexReadyLagMs: number | undefined;
  private lastObservedAt: string | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly rpc: PumpRpc,
    options: PumpObservatoryOptions = {}
  ) {
    this.enabled = options.enabled ?? true;
    this.now = options.now ?? Date.now;
    this.refreshIntervalMs = Math.max(5_000, options.refreshIntervalMs ?? 15_000);
    this.maxRecent = Math.max(10, options.maxRecent ?? 200);
    this.refreshBatchSize = Math.max(1, Math.min(100, options.refreshBatchSize ?? 50));
  }

  async start(): Promise<void> {
    if (!this.enabled || this.subscriptionId != null) return;

    try {
      this.subscriptionId = await this.rpc.onLogs(
        PUMP_PROGRAM_ID,
        async (logs, context) => {
          await this.processLogNotification(logs, context);
        },
        'confirmed'
      );

      this.refreshTimer = setInterval(() => {
        void this.refreshActiveCurves();
      }, this.refreshIntervalMs);
      this.refreshTimer.unref?.();
      this.lastError = undefined;
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      this.subscriptionId = null;
    }
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.subscriptionId != null) {
      const id = this.subscriptionId;
      this.subscriptionId = null;
      await this.rpc.removeOnLogsListener(id).catch(() => {});
    }
  }

  async processLogNotification(
    logs: { err: unknown; logs: string[]; signature: string },
    context: { slot: number }
  ): Promise<void> {
    if (logs.err) return;

    const events = decodePumpCreateEventsFromLogs(logs.logs);
    for (const event of events) {
      const dedupKey = `${logs.signature}:${event.mint}`;
      if (this.seenEvents.has(dedupKey)) continue;
      this.seenEvents.add(dedupKey);
      while (this.seenEvents.size > this.maxRecent * 4) {
        const oldest = this.seenEvents.values().next().value as string | undefined;
        if (!oldest) break;
        this.seenEvents.delete(oldest);
      }
      await this.recordCreateEvent(event, logs.signature, context.slot);
    }
  }

  private async recordCreateEvent(event: PumpCreateEvent, signature: string, slot: number): Promise<void> {
    const observedAtMs = this.now();
    const eventTimestampMs = Number(event.timestamp) * 1000;
    const createToObserverLagMs = Number.isSafeInteger(Number(event.timestamp))
      ? observedAtMs - eventTimestampMs
      : 0;
    const mint = new PublicKey(event.mint);
    const canonicalCurve = derivePumpBondingCurvePda(mint);

    const observation: PumpObservation = {
      mint: event.mint,
      symbol: event.symbol,
      name: event.name,
      creator: event.creator,
      bondingCurve: canonicalCurve.toBase58(),
      slot,
      signature,
      eventTimestampMs,
      observedAtMs,
      createToObserverLagMs,
      initialRealTokenReserves: event.realTokenReserves.toString(),
      currentRealTokenReserves: event.realTokenReserves.toString(),
      progressPct: 0,
      complete: false,
      solscanUrl: `https://solscan.io/token/${event.mint}`,
      transactionUrl: `https://solscan.io/tx/${signature}`,
      pumpUrl: `https://pump.fun/coin/${event.mint}`
    };

    this.observations.delete(event.mint);
    this.observations.set(event.mint, observation);
    while (this.observations.size > this.maxRecent) {
      const oldest = this.observations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.observations.delete(oldest);
    }

    this.totalCreatedObserved++;
    this.lastCreateToObserverLagMs = createToObserverLagMs;
    this.maxCreateToObserverLagMs = Math.max(
      this.maxCreateToObserverLagMs ?? createToObserverLagMs,
      createToObserverLagMs
    );
    this.lastObservedAt = new Date(observedAtMs).toISOString();
  }

  private applyCurveAccount(
    observation: PumpObservation,
    account: { data: Buffer | Uint8Array } | null
  ): void {
    if (!account) return;
    const curve = decodePumpBondingCurve(Buffer.from(account.data));
    if (!curve) return;

    observation.currentRealTokenReserves = curve.realTokenReserves.toString();
    observation.complete = curve.complete;
    observation.progressPct = calculatePumpCurveProgress(
      BigInt(observation.initialRealTokenReserves),
      curve.realTokenReserves,
      curve.complete
    );
    observation.curveUpdatedAt = new Date(this.now()).toISOString();
  }

  private async refreshObservation(observation: PumpObservation): Promise<void> {
    const account = await this.rpc.getAccountInfo(new PublicKey(observation.bondingCurve), 'confirmed');
    this.applyCurveAccount(observation, account);
  }

  getDexCorrelationCandidates(limit: number, maxAgeMs: number): Array<{ mint: string; eventTimestampMs: number }> {
    const cutoff = this.now() - Math.max(0, maxAgeMs);
    return [...this.observations.values()]
      .reverse()
      .filter(item => item.eventTimestampMs >= cutoff && item.dexReadyAtMs == null)
      .slice(0, Math.max(0, limit))
      .map(item => ({ mint: item.mint, eventTimestampMs: item.eventTimestampMs }));
  }

  applyDexCorrelation(
    mint: string,
    sample: {
      observedAtMs: number;
      ready: boolean;
      pairAddress: string;
      pairCreatedAtMs?: number;
      priceUsd?: number;
      liquidityUsd?: number;
      dexUrl: string;
    }
  ): void {
    const observation = this.observations.get(mint);
    if (!observation) return;

    if (observation.dexFirstSeenAtMs == null) {
      observation.dexFirstSeenAtMs = sample.observedAtMs;
      observation.pumpToDexFirstSeenLagMs = sample.observedAtMs - observation.eventTimestampMs;
    }
    if (sample.ready && observation.dexReadyAtMs == null) {
      observation.dexReadyAtMs = sample.observedAtMs;
      observation.pumpToDexReadyLagMs = sample.observedAtMs - observation.eventTimestampMs;
      this.lastPumpToDexReadyLagMs = observation.pumpToDexReadyLagMs;
    }

    observation.dexPairAddress = sample.pairAddress;
    observation.dexPairCreatedAtMs = sample.pairCreatedAtMs;
    observation.dexTimestampSkewMs = sample.pairCreatedAtMs == null
      ? undefined
      : sample.pairCreatedAtMs - observation.eventTimestampMs;
    observation.dexPriceUsd = sample.priceUsd;
    observation.dexLiquidityUsd = sample.liquidityUsd;
    observation.dexUrl = sample.dexUrl;
  }

  async refreshActiveCurves(): Promise<void> {
    const active = [...this.observations.values()]
      .reverse()
      .filter(observation => !observation.complete)
      .slice(0, this.refreshBatchSize);
    if (active.length === 0) return;

    try {
      if (this.rpc.getMultipleAccountsInfo) {
        const addresses = active.map(item => new PublicKey(item.bondingCurve));
        const accounts = await this.rpc.getMultipleAccountsInfo(addresses, 'confirmed');
        active.forEach((observation, index) => {
          this.applyCurveAccount(observation, accounts[index] ?? null);
        });
      } else {
        for (const observation of active) {
          await this.refreshObservation(observation);
        }
      }
      this.lastError = undefined;
    } catch (err: any) {
      this.lastError = err?.message || String(err);
    }
  }

  snapshot(): PumpObservatorySnapshot {
    const recent = [...this.observations.values()].reverse().map(item => ({ ...item }));
    const graduatedCount = recent.filter(item => item.complete).length;
    const dexIndexedCount = recent.filter(item => item.dexFirstSeenAtMs != null).length;
    const dexReadyCount = recent.filter(item => item.dexReadyAtMs != null).length;
    return {
      enabled: this.enabled,
      running: this.subscriptionId != null,
      readOnly: true,
      totalCreatedObserved: this.totalCreatedObserved,
      activeCurves: recent.filter(item => !item.complete).length,
      graduatedCount,
      lastCreateToObserverLagMs: this.lastCreateToObserverLagMs,
      maxCreateToObserverLagMs: this.maxCreateToObserverLagMs,
      dexIndexedCount,
      dexReadyCount,
      lastPumpToDexReadyLagMs: this.lastPumpToDexReadyLagMs,
      lastObservedAt: this.lastObservedAt,
      lastError: this.lastError,
      recent
    };
  }
}
