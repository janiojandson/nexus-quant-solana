import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContractGates, presentRejectionEvidence } from './contractGates.js';
import { MemeRiskGatekeeper } from '../risk/memeRiskGatekeeper.js';
test('veto facts reach the journal: actual 98.7 percent fails the real 35 percent threshold', async()=>{
 const report={mint:'mint',score:0,risks:['Top holders'],isRugged:false,isSafe:false,verified:false,
 mintAuthority:null,freezeAuthority:null,topHoldersPct:98.7,lpLockedPct:0,holdersCount:200,factsComplete:true};
 const engine=new MemeRiskGatekeeper({rugCheckService:{auditToken:async()=>report} as any});

 const audit=await engine.auditToken({mint:'mint',liquidityUsd:20000,priceChangeM5:10});
 assert.equal(audit.score,0);assert.equal(audit.safe,false);
 const gate=buildContractGates(audit).find(g=>g.gate==='TOP_HOLDERS')!;
 assert.equal(gate.result,'FAIL');assert.equal(gate.value,98.7);assert.equal(gate.threshold,35);
});
test('unavailable facts are warnings without invented numeric values',()=>{
 const gates=buildContractGates({safe:false,score:0,validatedBy:'LOCAL_HEURISTICS_FALLBACK'});
 assert.ok(gates.every(g=>g.result==='WARN' && g.value===undefined));
});
test('historical placeholders are masked without changing the stored evidence',()=>{
 const original={gate_evidence_version:null,gate_details:[
 {gate:'MATURITY_AGE',result:'PASS',value:5},
 {gate:'TOP_HOLDERS',result:'PASS',value:20},
 {gate:'RUG_CHECK',result:'FAIL',detail:'provider veto'}]};
 const view=presentRejectionEvidence(original);
 assert.equal(view.first_gate,'RUG_CHECK');
 assert.equal(view.gate_details[1].result,'WARN');assert.equal(view.gate_details[1].value,undefined);
 assert.equal(original.gate_details[1].value,20);
 const measured=presentRejectionEvidence({gate_evidence_version:'2',gate_details:[{gate:'TOP_HOLDERS',result:'PASS',value:12,threshold:35}]});
 assert.equal(measured.gate_details[0].value,12);
});
