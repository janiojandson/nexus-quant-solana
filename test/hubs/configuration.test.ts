import {test} from 'node:test';
import assert from 'node:assert/strict';
const credentials=Array.from({length:6},(_,i)=>({id:`k${i}`,apiKeyEnv:`HELIUS_KEY_${i+1}`,quotaGroupId:'UNKNOWN_SHARED',role:i===0?'CRITICAL':'STATE',owner:i<3?'QUANT':'SENTINEL'}));
test('configuration validates six disjoint Helius keys and combined process budgets without assuming project independence',async()=>{
  const {loadHeliusConfiguration}=await import('../../src/hubs/hubConfiguration.js');
  const env={...Object.fromEntries(credentials.map((c,i)=>[c.apiKeyEnv,`secret${i}`])),HELIUS_CREDENTIALS:JSON.stringify(credentials),HELIUS_QUOTA_GROUPS:JSON.stringify([{id:'UNKNOWN_SHARED',quantRps:6,sentinelRps:3}])};
  const q=loadHeliusConfiguration(env,'QUANT'),s=loadHeliusConfiguration(env,'SENTINEL');
  assert.equal(q.keys.length,3); assert.equal(s.keys.length,3); assert.equal(q.groups[0].rps,6); assert.equal(s.groups[0].rps,3);
  assert.deepEqual(s.allowedRoles,['STATE']); assert.ok(s.keys.every(k=>k.role==='STATE'));
  assert.throws(()=>loadHeliusConfiguration({...env,HELIUS_QUOTA_GROUPS:JSON.stringify([{id:'UNKNOWN_SHARED',quantRps:10,sentinelRps:10}])},'QUANT'),/configuration/);
  assert.throws(()=>loadHeliusConfiguration({...env,HELIUS_CREDENTIALS:JSON.stringify(credentials.slice(1))},'QUANT'),/configuration/);
  assert.throws(()=>loadHeliusConfiguration({...env,HELIUS_CREDENTIALS:'secret invalid json'},'QUANT'),e=>!String(e).includes('secret'));
});
