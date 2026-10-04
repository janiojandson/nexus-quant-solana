
/** Optional market metadata must never block an executable-price stop. */
export class NonBlockingTelemetry<T> {
  private readonly entries = new Map<string, { value?: T; at: number; pending: boolean }>();
  constructor(private readonly ttlMs = 5_000, private readonly limit = 128) {}
  read(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    return entry && now >= entry.at && now - entry.at <= this.ttlMs ? entry.value : undefined;
  }
  sample(key: string, fetchValue: () => Promise<T>, now = Date.now()): T | undefined {
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value!);
      entry = { at: 0, pending: false };
      this.entries.set(key, entry);
    }
    const result = now >= entry.at && now - entry.at <= this.ttlMs ? entry.value : undefined;
    if (!entry.pending) {
      entry.pending = true;
      const current = entry;
      void Promise.resolve().then(fetchValue).then(value => {
        current.value = value;
        current.at = now;
      }).catch(() => {
        // Unknown is not zero liquidity; invalidate stale success on errors.
        current.value = undefined;
      }).finally(() => { current.pending = false; });
    }
    return result;
  }
}
