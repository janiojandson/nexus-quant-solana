export class MintCooldownCache {
  private cache = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMinutes: number = 5) {
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  public shouldProcess(mint: string): boolean {
    if (!mint) return false;
    const now = Date.now();
    const expiry = this.cache.get(mint);

    if (expiry && now < expiry) {
      return false; // Dentro da quarentena TTL
    }

    if (expiry && now >= expiry) {
      this.cache.delete(mint);
    }
    return true;
  }

  public recordRejection(mint: string, customTtlMs?: number): void {
    if (!mint) return;
    const now = Date.now();
    this.cache.set(mint, now + (customTtlMs || this.ttlMs));
    this.cleanExpired(now);
  }

  public size(): number {
    return this.cache.size;
  }

  public clear(): void {
    this.cache.clear();
  }

  private cleanExpired(now: number): void {
    if (this.cache.size > 500) {
      for (const [mint, exp] of this.cache.entries()) {
        if (now >= exp) this.cache.delete(mint);
      }
    }
  }
}
