export type ExitPathHealthState = 'HEALTHY' | 'DEGRADED' | 'EMERGENCY';

export interface ExitPathHealthSnapshot {
  state: ExitPathHealthState;
  canOpenNewPosition: boolean;
  canRunResearch: boolean;
  maxFailures: number;
  affectedMints: string[];
  reason?: string;
  lastChangedAt: string;
}

export interface ExitPathHealthOptions {
  emergencyFailures?: number;
  now?: () => number;
}

interface FailureState {
  failures: number;
  reason?: string;
}

export class ExitPathHealth {
  private readonly emergencyFailures: number;
  private readonly now: () => number;
  private readonly failures = new Map<string, FailureState>();
  private lastChangedAtMs: number;

  constructor(options: ExitPathHealthOptions = {}) {
    this.emergencyFailures = Math.max(1, Math.floor(options.emergencyFailures ?? 8));
    this.now = options.now ?? Date.now;
    this.lastChangedAtMs = this.now();
  }

  recordFailure(mint: string, failures: number, reason?: string): void {
    const normalized = Math.max(1, Math.floor(Number(failures) || 1));
    const previous = this.failures.get(mint);
    this.failures.set(mint, {
      failures: Math.max(previous?.failures ?? 0, normalized),
      reason: reason || previous?.reason
    });
    this.lastChangedAtMs = this.now();
  }

  recordSuccess(mint: string): void {
    if (this.failures.delete(mint)) {
      this.lastChangedAtMs = this.now();
    }
  }

  retainOpenPositions(mints: Iterable<string>): void {
    const open = new Set(mints);
    let changed = false;
    for (const mint of this.failures.keys()) {
      if (!open.has(mint)) {
        this.failures.delete(mint);
        changed = true;
      }
    }
    if (changed) this.lastChangedAtMs = this.now();
  }

  snapshot(): ExitPathHealthSnapshot {
    const entries = [...this.failures.entries()];
    const maxFailures = entries.reduce((max, [, value]) => Math.max(max, value.failures), 0);
    const state: ExitPathHealthState =
      maxFailures >= this.emergencyFailures
        ? 'EMERGENCY'
        : maxFailures > 0
          ? 'DEGRADED'
          : 'HEALTHY';
    const worst = entries.sort((a, b) => b[1].failures - a[1].failures)[0];

    return {
      state,
      canOpenNewPosition: state === 'HEALTHY',
      canRunResearch: state === 'HEALTHY',
      maxFailures,
      affectedMints: [...this.failures.keys()].sort(),
      reason: worst?.[1].reason,
      lastChangedAt: new Date(this.lastChangedAtMs).toISOString()
    };
  }
}
