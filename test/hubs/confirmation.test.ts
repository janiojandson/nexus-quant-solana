import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHubConnection} from '../../src/hubs/hubConnection.js';

const signature = 'signature-for-test';
type Status = {slot:number;confirmations:number | null;err:unknown;confirmationStatus:'processed'|'confirmed'|'finalized'};
function connectionFor(statuses: Status[]) {
  let reads = 0;
  const connection = createHubConnection({call:async (_work,method) => {
    assert.equal(method,'getSignatureStatuses');
    const status = statuses[Math.min(reads++,statuses.length-1)]!;
    return {context:{slot:status.slot},value:[status]};
  }}, {canBroadcast:()=>false});
  return {connection,reads:()=>reads};
}
const processedError: Status = {slot:1,confirmations:0,err:{InstructionError:[0,'Custom']},confirmationStatus:'processed'};

test('processed error remains pending until a confirmed error is observed',async()=>{
  const fixture=connectionFor([processedError,{...processedError,slot:2,confirmations:1,confirmationStatus:'confirmed'}]);
  const result=await fixture.connection.confirmTransaction(signature,'confirmed');
  assert.deepEqual(result.value.err,processedError.err);
  assert.equal(result.context.slot,2);
  assert.equal(fixture.reads(),2);
});
test('processed error can resolve as a confirmed success',async()=>{
  const fixture=connectionFor([processedError,{slot:2,confirmations:1,err:null,confirmationStatus:'confirmed'}]);
  const result=await fixture.connection.confirmTransaction(signature,'confirmed');
  assert.equal(result.value.err,null);
  assert.equal(result.context.slot,2);
  assert.equal(fixture.reads(),2);
});
test('explicit finalized commitment waits past confirmed status',async()=>{
  const fixture=connectionFor([
    {slot:1,confirmations:1,err:null,confirmationStatus:'confirmed'},
    {slot:2,confirmations:null,err:null,confirmationStatus:'finalized'},
  ]);
  const result=await fixture.connection.confirmTransaction(signature,'finalized');
  assert.equal(result.context.slot,2);
  assert.equal(fixture.reads(),2);
});
test('insufficiently committed error times out as uncertain',async()=>{
  const fixture=connectionFor([processedError]);
  const originalNow=Date.now;
  let now=originalNow();
  Date.now=()=>now;
  try {
    const pending=fixture.connection.confirmTransaction(signature,'confirmed');
    setTimeout(()=>{now+=31000;},50);
    await assert.rejects(pending,/unknown; reconcile/);
    assert.equal(fixture.reads(),1);
  } finally { Date.now=originalNow; }
});
