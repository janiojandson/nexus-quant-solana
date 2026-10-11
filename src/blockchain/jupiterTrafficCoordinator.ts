export type JupiterPriority = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type JupiterTrafficBucket = 'general' | 'execute';

export interface JupiterTrafficCoordinatorOptions {
  generalIntervalMs?: number;
  executeIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface QueueItem<T> {
  priority: JupiterPriority;
  sequence: number;
  op: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

interface BucketState {
  intervalMs: number;
  lastStartedAt: number;
  running: boolean;
  completed: number;
  failed: number;
  rateLimited: number;
  totalWaitMs: number;
  queue: QueueItem<unknown>[];
  blockedUntil: number;
}

export interface JupiterTrafficBucketSnapshot {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  rateLimited: number;
  totalWaitMs: number;
}

export interface JupiterTrafficSnapshot {
  general: JupiterTrafficBucketSnapshot;
  execute: JupiterTrafficBucketSnapshot;
}

export class JupiterTrafficCoordinator {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private sequence = 0;
  private readonly buckets: Record<JupiterTrafficBucket, BucketState>;
  // A credential scope represents one independently limited organization.
  // Scope identifiers stay in memory and are never included in telemetry.
  private readonly organizationBuckets = new Map<string, Record<JupiterTrafficBucket, BucketState>>();

  constructor(options: JupiterTrafficCoordinatorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.buckets = {
      general: this.makeBucket(Math.max(0, options.generalIntervalMs ?? 1050)),
      execute: this.makeBucket(Math.max(0, options.executeIntervalMs ?? 20))
    };
  }

  private makeBucket(intervalMs: number): BucketState {
    return {
      intervalMs,
      lastStartedAt: 0,
      running: false,
      completed: 0,
      failed: 0,
      rateLimited: 0,
      totalWaitMs: 0,
      queue: [],
      blockedUntil: 0
    };
  }

  schedule<T>(
    priority: JupiterPriority,
    op: () => Promise<T>,
    bucket: JupiterTrafficBucket = 'general',
    signal?: AbortSignal,
    organizationScope?: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const state = this.getBuckets(organizationScope)[bucket];
      if (signal?.aborted) { reject(new Error('Jupiter request aborted')); return; }
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const item: QueueItem<unknown> = {
        priority,
        sequence: this.sequence++,
        op: async () => { if (signal?.aborted) throw new Error('Jupiter request aborted'); return op(); },
        resolve: value => { cleanup(); resolve(value as T); },
        reject: error => { cleanup(); reject(error); }
      };
      const abort = () => {
        const index = state.queue.indexOf(item);
        if (index >= 0) state.queue.splice(index, 1);
        item.reject(new Error('Jupiter request aborted'));
      };
      signal?.addEventListener('abort', abort, {once:true});
      state.queue.push(item);
      state.queue.sort((a, b) =>
        a.priority === b.priority
          ? a.sequence - b.sequence
          : a.priority - b.priority
      );
      void this.drain(state);
    });
  }

  private getBuckets(scope?: string): Record<JupiterTrafficBucket, BucketState> {
    if (!scope) return this.buckets;
    let buckets = this.organizationBuckets.get(scope);
    if (!buckets) {
      buckets = { general: this.makeBucket(this.buckets.general.intervalMs), execute: this.makeBucket(this.buckets.execute.intervalMs) };
      this.organizationBuckets.set(scope, buckets);
    }
    return buckets;
  }

  private async drain(state: BucketState): Promise<void> {
    if (state.running) return;
    state.running = true;

    try {
      while (state.queue.length > 0) {
        const elapsed = this.now() - state.lastStartedAt;
        const waitMs = Math.max(0, state.intervalMs - elapsed, state.blockedUntil - this.now());
        if (waitMs > 0) {
          state.totalWaitMs += waitMs;
          await this.sleep(waitMs);
        }
        // Select after waiting so a protective exit can overtake queued research.
        const next = state.queue.shift();
        if (!next) continue;
        state.lastStartedAt = this.now();
        try {
          const value = await next.op();
          state.completed++;
          next.resolve(value);
        } catch (error: any) {
          state.failed++;
          const status = Number(error?.status ?? error?.response?.status ?? 0);
          if (status === 429) {
            state.rateLimited++;
            const retryAfter = error?.response?.headers?.['retry-after'];
            const seconds = Number(retryAfter);
            const dateDelay = Date.parse(String(retryAfter)) - this.now();
            const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000
              : Number.isFinite(dateDelay) && dateDelay > 0 ? dateDelay : 1200;
            state.blockedUntil = Math.max(state.blockedUntil, this.now() + Math.min(delay, 60_000));
          }
          next.reject(error);
        }
      }
    } finally {
      state.running = false;
      if (state.queue.length > 0) void this.drain(state);
    }
  }

  snapshot(): JupiterTrafficSnapshot {
    const map = (state: BucketState): JupiterTrafficBucketSnapshot => ({
      queued: state.queue.length,
      running: state.running ? 1 : 0,
      completed: state.completed,
      failed: state.failed,
      rateLimited: state.rateLimited,
      totalWaitMs: state.totalWaitMs
    });
    const aggregate = (bucket: JupiterTrafficBucket): JupiterTrafficBucketSnapshot => {
      const states = [this.buckets, ...this.organizationBuckets.values()].map(b => map(b[bucket]));
      return states.reduce((sum, state) => ({
        queued: sum.queued + state.queued, running: sum.running + state.running,
        completed: sum.completed + state.completed, failed: sum.failed + state.failed,
        rateLimited: sum.rateLimited + state.rateLimited, totalWaitMs: sum.totalWaitMs + state.totalWaitMs
      }));
    };
    return {general: aggregate('general'), execute: aggregate('execute')};
  }
}

let globalCoordinator: JupiterTrafficCoordinator | undefined;

export function getGlobalJupiterTrafficCoordinator(): JupiterTrafficCoordinator {
  if (!globalCoordinator) {
    const hasApiKey = Boolean(process.env.JUPITER_API_KEY || process.env.JUPITER_API_KEYS?.split(',').some(key => key.trim()));
    const generalIntervalMs = Number(
      process.env.JUPITER_RATE_LIMIT_MS || (hasApiKey ? 1050 : 2100)
    );
    const executeRps = Math.max(1, Number(process.env.JUPITER_EXECUTE_RPS || 50));
    globalCoordinator = new JupiterTrafficCoordinator({
      generalIntervalMs,
      executeIntervalMs: Math.ceil(1000 / executeRps)
    });
  }
  return globalCoordinator;
}
