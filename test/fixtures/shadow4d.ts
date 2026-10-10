import { physicalPoolFixture } from './physicalPool.js';
import assert from 'node:assert/strict';
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PreFlightEngine } from '../../src/execution/preflightEngine.js';
import { ConfirmedPoolReader, PUMP_SWAP_PROGRAM, RAYDIUM_CPMM_PROGRAM } from '../../src/pump/confirmedPoolReader.js';
import { assembleV0AccountKeys, hasBoundSwapCpi, JUPITER_SWAP_PROGRAM } from '../../src/execution/entryRoutePolicy.js';

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const mint = key(5).toBase58();
const physical = physicalPoolFixture();
const pool = physical.address.toBase58();
export const fixtureTaker = key(7).toBase58();
const noHeaders = { get: () => null };
const evidence = { kind: 'PHYSICAL_POOL_CONFIRMED' as const, venue: 'PumpSwap' as const,
  slot: 123, observedAt: new Date().toISOString(), programId: PUMP_SWAP_PROGRAM.toBase58(), poolAddress: pool,
  baseMint: mint, quoteMint: 'So11111111111111111111111111111111111111112',
  baseVault: physical.vaults[0].toBase58(), quoteVault: physical.vaults[1].toBase58(),
  physicalSolLamports: '20000000000', tokenReserveAtomic: '1000000000', poolCreatedAt: null };
function unsignedOrder(options: {payer?: PublicKey; unusedPool?: boolean; wrongDiscriminator?: boolean;
  wrongAmount?: boolean; unrelatedInstruction?: boolean; withSetup?: boolean;
  setupMalice?: 'owner'|'destination'|'amount'|'cleanup'; expensiveCompute?: boolean} = {}) {
  const route = createHash('sha256').update('global:route').digest().subarray(0,8);
  const data = Buffer.concat([route,Buffer.alloc(24)]);
  const instruction = new TransactionInstruction({ programId: new PublicKey(JUPITER_SWAP_PROGRAM),
    keys: [{ pubkey: options.payer ?? new PublicKey(fixtureTaker), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(pool), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: PUMP_SWAP_PROGRAM, isSigner: false, isWritable: false }], data });
  const wallet = options.payer ?? new PublicKey(fixtureTaker);
  const wsol = new PublicKey('So11111111111111111111111111111111111111112');
  const wsolAta = getAssociatedTokenAddressSync(wsol,wallet,true);
  const targetAta = getAssociatedTokenAddressSync(new PublicKey(mint),wallet,true);
  const setup = options.withSetup ? [
    createAssociatedTokenAccountIdempotentInstruction(wallet,wsolAta,
      options.setupMalice === 'owner' ? key(24) : wallet,wsol),
    createAssociatedTokenAccountIdempotentInstruction(wallet,targetAta,wallet,new PublicKey(mint)),
    SystemProgram.transfer({fromPubkey:wallet,
      toPubkey:options.setupMalice === 'destination' ? key(25) : wsolAta,
      lamports:options.setupMalice === 'amount' ? 25_000_001 : 25_000_000}),
    createSyncNativeInstruction(wsolAta)
  ] : [];
  const cleanup = options.withSetup ? [createCloseAccountInstruction(wsolAta,
    options.setupMalice === 'cleanup' ? key(26) : wallet,wallet)] : [];
  const instructions = options.unusedPool ? [
    new TransactionInstruction({ programId: key(12), keys: [{pubkey:new PublicKey(pool),isSigner:false,isWritable:false}], data:Buffer.alloc(0) }),
    new TransactionInstruction({ programId: new PublicKey(JUPITER_SWAP_PROGRAM),
      keys:[{pubkey:options.payer ?? new PublicKey(fixtureTaker),isSigner:true,isWritable:true},
        {pubkey:new PublicKey(mint),isSigner:false,isWritable:false},
        {pubkey:PUMP_SWAP_PROGRAM,isSigner:false,isWritable:false}], data })
  ] : options.unrelatedInstruction ? [instruction,
    new TransactionInstruction({ programId: key(12), keys:[], data:Buffer.alloc(8, 1) })] :
    [...(options.expensiveCompute ? [ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),
      ComputeBudgetProgram.setComputeUnitPrice({microLamports:1_000_000})] : []),
      ...setup,instruction,...cleanup];
  const message = new TransactionMessage({ payerKey: options.payer ?? new PublicKey(fixtureTaker),
    recentBlockhash: key(10).toBase58(), instructions }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}
