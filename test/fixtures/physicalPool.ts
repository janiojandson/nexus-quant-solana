import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
const pump = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const curve = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const cpmm = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const sol = new PublicKey('So11111111111111111111111111111111111111112');
export const fixtureMint = new PublicKey(Buffer.alloc(32, 5));
const globalConfig = PublicKey.findProgramAddressSync([Buffer.from('global_config')], pump)[0];
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const put = (b: Buffer, offset: number, value: PublicKey) => value.toBuffer().copy(b, offset);
export function physicalPoolFixture(venue: 'pump' | 'cpmm' = 'pump', reserve = 20_000_000_000n) {
  const program = venue === 'pump' ? pump : cpmm;
  const creator = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), fixtureMint.toBuffer()], curve)[0];
  const [address, bump] = PublicKey.findProgramAddressSync(venue === 'pump'
    ? [Buffer.from('pool'), Buffer.alloc(2), creator.toBuffer(), fixtureMint.toBuffer(), sol.toBuffer()]
    : [Buffer.from('pool'), key(9).toBuffer(), fixtureMint.toBuffer(), sol.toBuffer()], program);
  const [authority, authBump] = venue === 'pump' ? [address, bump] : PublicKey.findProgramAddressSync([Buffer.from('vault_and_lp_mint_auth_seed')], program);
  const vaults = venue === 'pump' ? [fixtureMint, sol].map(m => getAssociatedTokenAddressSync(m, address, true))
    : [fixtureMint, sol].map(m => PublicKey.findProgramAddressSync([Buffer.from('pool_vault'), address.toBuffer(), m.toBuffer()], program)[0]);
  const pool = Buffer.alloc(venue === 'pump' ? 287 : 637);
  const config = Buffer.alloc(949);
  Buffer.from([149,8,156,202,160,252,176,217]).copy(config);
  if (venue === 'pump') {
    Buffer.from([241,154,109,4,17,177,109,188]).copy(pool);
    pool[8] = bump; put(pool,11,creator); put(pool,43,fixtureMint); put(pool,75,sol);
    put(pool,139,vaults[0]); put(pool,171,vaults[1]); pool.writeBigUInt64LE(100n,203);
  } else {
    createHash('sha256').update('account:PoolState').digest().subarray(0,8).copy(pool);
    put(pool,8,key(9)); put(pool,72,vaults[0]); put(pool,104,vaults[1]);
    put(pool,168,fixtureMint); put(pool,200,sol); put(pool,232,TOKEN_PROGRAM_ID); put(pool,264,TOKEN_PROGRAM_ID);
    pool[328] = authBump; pool[331] = 6; pool[332] = 9; pool.writeBigUInt64LE(100n,333);
    pool.writeBigUInt64LE(1n,373);
  }
  const amounts = [5_000_000n, reserve];
  const vaultBuffers = [fixtureMint,sol].map((m,i) => {
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
  return {vaults,pool,config,vaultBuffers,accounts,address,refresh,calls,hub,setSlot:(s:number)=>{slot=s;}};
}
