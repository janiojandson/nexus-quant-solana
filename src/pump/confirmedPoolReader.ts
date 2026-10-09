import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { HeliusRpcHub } from '../hubs/heliusRpcHub.js';
import { PUMP_PROGRAM_ID } from './pumpBondingCurve.js';

export const PUMP_SWAP_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const RAYDIUM_CPMM_PROGRAM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const PUMP_DISC = Buffer.from([241,154,109,4,17,177,109,188]);
const PUMP_GLOBAL_DISC = Buffer.from([149,8,156,202,160,252,176,217]);
const PUMP_GLOBAL_CONFIG = PublicKey.findProgramAddressSync([Buffer.from('global_config')], PUMP_SWAP_PROGRAM)[0];
const CPMM_DISC = createHash('sha256').update('account:PoolState').digest().subarray(0,8);
export interface ConfirmedPoolEvidence {
  kind: 'PHYSICAL_POOL_CONFIRMED'; venue: 'PumpSwap' | 'Raydium CPMM';
  slot: number; observedAt: string; programId: string; poolAddress: string;
  baseMint: string; quoteMint: string; baseVault: string; quoteVault: string;
  physicalSolLamports: string; tokenReserveAtomic: string;
  /** Observation is not creation; unknown age must remain unknown. */
  poolCreatedAt: null;
}
export type PoolReadResult = {ok:true; evidence:ConfirmedPoolEvidence} | {ok:false; code:string};
export interface PoolEvidenceReader { read(mint:string,poolHints?:readonly string[]):Promise<PoolReadResult> }
type Account = {owner:string; data:[string,string]; executable:boolean; lamports:number};
type Layout = {venue:ConfirmedPoolEvidence['venue']; program:PublicKey; mints:PublicKey[]; vaults:PublicKey[]; authority:PublicKey; fees:bigint[]};
const demand = (condition:unknown,code:string):void => {if(!condition)throw new Error(code);};
const pk = (b:Buffer,n:number) => new PublicKey(b.subarray(n,n+32));
function bytes(account:Account):Buffer {
  demand(account && account.executable === false && Array.isArray(account.data) && account.data[1]==='base64','INVALID_ACCOUNT');
  return Buffer.from(account.data[0],'base64');
}

/** Strict supported layouts from pump-public-docs/idl/pump_amm.json and
 * raydium-cp-swap/states/pool.rs. Other AMM programs and Token-2022 fail closed. */
