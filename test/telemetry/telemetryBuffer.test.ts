import test from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryRingBuffer } from '../../src/telemetry/telemetryBuffer';
import { TelemetrySpan, nowWallMs } from '../../src/types/telemetry';

test('TelemetryBuffer: deve armazenar spans até a capacidade configurada', () => {
  const buffer = new TelemetryRingBuffer({ capacity: 3 });
  assert.equal(buffer.size(), 0);
  assert.equal(buffer.getCapacity(), 3);

  const span1: TelemetrySpan = {
    id: 'span-1',
    traceId: 'trace-1',
    spanName: 'order_latency',
    durationMs: 120,
    status: 'SUCCESS',
    createdAtWallMs: nowWallMs()
  };
  const span2: TelemetrySpan = { ...span1, id: 'span-2' };
  const span3: TelemetrySpan = { ...span1, id: 'span-3' };

  assert.equal(buffer.push(span1), true);
  assert.equal(buffer.push(span2), true);
  assert.equal(buffer.push(span3), true);
  assert.equal(buffer.size(), 3);
  assert.equal(buffer.getDroppedCount(), 0);
});

test('TelemetryBuffer: deve aplicar DROP_OLDEST e contabilizar drops ao saturar', () => {
  const buffer = new TelemetryRingBuffer({ capacity: 2 });
  const span1: TelemetrySpan = {
    id: 'span-1',
    traceId: 'trace-1',
    spanName: 'rpc_call',
    durationMs: 40,
    status: 'SUCCESS',
    createdAtWallMs: nowWallMs()
  };
  const span2: TelemetrySpan = { ...span1, id: 'span-2' };
  const span3: TelemetrySpan = { ...span1, id: 'span-3' };
  const span4: TelemetrySpan = { ...span1, id: 'span-4' };

  buffer.push(span1);
  buffer.push(span2);
  assert.equal(buffer.size(), 2);
  assert.equal(buffer.getDroppedCount(), 0);

  // Exceder capacidade: deve dropar span1
  buffer.push(span3);
  assert.equal(buffer.size(), 2);
  assert.equal(buffer.getDroppedCount(), 1);

  // Exceder novamente: deve dropar span2
  buffer.push(span4);
  assert.equal(buffer.size(), 2);
  assert.equal(buffer.getDroppedCount(), 2);

  const flushed = buffer.flush();
  assert.equal(flushed.length, 2);
  assert.equal(flushed[0].id, 'span-3');
  assert.equal(flushed[1].id, 'span-4');
  assert.equal(buffer.size(), 0);
});

test('TelemetryBuffer: deve sanitizar spans automaticamente na inserção', () => {
  const buffer = new TelemetryRingBuffer({ capacity: 5 });
  const spanWithSecret: TelemetrySpan = {
    id: 'span-secret',
    traceId: 'trace-s',
    spanName: 'http_request',
    durationMs: 50,
    status: 'SUCCESS',
    createdAtWallMs: nowWallMs(),
    metadata: {
      apiKey: 'secret_key_value_123',
      endpoint: 'https://rpc.helius.xyz/?api-key=secret123'
    }
  };

  buffer.push(spanWithSecret);
  const flushed = buffer.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].metadata?.apiKey, '[REDACTED_SECRET]');
  assert.equal((flushed[0].metadata?.endpoint as string).includes('secret123'), false);
});

test('TelemetryBuffer: nenhuma exceção deve escapar ao chamador', () => {
  const buffer = new TelemetryRingBuffer({ capacity: 2 });
  
  // Passagem de inputs malformados ou nulos
  assert.doesNotThrow(() => {
    // @ts-expect-error testando tolerância a falhas em runtime
    buffer.push(null);
    // @ts-expect-error testando tolerância a falhas em runtime
    buffer.push(undefined);
    // @ts-expect-error testando tolerância a falhas em runtime
    buffer.push('invalid-string');
  });

  assert.equal(buffer.size(), 0);
});
