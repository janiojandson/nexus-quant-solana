/** Bounded per-position monitoring clock; a stalled quote never blocks another mint. */
export class AdaptiveExitPoller {
  private nextAt = new Map<string, number>();
  private inFlight = new Set<string>();
  private activeKey = '';
  constructor(private readonly now: () => number,
    private readonly poll: (mint: string) => Promise<void>,
    private readonly observe?: (event: { mint: string; latencyMs: number;
      outcome: 'OK' | 'ERROR'; error?: string }) => void) {}

  reset(): void { this.nextAt.clear(); this.inFlight.clear(); this.activeKey = ''; }

  tick(mints: readonly string[]): void {
    if (mints.length > 2) throw new Error('MAX_TWO_POSITIONS');
    const unique = [...new Set(mints)];
    if (unique.length !== mints.length) throw new Error('DUPLICATE_POSITION');
    const key = [...unique].sort().join('|');
    const now = this.now();
    const interval = unique.length === 2 ? 2500 : 1500;
    if (key !== this.activeKey) {
      this.activeKey = key;
      this.nextAt.clear();
      const ordered = [...unique].sort();
      ordered.forEach((mint, index) => this.nextAt.set(mint, now + index * (interval / ordered.length)));
    }
    for (const mint of unique) {
      const due = this.nextAt.get(mint);
      if (due === undefined || due > now || this.inFlight.has(mint)) continue;
      this.nextAt.set(mint, now + interval);
      this.inFlight.add(mint);
      const started = now;
      void Promise.resolve().then(() => this.poll(mint)).then(
        () => this.observe?.({ mint, latencyMs: this.now() - started, outcome: 'OK' }),
        error => this.observe?.({ mint, latencyMs: this.now() - started, outcome: 'ERROR',
          error: error instanceof Error ? error.message : String(error) })
      ).finally(() => this.inFlight.delete(mint));
    }
  }
}
