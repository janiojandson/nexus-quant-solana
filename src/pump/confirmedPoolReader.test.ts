import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { ConfirmedPoolReader } from './confirmedPoolReader.js';

const pump = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const curve = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const cpmm = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const sol = new PublicKey('So11111111111111111111111111111111111111112');
const mint = new PublicKey(Buffer.alloc(32, 5));
const globalConfig = PublicKey.findProgramAddressSync([Buffer.from('global_config')], pump)[0];
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const put = (b: Buffer, offset: number, value: PublicKey) => value.toBuffer().copy(b, offset);
function fixture(venue: 'pump' | 'cpmm' = 'pump', reserve = 20_000_000_000n) {
  const program = venue === 'pump' ? pump : cpmm;
  const creator = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), mint.toBuffer()], curve)[0];
  const [address, bump] = PublicKey.findProgramAddressSync(venue === 'pump'
    ? [Buffer.from('pool'), Buffer.alloc(2), creator.toBuffer(), mint.toBuffer(), sol.toBuffer()]
    : [Buffer.from('pool'), key(9).toBuffer(), mint.toBuffer(), sol.toBuffer()], program);
  const [authority, authBump] = venue === 'pump' ? [address, bump] : PublicKey.findProgramAddressSync([Buffer.from('vault_and_lp_mint_auth_seed')], program);
  const vaults = venue === 'pump' ? [mint, sol].map(m => getAssociatedTokenAddressSync(m, address, true))
    : [mint, sol].map(m => PublicKey.findProgramAddressSync([Buffer.from('pool_vault'), address.toBuffer(), m.toBuffer()], program)[0]);
  const pool = Buffer.alloc(venue === 'pump' ? 287 : 637);
  const config = Buffer.alloc(949);
  Buffer.from([149,8,156,202,160,252,176,217]).copy(config);
  if (venue === 'pump') {
    Buffer.from([241,154,109,4,17,177,109,188]).copy(pool);
    pool[8] = bump; put(pool,11,creator); put(pool,43,mint); put(pool,75,sol);
    put(pool,139,vaults[0]); put(pool,171,vaults[1]); pool.writeBigUInt64LE(100n,203);
  } else {
    createHash('sha256').update('account:PoolState').digest().subarray(0,8).copy(pool);
    put(pool,8,key(9)); put(pool,72,vaults[0]); put(pool,104,vaults[1]);
    put(pool,168,mint); put(pool,200,sol); put(pool,232,TOKEN_PROGRAM_ID); put(pool,264,TOKEN_PROGRAM_ID);
    pool[328] = authBump; pool[331] = 6; pool[332] = 9; pool.writeBigUInt64LE(100n,333);
    pool.writeBigUInt64LE(1n,373);
  }
  const amounts = [5_000_000n, reserve];
  const vaultBuffers = [mint,sol].map((m,i) => {
    const b = Buffer.alloc(165); put(b,0,m); put(b,32,authority); b.writeBigUInt64LE(amounts[i],64); b[108]=1;
    if(i===1){b.writeUInt32LE(1,109);b.writeBigUInt64LE(2_039_280n,113);}
    return b;
  });
  const accounts = new Map<string, any>();
  const account = (owner: PublicKey, data: Buffer, lamports: number) => ({owner:owner.toBase58(),data:[data.toString('base64'),'base64'],executable:false,lamports});
  const refresh = () => {
    accounts.set(address.toBase58(),account(program,pool,1_000_000));
    if(venue==='pump')accounts.set(globalConfig.toBase58(),account(pump,config,1_000_000));
    vaults.forEach((v,i)=>accounts.set(v.toBase58(),account(TOKEN_PROGRAM_ID,vaultBuffers[i],Number(amounts[i])+2_039_280)));
  };
  refresh();
  let slot = 100;
  const calls: any[] = [];
  const hub = {call:async (work:any,method:any,params:any,options:any)=>{
    calls.push({work,method,params,options});
    assert.equal(work,'STATE'); assert.equal(options.bypassCache,true);
    if(method==='getSlot')return 100;
    assert.equal(method,'getMultipleAccounts');
    return {context:{slot},value:params[0].map((a:string)=>accounts.get(a)??null)};
  }};
  return {pool,config,vaultBuffers,accounts,address,refresh,calls,hub,setSlot:(s:number)=>{slot=s;}};
}
for(const venue of ['pump','cpmm'] as const) {
  test(`${venue}: proves physical reserve at inclusive 20 SOL boundary with fresh coherent slots`, async()=>{
    const f=fixture(venue); const result=await new ConfirmedPoolReader(f.hub as any).read(mint.toBase58(),[f.address.toBase58()]);
    assert.equal(result.ok,true); if(!result.ok)return;
    assert.equal(result.evidence.physicalSolLamports,'20000000000');
    assert.equal(result.evidence.tokenReserveAtomic,'5000000');
    assert.equal(result.evidence.venue,venue==='pump'?'PumpSwap':'Raydium CPMM');
    assert.equal(result.evidence.slot,100); assert.equal(result.evidence.poolCreatedAt,null);
    assert.doesNotThrow(()=>JSON.stringify(result.evidence));
    assert.equal(f.calls.at(-1).params[1].minContextSlot,100);
  });
  test(`${venue}: below 20 SOL never confirms`,async()=>{
    const f=fixture(venue,19_999_999_999n);
    assert.deepEqual(await new ConfirmedPoolReader(f.hub as any).read(mint.toBase58(),[f.address.toBase58()]),{ok:false,code:'INSUFFICIENT_PHYSICAL_SOL'});
  });
  for(const kind of ['discriminator','length','mint','authority','vaultMint','frozen','owner'] as const) {
    test(`${venue}: rejects corrupt ${kind}`,async()=>{
      const f=fixture(venue);
      if(kind==='discriminator')f.pool[0]^=255;
      if(kind==='mint')put(f.pool,venue==='pump'?43:168,key(99));
      if(kind==='authority')put(f.vaultBuffers[0],32,key(99));
      if(kind==='vaultMint')put(f.vaultBuffers[1],0,key(99));
      if(kind==='frozen')f.vaultBuffers[0][108]=2;
      f.refresh();
      if(kind==='length')f.accounts.get(f.address.toBase58()).data=[Buffer.alloc(10).toString('base64'),'base64'];
      if(kind==='owner')f.accounts.get(f.address.toBase58()).owner=key(99).toBase58();
      assert.equal((await new ConfirmedPoolReader(f.hub as any).read(mint.toBase58(),[f.address.toBase58()])).ok,false);
    });
  }
}
test('canonical PumpSwap is resolved without hints; missing accounts and DAS prices cannot confirm',async()=>{
  const f=fixture(); assert.equal((await new ConfirmedPoolReader(f.hub as any).read(mint.toBase58())).ok,true);
  f.accounts.clear(); assert.equal((await new ConfirmedPoolReader(f.hub as any).read(mint.toBase58())).ok,false);
  const hub={call:async()=>({token_info:{price_info:{price_per_token:42}}})};
  assert.equal((await new ConfirmedPoolReader(hub as any).read(mint.toBase58())).ok,false);
});
test('CPMM rejects paused/future pools and subtracts all accrued fees',async()=>{
  for(const mutate of [(b:Buffer)=>{b[329]=4;},(b:Buffer)=>{b.writeBigUInt64LE(9_999_999_999n,373);},(b:Buffer)=>{b.writeBigUInt64LE(1n,349);},(b:Buffer)=>{b.writeBigUInt64LE(1n,365);},(b:Buffer)=>{b.writeBigUInt64LE(1n,405);}]) {
    const f=fixture('cpmm');mutate(f.pool);f.refresh();
    assert.equal((await new ConfirmedPoolReader(f.hub as any).read(mint.toBase58(),[f.address.toBase58()])).ok,false);
  }
});
test('PumpSwap ignores virtual credit and subtracts accrued quote fees',async()=>{
  const f=fixture('pump',19_000_000_000n);f.pool.writeBigUInt64LE(50_000_000_000n,245);f.refresh();
  assert.equal((await new ConfirmedPoolReader(f.hub as any).read(mint.toBase58())).ok,false);
  const g=fixture();g.pool.writeBigUInt64LE(1n,271);g.refresh();
  assert.equal((await new ConfirmedPoolReader(g.hub as any).read(mint.toBase58())).ok,false);
});
test('PumpSwap requires a fresh valid global config with buying and selling enabled',async()=>{
  const baseline=fixture('pump');
  assert.equal((await new ConfirmedPoolReader(baseline.hub as any).read(mint.toBase58())).ok,true);
  assert.ok(baseline.calls.at(-1).params[0].includes(globalConfig.toBase58()));
  for(const corrupt of ['missing','owner','discriminator','length','buyPaused','sellPaused'] as const){
    const f=fixture('pump');
    if(corrupt==='missing')f.accounts.delete(globalConfig.toBase58());
    if(corrupt==='owner')f.accounts.get(globalConfig.toBase58()).owner=key(99).toBase58();
    if(corrupt==='discriminator'){f.config[0]^=255;f.refresh();}
    if(corrupt==='length')f.accounts.get(globalConfig.toBase58()).data=[Buffer.alloc(56).toString('base64'),'base64'];
    if(corrupt==='buyPaused'){f.config[56]=8;f.refresh();}
    if(corrupt==='sellPaused'){f.config[56]=16;f.refresh();}
    assert.equal((await new ConfirmedPoolReader(f.hub as any).read(mint.toBase58())).ok,false,corrupt);
  }
});
test('stale slot or RPC error returns failure',async()=>{
  const f=fixture();f.setSlot(99);assert.equal((await new ConfirmedPoolReader(f.hub as any).read(mint.toBase58())).ok,false);
  const hub={call:async()=>{throw new Error('secret provider error');}};
  assert.deepEqual(await new ConfirmedPoolReader(hub as any).read(mint.toBase58()),{ok:false,code:'RPC_UNAVAILABLE'});
});
test('explicit invalid reserve config rejects; absence defaults to 20',()=>{
  for(const value of ['0','-1','NaN','Infinity','nope',' '])assert.throws(()=>new ConfirmedPoolReader({} as any,{minPoolReserveSol:value}),/MIN_POOL_RESERVE_SOL/);
  assert.doesNotThrow(()=>new ConfirmedPoolReader({} as any,{minPoolReserveSol:''}));
  const prior=process.env.MIN_POOL_RESERVE_SOL;
  try {
    process.env.MIN_POOL_RESERVE_SOL='';
    assert.doesNotThrow(()=>new ConfirmedPoolReader({} as any));
  } finally {
    if(prior===undefined)delete process.env.MIN_POOL_RESERVE_SOL;
    else process.env.MIN_POOL_RESERVE_SOL=prior;
  }
});