export class ConfirmedPoolReader implements PoolEvidenceReader {
  private readonly minimum:bigint;
  private readonly now:()=>number;
  constructor(private readonly hub:Pick<HeliusRpcHub,'call'>, options:{minPoolReserveSol?:string; now?:()=>number}={}) {
    const raw = options.minPoolReserveSol ?? process.env.MIN_POOL_RESERVE_SOL;
    const value = raw ? Number(raw) : 20;
    if(!Number.isFinite(value) || value<=0 || !Number.isSafeInteger(Math.ceil(value*1e9)))throw new Error('INVALID_MIN_POOL_RESERVE_SOL');
    this.minimum=BigInt(Math.ceil(value*1e9)); this.now=options.now??Date.now;
  }
  async read(mint:string,poolHints:readonly string[]=[]):Promise<PoolReadResult> {
    const started=this.now();
    try {
      const token=new PublicKey(mint); demand(!token.equals(WSOL),'INVALID_MINT');
      const creator=PublicKey.findProgramAddressSync([Buffer.from('pool-authority'),token.toBuffer()],PUMP_PROGRAM_ID)[0];
      const canonical=PublicKey.findProgramAddressSync([Buffer.from('pool'),Buffer.alloc(2),creator.toBuffer(),token.toBuffer(),WSOL.toBuffer()],PUMP_SWAP_PROGRAM)[0];
      const addresses=[...new Set([canonical.toBase58(),...poolHints.slice(0,4)])].map(a=>new PublicKey(a));
      const tip=await this.rpc('getSlot',[{commitment:'confirmed'}]);
      demand(Number.isSafeInteger(tip)&&tip>0,'INVALID_CONTEXT_SLOT');
      const initial=await this.accounts(addresses,tip);
      let failure='POOL_NOT_FOUND';
      for(let i=0;i<addresses.length;i++) {
        if(!initial.value[i])continue;
        try {
          const first=this.layout(addresses[i],initial.value[i],token);
          // Re-read the pool with both vaults in one bank snapshot. Never join reserves from unrelated slots.
          const snapshot=await this.accounts([addresses[i],...first.vaults,...(first.venue==='PumpSwap'?[PUMP_GLOBAL_CONFIG]:[])],initial.context.slot);
          demand(snapshot.value.every(Boolean),'POOL_ACCOUNT_MISSING');
          const layout=this.layout(addresses[i],snapshot.value[0],token);
          demand(layout.vaults.every((v,j)=>v.equals(first.vaults[j])),'POOL_CHANGED_RETRY');
          if(layout.venue==='PumpSwap')this.pumpGlobalConfig(snapshot.value[3]);
          const amounts=layout.vaults.map((_,j)=>this.vault(snapshot.value[j+1],layout.mints[j],layout.authority)-layout.fees[j]);
          demand(amounts.every(a=>a>0n),'INVALID_RESERVES');
          const solIndex=layout.mints.findIndex(m=>m.equals(WSOL));
          demand(amounts[solIndex]>=this.minimum,'INSUFFICIENT_PHYSICAL_SOL');
          demand(this.now()-started<=15_000,'STALE_POOL_PROOF');
          return {ok:true,evidence:{kind:'PHYSICAL_POOL_CONFIRMED',venue:layout.venue,slot:snapshot.context.slot,
            observedAt:new Date(this.now()).toISOString(),programId:layout.program.toBase58(),poolAddress:addresses[i].toBase58(),
            baseMint:layout.mints[0].toBase58(),quoteMint:layout.mints[1].toBase58(),baseVault:layout.vaults[0].toBase58(),quoteVault:layout.vaults[1].toBase58(),
            physicalSolLamports:amounts[solIndex].toString(),tokenReserveAtomic:amounts[1-solIndex].toString(),poolCreatedAt:null}};
        } catch(error) {failure=this.code(error);}
      }
      return {ok:false,code:failure};
    } catch(error) {return {ok:false,code:this.code(error)};}
  }
  private code(error:unknown):string {
    const code=error instanceof Error?error.message:'';
    return /^[A-Z][A-Z_]+$/.test(code)?code:'INVALID_POOL_DATA';
  }
  private async rpc(method:string,params:unknown[]):Promise<any> {
    try{return await this.hub.call('STATE',method,params,{bypassCache:true});}
    catch{throw new Error('RPC_UNAVAILABLE');}
  }
  private async accounts(addresses:PublicKey[],minContextSlot:number):Promise<{context:{slot:number};value:Account[]}> {
    const result=await this.rpc('getMultipleAccounts',[addresses.map(a=>a.toBase58()),{encoding:'base64',commitment:'confirmed',minContextSlot}]);
    demand(Number.isSafeInteger(result?.context?.slot)&&result.context.slot>=minContextSlot,'STALE_CONTEXT_SLOT');
    demand(Array.isArray(result.value)&&result.value.length===addresses.length,'INVALID_RPC_RESPONSE');
    return result;
  }
  private layout(address:PublicKey,account:Account,token:PublicKey):Layout {
    const b=bytes(account);
    if(account.owner===PUMP_SWAP_PROGRAM.toBase58()) {
      // Exact historical field boundaries or current allocation with zero reserved bytes.
      demand([211,243,244,245,261,269,270,271,279,287,300].includes(b.length)&&b.subarray(0,8).equals(PUMP_DISC),'INVALID_POOL_LAYOUT');
      if(b.length>287)demand(b.subarray(287).every(v=>v===0),'UNSUPPORTED_POOL_LAYOUT');
      demand((b[243]??0)===0 && (b[244]??0)===0 && (b[269]??0)===0 && (b[270]??0)===0,'UNSUPPORTED_POOL_MODE');
      const mints=[pk(b,43),pk(b,75)];
      demand(mints[0].equals(token)&&mints[1].equals(WSOL),'POOL_MINT_MISMATCH');
      const [derived,bump]=PublicKey.findProgramAddressSync([Buffer.from('pool'),b.subarray(9,11),pk(b,11).toBuffer(),...mints.map(m=>m.toBuffer())],PUMP_SWAP_PROGRAM);
      demand(derived.equals(address)&&bump===b[8],'INVALID_POOL_PDA');
      const vaults=[pk(b,139),pk(b,171)];
      demand(vaults.every((v,i)=>v.equals(getAssociatedTokenAddressSync(mints[i],address,true))),'INVALID_VAULT_PDA');
      demand(b.readBigUInt64LE(203)>0n,'INVALID_LP_SUPPLY');
      // Virtual quote reserves are intentionally never added. Accrued fees are unavailable liquidity.
      const fees=(b.length>=279?b.readBigUInt64LE(271):0n)+(b.length>=287?b.readBigUInt64LE(279):0n);
      return {venue:'PumpSwap',program:PUMP_SWAP_PROGRAM,mints,vaults,authority:address,fees:[0n,fees]};
    }
    if(account.owner===RAYDIUM_CPMM_PROGRAM.toBase58()) {
      demand(b.length===637&&b.subarray(0,8).equals(CPMM_DISC),'INVALID_POOL_LAYOUT');
      const mints=[pk(b,168),pk(b,200)];
      demand(mints.some(m=>m.equals(token))&&mints.some(m=>m.equals(WSOL)),'POOL_MINT_MISMATCH');
      demand(Buffer.compare(mints[0].toBuffer(),mints[1].toBuffer())<0,'INVALID_MINT_ORDER');
      demand(pk(b,232).equals(TOKEN_PROGRAM_ID)&&pk(b,264).equals(TOKEN_PROGRAM_ID),'UNSUPPORTED_TOKEN_PROGRAM');
      const derived=PublicKey.findProgramAddressSync([Buffer.from('pool'),pk(b,8).toBuffer(),...mints.map(m=>m.toBuffer())],RAYDIUM_CPMM_PROGRAM)[0];
      demand(derived.equals(address),'INVALID_POOL_PDA');
      const [authority,bump]=PublicKey.findProgramAddressSync([Buffer.from('vault_and_lp_mint_auth_seed')],RAYDIUM_CPMM_PROGRAM);
      demand(bump===b[328],'INVALID_AUTHORITY_BUMP');
      demand(b[329]<=7&&(b[329]&4)===0&&b.readBigUInt64LE(373)<BigInt(Math.floor(this.now()/1000)),'POOL_NOT_OPEN');
      demand(b[389]<=2&&b[390]<=1&&b.subarray(391,397).every(v=>v===0)&&b.subarray(413).every(v=>v===0),'UNSUPPORTED_POOL_LAYOUT');
      demand(b.readBigUInt64LE(333)>0n,'INVALID_LP_SUPPLY');
      const solIndex=mints.findIndex(m=>m.equals(WSOL)); demand(b[331+solIndex]===9,'INVALID_SOL_DECIMALS');
      const vaults=[pk(b,72),pk(b,104)];
      demand(vaults.every((v,i)=>v.equals(PublicKey.findProgramAddressSync([Buffer.from('pool_vault'),address.toBuffer(),mints[i].toBuffer()],RAYDIUM_CPMM_PROGRAM)[0])),'INVALID_VAULT_PDA');
      const fees=[0,1].map(i=>b.readBigUInt64LE(341+i*8)+b.readBigUInt64LE(357+i*8)+b.readBigUInt64LE(397+i*8));
      return {venue:'Raydium CPMM',program:RAYDIUM_CPMM_PROGRAM,mints,vaults,authority,fees};
    }
    throw new Error('UNSUPPORTED_POOL_PROGRAM');
  }
  private pumpGlobalConfig(account:Account):void {
    demand(account.owner===PUMP_SWAP_PROGRAM.toBase58(),'INVALID_GLOBAL_CONFIG_OWNER');
    const b=bytes(account);
    // Anchor discriminator + current GlobalConfig fixed Borsh fields (949 bytes).
    demand(b.length===949&&b.subarray(0,8).equals(PUMP_GLOBAL_DISC),'INVALID_GLOBAL_CONFIG_LAYOUT');
    demand((b[56]&0b00011000)===0,'POOL_PAUSED');
  }
  private vault(account:Account,mint:PublicKey,authority:PublicKey):bigint {
    demand(account.owner===TOKEN_PROGRAM_ID.toBase58(),'UNSUPPORTED_TOKEN_PROGRAM');
    const b=bytes(account);
    demand(b.length===165&&b[108]===1&&pk(b,0).equals(mint)&&pk(b,32).equals(authority),'INVALID_VAULT');
    demand(b.readUInt32LE(72)===0&&b.readUInt32LE(129)===0,'INVALID_VAULT_AUTHORITY');
    const amount=b.readBigUInt64LE(64);
    if(mint.equals(WSOL)) {
      demand(b.readUInt32LE(109)===1&&Number.isSafeInteger(account.lamports),'INVALID_NATIVE_VAULT');
      demand(BigInt(account.lamports)>=amount+b.readBigUInt64LE(113),'UNBACKED_NATIVE_RESERVE');
    } else demand(b.readUInt32LE(109)===0,'INVALID_TOKEN_VAULT');
    return amount;
  }
}
