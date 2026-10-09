import type { HeliusKey, HeliusQuotaGroup, RpcWork } from './heliusRpcHub.js';
import type { JupiterCredential, JupiterRole } from './jupiterOrgHub.js';
type Environment=Record<string,string|undefined>;
type Owner='QUANT'|'SENTINEL';
const invalid=()=>new Error('Invalid hub configuration: credentials, ownership and quota allocations are required');
const name=(v:unknown):v is string=>typeof v==='string' && v.trim()===v && v.length>0;
export function loadJupiterCredentials(env:Environment):JupiterCredential[]{
  const roles:JupiterRole[]=['PROTECTION','ENTRY','ENTRY','DISCOVERY'];
  const result=roles.map((role,i)=>({orgId:env[`JUPITER_ORG${i+1}_ID`] ?? '',apiKey:env[`JUPITER_ORG${i+1}_KEY`] ?? '',role}));
  if(result.some(c=>!name(c.orgId)||!name(c.apiKey)) || new Set(result.map(c=>c.orgId)).size!==4 || new Set(result.map(c=>c.apiKey)).size!==4) throw invalid();
  return result;
}
export function loadHeliusConfiguration(env:Environment,owner:Owner):{keys:HeliusKey[];groups:HeliusQuotaGroup[];allowedRoles:RpcWork[]}{
  try{
    const entries:unknown=JSON.parse(env.HELIUS_CREDENTIALS ?? '');
    const allocations:unknown=JSON.parse(env.HELIUS_QUOTA_GROUPS ?? '');
    if(!Array.isArray(entries)||entries.length!==6||!Array.isArray(allocations)||!allocations.length) throw invalid();
    const ids=new Set<string>(),refs=new Set<string>(),groups=new Map<string,{quantRps:number;sentinelRps:number}>();
    for(const group of allocations){
      if(!group||!name(group.id)||groups.has(group.id)||!Number.isInteger(group.quantRps)||!Number.isInteger(group.sentinelRps)||group.quantRps<0||group.sentinelRps<0||group.quantRps+group.sentinelRps>10||group.quantRps+group.sentinelRps===0) throw invalid();
      if(group.id==='UNKNOWN_SHARED' && (allocations.length!==1||group.quantRps!==6||group.sentinelRps!==3)) throw invalid();
      groups.set(group.id,group);
    }
    for(const entry of entries){
      if(!entry||!name(entry.id)||!name(entry.apiKeyEnv)||!/^HELIUS_[A-Z0-9_]+$/.test(entry.apiKeyEnv)||'apiKey' in entry||ids.has(entry.id)||refs.has(entry.apiKeyEnv)||!groups.has(entry.quotaGroupId)||!['QUANT','SENTINEL'].includes(entry.owner)||!['CRITICAL','STATE'].includes(entry.role)||entry.owner==='SENTINEL'&&entry.role!=='STATE') throw invalid();
      ids.add(entry.id);refs.add(entry.apiKeyEnv);
      const allocation=groups.get(entry.quotaGroupId)!;
      if((entry.owner==='QUANT'?allocation.quantRps:allocation.sentinelRps)<=0) throw invalid();
    }
    if(!entries.some(e=>e.owner==='QUANT'&&e.role==='CRITICAL')||!entries.some(e=>e.owner==='QUANT'&&e.role==='STATE')||!entries.some(e=>e.owner==='SENTINEL')) throw invalid();
    const secrets=new Set<string>();
    const keys:HeliusKey[]=entries.filter(e=>e.owner===owner).map(e=>{
      const apiKey=env[e.apiKeyEnv];
      if(!name(apiKey)||secrets.has(apiKey)) throw invalid();
      secrets.add(apiKey);const allocation=groups.get(e.quotaGroupId)!;
      return {id:e.id,apiKey,quotaGroupId:e.quotaGroupId,role:e.role,rps:owner==='QUANT'?allocation.quantRps:allocation.sentinelRps};
    });
    return {keys,groups:[...groups].filter(([id])=>keys.some(k=>k.quotaGroupId===id)).map(([id,g])=>({id,rps:owner==='QUANT'?g.quantRps:g.sentinelRps})),allowedRoles:owner==='QUANT'?['CRITICAL','STATE']:['STATE']};
  }catch{throw invalid();}
}
