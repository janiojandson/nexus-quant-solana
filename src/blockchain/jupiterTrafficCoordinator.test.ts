import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JupiterTrafficCoordinator
} from './jupiterTrafficCoordinator.js';

test('P1 exit preempts queued P6 research while preserving FIFO within priority', async () => {
  const coordinator = new JupiterTrafficCoordinator({
    generalIntervalMs: 0,
    executeIntervalMs: 0
  });

  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });

  const blocker = coordinator.schedule(6, async () => {
    order.push('blocker-start');
    await gate;
    order.push('blocker-end');
  }, 'general');

  await new Promise(resolve => setImmediate(resolve));

  const lowA = coordinator.schedule(6, async () => {
    order.push('low-a');
  }, 'general');
  const high = coordinator.schedule(1, async () => {
    order.push('stop');
  }, 'general');
  const lowB = coordinator.schedule(6, async () => {
    order.push('low-b');
  }, 'general');

  release();
  await Promise.all([blocker, lowA, high, lowB]);

  assert.deepEqual(order, [
    'blocker-start',
    'blocker-end',
    'stop',
    'low-a',
    'low-b'
  ]);
});

test('general and execute traffic have separate buckets and telemetry', async () => {
  const coordinator = new JupiterTrafficCoordinator({
    generalIntervalMs: 0,
    executeIntervalMs: 0
  });

  await Promise.all([
    coordinator.schedule(4, async () => 'order', 'general'),
    coordinator.schedule(1, async () => 'execute', 'execute')
  ]);

  const snapshot = coordinator.snapshot();
  assert.equal(snapshot.general.completed, 1);
  assert.equal(snapshot.execute.completed, 1);
  assert.equal(snapshot.general.running, 0);
  assert.equal(snapshot.execute.running, 0);
  assert.equal(snapshot.general.queued, 0);
  assert.equal(snapshot.execute.queued, 0);
});
test('aborting queued Jupiter work removes it and never starts its HTTP operation', async () => {
  const coordinator = new JupiterTrafficCoordinator({generalIntervalMs:0});
  let release!:()=>void, started=false;
  const blocker=coordinator.schedule(1,()=>new Promise<void>(resolve=>{release=resolve;}));
  const controller=new AbortController();
  const queued=coordinator.schedule(1,async()=>{started=true;},'general',controller.signal);
  const rejected=assert.rejects(queued,/aborted/);
  controller.abort(); await rejected;
  assert.equal(coordinator.snapshot().general.queued,0);
  release();await blocker;
  assert.equal(started,false);
});

test('independent organization lanes progress concurrently while one HTTP request is blocked', async () => {
  const coordinator = new JupiterTrafficCoordinator({generalIntervalMs:0});
  let release!:()=>void;
  const first=coordinator.schedule(6,()=>new Promise<void>(resolve=>{release=resolve;}),'general',undefined,'organization-A');
  let ran=false;
  const second=coordinator.schedule(1,async()=>{ran=true;},'general',undefined,'organization-B');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ran,true);
  release();await Promise.all([first,second]);
  assert.equal(coordinator.snapshot().general.completed,2);
});

test('organization cooldown does not delay another organization', async () => {
  let now=10000;
  const sleeps:number[]=[];
  const coordinator=new JupiterTrafficCoordinator({generalIntervalMs:0,now:()=>now,sleep:async ms=>{sleeps.push(ms);now+=ms;}});
  await assert.rejects(coordinator.schedule(4,async()=>{throw {response:{status:429,headers:{'retry-after':'2'}}};},'general',undefined,'organization-A'));
  await coordinator.schedule(1,async()=>{},'general',undefined,'organization-B');
  assert.deepEqual(sleeps,[]);
  await coordinator.schedule(1,async()=>{},'general',undefined,'organization-A');
  assert.deepEqual(sleeps,[2000]);
});