export function shadow4dFixture(overrides: { mintOwner?: string; simulationError?: unknown; reverseMin?: string;
  forwardMin?: string; adverseReverseMin?: string; finalMin?: string; finalSlippageBps?: number;
  reverseNetworkFee?: number; finalNetworkFee?: number; missingFees?: boolean;
  wrongTaker?: boolean; unusedPool?: boolean; wrongDiscriminator?: boolean;
  wrongAmount?: boolean; unrelatedInstruction?: boolean; missingTrace?: boolean;
  staleSimulation?: boolean; refreshedPoolDrained?: boolean; refreshedPoolStale?: boolean;
  refreshedPoolChanged?: boolean; withSetup?: boolean;
  setupMalice?: 'owner'|'destination'|'amount'|'cleanup'; cpiWrongUserAta?: boolean;
  expensiveCompute?: boolean; finalRentFee?: number; lease?: () => Promise<void> } = {}) {
  const calls: string[] = [];
  const physical = physicalPoolFixture();
  const mintData = Buffer.alloc(82);
  mintData[44] = 6;
  const prices = ['1000000', '996016', '992063', '988142'];
  let forward = 0;
  const jupiter = { request: async (work: string, endpoint: string, payload: any, options: any) => {
    calls.push(`${work}:${endpoint}`);
    assert.equal(work, 'ENTRY'); assert.equal(endpoint, '/swap/v2/order');
    assert.ok(options.deadlineMs > Date.now());
    if (payload.inputMint === mint) return { status: 200, headers: noHeaders, body: {
      inAmount: payload.amount, outAmount: '24500000',
      otherAmountThreshold: payload.amount === overrides.forwardMin && overrides.adverseReverseMin
        ? overrides.adverseReverseMin : overrides.reverseMin ?? '24000000', feeBps: 0,
      slippageBps: 100, routePlan: [{ swapInfo: { ammKey: pool, inputMint: mint,
        outputMint: 'So11111111111111111111111111111111111111112', inAmount: payload.amount,
        outAmount: '24500000' } }],
      ...(!overrides.missingFees ? { signatureFeeLamports: overrides.reverseNetworkFee ?? 5000,
        signatureFeePayer: fixtureTaker, prioritizationFeeLamports: 0, prioritizationFeePayer: fixtureTaker,
        rentFeeLamports: 0, rentFeePayer: fixtureTaker } : {})
    } };
    if (payload.taker) return { status: 200, headers: noHeaders, body: {
      requestId: 'order-1', inAmount: '25000000', outAmount: '988142', otherAmountThreshold: overrides.finalMin ?? '988142',
      slippageBps: overrides.finalSlippageBps ?? 100, routePlan: [{ swapInfo: { ammKey: pool,
        programId: PUMP_SWAP_PROGRAM.toBase58(), inputMint: payload.inputMint,
        outputMint: payload.outputMint, inAmount: payload.amount, outAmount: '988142' } }],
      transaction: unsignedOrder({ payer: overrides.wrongTaker ? key(13) : undefined,
        unusedPool: overrides.unusedPool, wrongDiscriminator: overrides.wrongDiscriminator,
        wrongAmount: overrides.wrongAmount, unrelatedInstruction: overrides.unrelatedInstruction,
        withSetup:overrides.withSetup,setupMalice:overrides.setupMalice,
        expensiveCompute:overrides.expensiveCompute }), feeBps: 0,
      ...(!overrides.missingFees ? { signatureFeeLamports: overrides.finalNetworkFee ?? 5000,
        signatureFeePayer: fixtureTaker, prioritizationFeeLamports: 0, prioritizationFeePayer: fixtureTaker,
        rentFeeLamports: overrides.finalRentFee ?? (overrides.withSetup ? 4_078_560 : 2039280), rentFeePayer: fixtureTaker } : {})
    } };
    const outAmount = prices[forward++] ?? '988142';
    return { status: 200, headers: noHeaders, body: {
      inAmount: '25000000', outAmount, otherAmountThreshold: overrides.forwardMin ?? outAmount,
      slippageBps: 100, feeBps: 0, routePlan: [{ swapInfo: { ammKey: pool,
        inputMint: payload.inputMint, outputMint: payload.outputMint,
        inAmount: payload.amount, outAmount } }]
    } };
  }};
  const accountRpc = { call: async (work: string, method: string, _params: any[], options: any) => {
    calls.push(`${work}:${method}`);
    assert.equal(options.bypassCache, true);
    if (method === 'getAccountInfo') return { context: { slot: 123 }, value: {
      owner: overrides.mintOwner ?? TOKEN_PROGRAM_ID.toBase58(), data: [mintData.toString('base64'), 'base64'], executable: false
    } };
    if (method === 'getMinimumBalanceForRentExemption') return 2_039_280;
    if (method === 'simulateTransaction') {
      assert.equal(_params[1].innerInstructions,true);
      assert.equal(_params[1].minContextSlot,100);
      const cpiData = Buffer.alloc(25);
      Buffer.from(overrides.wrongDiscriminator ? [0,0,0,0,0,0,0,0] :
        [198,46,21,82,180,217,232,112]).copy(cpiData);
      cpiData.writeBigUInt64LE(overrides.wrongAmount ? 24_000_000n : 25_000_000n,8);
      cpiData.writeBigUInt64LE(988_142n,16);
      return { context: {slot: overrides.staleSimulation ? 122 : 124}, value: {
        err: overrides.simulationError ?? null, unitsConsumed: 1000,
        innerInstructions: overrides.missingTrace ? null : [{ index:overrides.withSetup ? 4 : 0,instructions:[{
          programId:PUMP_SWAP_PROGRAM.toBase58(), stackHeight:2,
          accounts:[pool,fixtureTaker,key(14).toBase58(),mint,
            'So11111111111111111111111111111111111111112',
            overrides.cpiWrongUserAta ? key(15).toBase58() :
              getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(fixtureTaker),true).toBase58(),
            getAssociatedTokenAddressSync(new PublicKey('So11111111111111111111111111111111111111112'),
              new PublicKey(fixtureTaker),true).toBase58(),evidence.baseVault,evidence.quoteVault], data:bs58.encode(cpiData)
        }]}] } };
    }
    throw new Error('UNPLANNED_RPC_METHOD');
  }};
  const rpc = { call: async (work: string, method: string, params: any[], options: any) => {
    if (method === 'getSlot' || method === 'getMultipleAccounts') return physical.hub.call(work,method,params,options);
    return accountRpc.call(work,method,params,options);
  }};
  return { preflight: new PreFlightEngine(jupiter as any, rpc as any, fixtureTaker, new ConfirmedPoolReader(rpc as any)), calls, jupiter, physical };
}
