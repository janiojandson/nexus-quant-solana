/**
 * Nexus Quant Solana — V2.0 Telemetry Buffer
 * Non-blocking, bounded ring-buffer with DROP_OLDEST policy for non-critical telemetry spans.
 *
 * CRITICAL RULE:
 * This buffer is STRICTLY for non-critical TelemetrySpan objects.
 * Financial Journal items (ExitIntent, ExecutionAttempt, FillRecord) MUST NEVER
 * be routed to this buffer or subjected to DROP_OLDEST.
 */

import { TelemetrySpan } from '../types/telemetry';
import { sanitizeTelemetry } from './redaction';

export interface TelemetryBufferOptions {
  capacity?: number;
}

export class TelemetryRingBuffer {
  private readonly capacity: number;
  private buffer: TelemetrySpan[];
  private droppedCount: number = 0;

  constructor(options: TelemetryBufferOptions = {}) {
    this.capacity = options.capacity && options.capacity > 0 ? options.capacity : 5000;
    this.buffer = [];
  }

  /**
   * Pushes a new telemetry span into the ring buffer.
   * If capacity is reached, drops the oldest span (FIFO) and increments droppedCount.
   * Wrapped in try/catch: guarantees zero exceptions escape to the caller.
   */
  public push(span: TelemetrySpan): boolean {
    try {
      if (!span || typeof span !== 'object' || !span.spanName) {
        return false;
      }

      const sanitized = sanitizeTelemetry(span);

      if (this.buffer.length >= this.capacity) {
        // DROP_OLDEST policy: remove the oldest item to make space
        this.buffer.shift();
        this.droppedCount++;
      }

      this.buffer.push(sanitized);
      return true;
    } catch {
      // Non-blocking & fault-tolerant: never allow telemetry to crash business logic
      return false;
    }
  }

  /**
   * Returns the current number of spans in the buffer.
   */
  public size(): number {
    return this.buffer.length;
  }

  /**
   * Returns the maximum capacity of the buffer.
   */
  public getCapacity(): number {
    return this.capacity;
  }

  /**
   * Returns the total count of spans dropped due to buffer saturation.
   */
  public getDroppedCount(): number {
    return this.droppedCount;
  }

  /**
   * Resets the drop counter (useful for testing or after telemetry health reports).
   */
  public resetDroppedCount(): void {
    this.droppedCount = 0;
  }

  /**
   * Drains and returns all spans currently in the buffer, resetting it.
   */
  public flush(): TelemetrySpan[] {
    try {
      const items = this.buffer;
      this.buffer = [];
      return items;
    } catch {
      this.buffer = [];
      return [];
    }
  }

  /**
   * Clears the buffer and resets dropped count.
   */
  public clear(): void {
    this.buffer = [];
    this.droppedCount = 0;
  }
}

// Global default singleton for process-wide non-critical spans
export const globalTelemetryBuffer = new TelemetryRingBuffer({ capacity: 5000 });
