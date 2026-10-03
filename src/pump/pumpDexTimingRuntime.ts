export interface PumpDexTimingSampler {
  sample(): Promise<void>;
}

type PumpDexTimingTimer = ReturnType<typeof setInterval>;
type PumpDexTimingSetInterval = (callback: () => void, intervalMs: number) => PumpDexTimingTimer;
type PumpDexTimingClearInterval = (timer: PumpDexTimingTimer) => void;

export interface PumpDexTimingRuntimeOptions {
  enabled?: boolean;
  intervalMs?: number;
  setIntervalFn?: PumpDexTimingSetInterval;
  clearIntervalFn?: PumpDexTimingClearInterval;
}

export class PumpDexTimingRuntime {
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly setIntervalFn: PumpDexTimingSetInterval;
  private readonly clearIntervalFn: PumpDexTimingClearInterval;
  private timer: PumpDexTimingTimer | null = null;

  constructor(
    private readonly sampler: PumpDexTimingSampler,
    options: PumpDexTimingRuntimeOptions = {}
  ) {
    this.enabled = options.enabled ?? true;
    this.intervalMs = Math.max(1_000, Number(options.intervalMs ?? 5_000));
    this.setIntervalFn = options.setIntervalFn ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
    this.clearIntervalFn = options.clearIntervalFn ?? (timer => clearInterval(timer));
  }

  start(): void {
    if (!this.enabled || this.timer) return;

    void this.sampleSafely();
    this.timer = this.setIntervalFn(() => {
      void this.sampleSafely();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer != null;
  }

  private async sampleSafely(): Promise<void> {
    try {
      await this.sampler.sample();
    } catch {
      // Observability is fail-open: sampler already owns telemetry for errors.
    }
  }
}
