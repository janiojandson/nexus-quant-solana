export interface IncubatedToken {
  mint: string;
  poolAddress: string;
  symbol?: string;
  name?: string;
  discoveredAt: number;
  pairCreatedAt: number;
}

export interface IncubatorSweepResult {
  waiting: IncubatedToken[];
  mature: IncubatedToken[];
  expiredCount: number;
}

export class MaturityIncubator {
  private queue = new Map<string, IncubatedToken>();
  private maxQueueSize = 500;
  public readonly minMaturityMs: number;
  public readonly maxMaturityMs: number;

  constructor(options?: { minMaturityMinutes?: number; maxMaturityMinutes?: number }) {
    this.minMaturityMs = (options?.minMaturityMinutes ?? 15) * 60 * 1000;
    this.maxMaturityMs = (options?.maxMaturityMinutes ?? 60) * 60 * 1000;
  }

  public add(
    token: { mint: string; poolAddress: string; symbol?: string; name?: string; pairCreatedAt?: number },
    now: number = Date.now()
  ): boolean {
    if (!token.mint) return false;
    if (this.queue.has(token.mint)) {
      return false; // Já está na incubadora
    }

    if (this.queue.size >= this.maxQueueSize) {
      const oldestKey = this.queue.keys().next().value;
      if (oldestKey) this.queue.delete(oldestKey);
    }

    this.queue.set(token.mint, {
      mint: token.mint,
      poolAddress: token.poolAddress,
      symbol: token.symbol,
      name: token.name,
      discoveredAt: now,
      pairCreatedAt: (token.pairCreatedAt && token.pairCreatedAt > 0) ? token.pairCreatedAt : now
    });
    return true;
  }

  public sweep(now: number = Date.now()): IncubatorSweepResult {
    const waiting: IncubatedToken[] = [];
    const mature: IncubatedToken[] = [];
    let expiredCount = 0;

    for (const [mint, item] of this.queue.entries()) {
      const refTime = (item.pairCreatedAt && item.pairCreatedAt > 0) ? item.pairCreatedAt : item.discoveredAt;
      const ageMs = now - refTime;

      if (ageMs > this.maxMaturityMs) {
        // Expirado (> 60m)
        this.queue.delete(mint);
        expiredCount++;
      } else if (ageMs >= this.minMaturityMs) {
        // Maduro (15 a 60 min)
        mature.push(item);
      } else {
        // Aguardando maturação (< 15 min)
        waiting.push(item);
      }
    }

    return { waiting, mature, expiredCount };
  }

  public remove(mint: string): void {
    this.queue.delete(mint);
  }

  public size(): number {
    return this.queue.size;
  }

  public getWaitingCount(now: number = Date.now()): number {
    return this.sweep(now).waiting.length;
  }

  public clear(): void {
    this.queue.clear();
  }

  public getAll(): IncubatedToken[] {
    return Array.from(this.queue.values());
  }
}
