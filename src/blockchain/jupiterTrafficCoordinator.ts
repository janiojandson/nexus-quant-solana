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
      queue: []
    };
  }

  schedule<T>(
    priority: JupiterPriority,
    op: () => Promise<T>,
    bucket: JupiterTrafficBucket = 'general',
    signal?: AbortSignal
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const state = this.buckets[bucket];
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
      void this.drain(bucket);
    });
  }

  private async drain(bucket: JupiterTrafficBucket): Promise<void> {
    const state = this.buckets[bucket];
    if (state.running) return;
    state.running = true;

    try {
      while (state.queue.length > 0) {
        const next = state.queue.shift()!;
        const elapsed = this.now() - state.lastStartedAt;
        const waitMs = Math.max(0, state.intervalMs - elapsed);
        if (waitMs > 0) {
          state.totalWaitMs += waitMs;
          await this.sleep(waitMs);
        }

        state.lastStartedAt = this.now();
        try {
          const value = await next.op();
          state.completed++;
          next.resolve(value);
        } catch (error: any) {
          state.failed++;
          const status = Number(error?.status ?? error?.response?.status ?? 0);
          if (status === 429) state.rateLimited++;
          next.reject(error);
        }
      }
    } finally {
      state.running = false;
      if (state.queue.length > 0) void this.drain(bucket);
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
    return {
      general: map(this.buckets.general),
      execute: map(this.buckets.execute)
    };
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
