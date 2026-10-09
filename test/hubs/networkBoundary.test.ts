import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JupiterOrgHub } from '../../src/hubs/jupiterOrgHub.js';
import { HeliusRpcHub } from '../../src/hubs/heliusRpcHub.js';

const runtime = { now: Date.now, sleep: async (ms: number) => { await new Promise(r => setTimeout(r, ms)); }, random: () => 0 };
const credentials = [
  { orgId: 'private-org1', apiKey: 'secret1', role: 'PROTECTION' as const },
  { orgId: 'private-org2', apiKey: 'secret2', role: 'ENTRY' as const },
  { orgId: 'private-org3', apiKey: 'secret3', role: 'ENTRY' as const },
  { orgId: 'private-org4', apiKey: 'secret4', role: 'DISCOVERY' as const },
];
test('HTTP auth and failures stay distinct from rate limiting; execute never retries uncertainty',async()=>{
 for(const [status,kind] of [[401,'auth'],[503,'http'],[429,'rate']] as const){
  let calls=0;const hub=new JupiterOrgHub(credentials,async()=>{calls++;return {status,headers:new Headers(),body:{error:'secret-url'}};},runtime);
  await assert.rejects(hub.request('ENTRY','/swap/v2/order'),(e:any)=>e.kind===kind&&e.status===status&&!e.message.includes('secret'));
  assert.equal(calls,1);
 }
 let calls=0;const hub=new JupiterOrgHub(credentials,async()=>{calls++;throw Error('secret');},runtime);
 await assert.rejects(hub.request('EXIT','/swap/v2/execute'),(e:any)=>e.kind==='uncertain');assert.equal(calls,1);
});
test('Jupiter distinguishes network failure from actual 429 and never exposes cause secrets', async () => {
  const hub = new JupiterOrgHub(credentials, async () => { throw new TypeError('https://secret.invalid/?api-key=secret1'); }, runtime);
  await assert.rejects(hub.request('ENTRY', '/swap/v2/order'), (error: any) => {
    assert.equal(error.kind, 'network'); assert.doesNotMatch(error.message, /429|secret/); return true;
  });
});
test('STATE-only hub rejects CRITICAL before transport, accepts STATE', async () => {
  const keys = [{id:'observer', apiKey:'state-secret', quotaGroupId:'shared', role:'STATE' as const, rps:3}];
  const calls: string[] = [];
  const hub = new HeliusRpcHub(keys, [{id:'shared',rps:3}], async (_key, method) => {
    calls.push(method); return {status:200, headers:new Headers(), body:{jsonrpc:'2.0', result:4}};
  }, runtime, {allowedRoles:['STATE']} as any);
  await assert.rejects(hub.call('CRITICAL', 'getLatestBlockhash', []), /role/);
  assert.equal(await hub.call('STATE', 'getBalance', []), 4);
  assert.deepEqual(calls, ['getBalance']);
});
test('plain-text monthly quota disables the whole group without retry', async () => {
  let calls=0;
  const hub = new HeliusRpcHub([
    {id:'c',apiKey:'c',quotaGroupId:'g',role:'CRITICAL',rps:5},
    {id:'s',apiKey:'s',quotaGroupId:'g',role:'STATE',rps:5},
  ], [{id:'g',rps:5}], async () => { calls++; return {status:429,headers:new Headers(),body:'Max usage reached api-key=secret'}; }, runtime);
  await assert.rejects(hub.call('STATE','getTokenSupply',[]), (e:any) => e.kind==='monthly');
  assert.equal(calls,1); assert.equal(hub.snapshot().groups.disabled,1);
});
