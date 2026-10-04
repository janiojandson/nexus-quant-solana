import {
  nowMonotonicNs,
  diffMonotonicMs,
  nowWallMs,
  type MonotonicNs,
  type TelemetrySpan
} from '../types/telemetry.js';
import { globalTelemetryBuffer } from '../telemetry/telemetryBuffer.js';

export type JupiterPriority = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type JupiterTrafficBucket = 'general' | 'execute';

export interface JupiterTrafficCoordinatorOptions {
  generalIntervalMs?: number;
  executeIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ScheduleContext {
  traceId?: string;
  operationType?: string;
}

interface QueueItem<T> {
  priority: JupiterPriority;
  sequence: number;
  op: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  queueEnteredMonoNs: MonotonicNs;
  queueDepthAtEntry: number;
  traceId?: string;
  operationType?: string;
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
    context?: ScheduleContext
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const state = this.buckets[bucket];
      state.queue.push({
        priority,
        sequence: this.sequence++,
        op,
        resolve: resolve as (value: unknown) => void,
        reject,
        queueEnteredMonoNs: nowMonotonicNs(),
        queueDepthAtEntry: state.queue.length,
        traceId: context?.traceId,
        operationType: context?.operationType
      });
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
        const queueClaimedMonoNs = nowMonotonicNs();
        const queueDepthAtClaim = state.queue.length;
        const queueWaitMs = diffMonotonicMs(next.queueEnteredMonoNs, queueClaimedMonoNs);

        const elapsed = this.now() - state.lastStartedAt;
        const waitMs = Math.max(0, state.intervalMs - elapsed);
        if (waitMs > 0) {
          state.totalWaitMs += waitMs;
          await this.sleep(waitMs);
        }

        state.lastStartedAt = this.now();
        const rateLimitDelayAppliedMs = waitMs;

        try {
          const value = await next.op();
          state.completed++;
          const operationCompletedMonoNs = nowMonotonicNs();
          const coordinatorTotalMs = diffMonotonicMs(next.queueEnteredMonoNs, operationCompletedMonoNs);
          this.emitTelemetry(next, bucket, queueWaitMs, coordinatorTotalMs, queueDepthAtClaim, rateLimitDelayAppliedMs, 'SUCCESS');
          next.resolve(value);
        } catch (error: any) {
          state.failed++;
          const operationCompletedMonoNs = nowMonotonicNs();
          const coordinatorTotalMs = diffMonotonicMs(next.queueEnteredMonoNs, operationCompletedMonoNs);
          const status = Number(error?.status ?? error?.response?.status ?? 0);
          if (status === 429) state.rateLimited++;
          this.emitTelemetry(next, bucket, queueWaitMs, coordinatorTotalMs, queueDepthAtClaim, rateLimitDelayAppliedMs, 'ERROR', error);
          next.reject(error);
        }
      }
    } finally {
      state.running = false;
      if (state.queue.length > 0) void this.drain(bucket);
    }
  }

  private emitTelemetry(
    item: QueueItem<unknown>,
    bucket: JupiterTrafficBucket,
    queueWaitMs: number,
    coordinatorTotalMs: number,
    queueDepthAtClaim: number,
    rateLimitDelayAppliedMs: number,
    status: 'SUCCESS' | 'ERROR',
    error?: unknown
  ): void {
    try {
      const traceId = item.traceId || `coord_${bucket}_${item.sequence}`;
      const span: TelemetrySpan = {
        id: `span_queue_${item.sequence}_${Date.now()}`,
        traceId,
        spanName: 'jupiter_queue_wait',
        providerAlias: 'JUPITER',
        durationMs: queueWaitMs,
        status,
        createdAtWallMs: nowWallMs(),
        metadata: {
          bucket,
          priority: item.priority,
          operationType: item.operationType || (bucket === 'execute' ? 'execute' : 'quote_or_order'),
          queueDepthAtEntry: item.queueDepthAtEntry,
          queueDepthAtClaim,
          rateLimitDelayAppliedMs,
          coordinatorTotalMs,
          errorClass: error ? (error as any)?.name || 'Error' : undefined
        }
      };
      globalTelemetryBuffer.push(span);
    } catch {
      // Non-blocking: never allow telemetry to fail queue operations
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
    const hasApiKey = Boolean(process.env.JUPITER_API_KEY);
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
