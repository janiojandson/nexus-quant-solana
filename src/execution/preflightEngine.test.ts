import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PreFlightEngine, directRouteMatches, feeEstimate } from './preflightEngine.js';
import { PUMP_SWAP_PROGRAM, RAYDIUM_CPMM_PROGRAM, RAYDIUM_AMM_V4_PROGRAM } from '../pump/confirmedPoolReader.js';
import { assembleV0AccountKeys, hasBoundSwapCpi, isJupiterRouteInstruction, JUPITER_SWAP_PROGRAM, validateEntryAuxiliaries } from './entryRoutePolicy.js';

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const mint = key(5).toBase58();
const pool = key(6).toBase58();
const taker = key(7).toBase58();
const noHeaders = { get: () => null };
const evidence = { kind: 'PHYSICAL_POOL_CONFIRMED' as const, venue: 'PumpSwap' as const,
  slot: 123, observedAt: new Date().toISOString(), programId: PUMP_SWAP_PROGRAM.toBase58(), poolAddress: pool,
  baseMint: mint, quoteMint: 'So11111111111111111111111111111111111111112',
  baseVault: key(8).toBase58(), quoteVault: key(9).toBase58(),
  physicalSolLamports: '20000000000', tokenReserveAtomic: '1000000000', poolCreatedAt: null };
function unsignedOrder(options: {payer?: PublicKey; unusedPool?: boolean; wrongDiscriminator?: boolean;
  wrongAmount?: boolean; unrelatedInstruction?: boolean; withSetup?: boolean;
  setupMalice?: 'owner'|'destination'|'amount'|'cleanup'; expensiveCompute?: boolean} = {}) {
  const route = createHash('sha256').update('global:route').digest().subarray(0,8);
  const data = Buffer.concat([route,Buffer.alloc(24)]);
  const instruction = new TransactionInstruction({ programId: new PublicKey(JUPITER_SWAP_PROGRAM),
    keys: [{ pubkey: options.payer ?? new PublicKey(taker), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(pool), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
      { pubkey: PUMP_SWAP_PROGRAM, isSigner: false, isWritable: false }], data });
  const wallet = options.payer ?? new PublicKey(taker);
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
      keys:[{pubkey:options.payer ?? new PublicKey(taker),isSigner:true,isWritable:true},
        {pubkey:new PublicKey(mint),isSigner:false,isWritable:false},
        {pubkey:PUMP_SWAP_PROGRAM,isSigner:false,isWritable:false}], data })
  ] : options.unrelatedInstruction ? [instruction,
    new TransactionInstruction({ programId: key(12), keys:[], data:Buffer.alloc(8, 1) })] :
    [...(options.expensiveCompute ? [ComputeBudgetProgram.setComputeUnitLimit({units:1_400_000}),
      ComputeBudgetProgram.setComputeUnitPrice({microLamports:1_000_000})] : []),
      ...setup,instruction,...cleanup];
  const message = new TransactionMessage({ payerKey: options.payer ?? new PublicKey(taker),
    recentBlockhash: key(10).toBase58(), instructions }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}
function fixture(overrides: { mintOwner?: string; mintData?: Buffer; simulationError?: unknown; reverseMin?: string;
  forwardMin?: string; adverseReverseMin?: string; finalMin?: string; finalSlippageBps?: number;
  reverseNetworkFee?: number; finalNetworkFee?: number; missingFees?: boolean;
  wrongTaker?: boolean; unusedPool?: boolean; wrongDiscriminator?: boolean;
  wrongAmount?: boolean; unrelatedInstruction?: boolean; missingTrace?: boolean;
  staleSimulation?: boolean; refreshedPoolDrained?: boolean; refreshedPoolStale?: boolean;
  refreshedPoolChanged?: boolean; withSetup?: boolean;
  setupMalice?: 'owner'|'destination'|'amount'|'cleanup'; cpiWrongUserAta?: boolean;
  expensiveCompute?: boolean; finalRentFee?: number; lease?: () => Promise<void>; entryFeeBps?: number } = {}) {
  const calls: string[] = [];
  const requests: any[] = [];
  const mintData = overrides.mintData ?? Buffer.alloc(82);
  if (!overrides.mintData) mintData[44] = 6;
  const prices = ['1000000', '996016', '992063', '988142'];
  let forward = 0;
  const jupiter = { request: async (work: string, endpoint: string, payload: any, options: any) => {
    requests.push({ ...payload });
    calls.push(`${work}:${endpoint}`);
    assert.equal(work, 'ENTRY'); assert.equal(endpoint, '/swap/v2/order');
    assert.ok(options.deadlineMs > Date.now());
    if (payload.inputMint === mint) return { status: 200, headers: noHeaders, body: {
      taker: payload.taker, transaction: payload.taker ? unsignedOrder() : '', transactionVersion: 0,
      inAmount: payload.amount, outAmount: '24500000',
      otherAmountThreshold: payload.amount === overrides.forwardMin && overrides.adverseReverseMin
        ? overrides.adverseReverseMin : overrides.reverseMin ?? '24000000', feeBps: 0,
      slippageBps: 100, routePlan: [{ swapInfo: { ammKey: pool, inputMint: mint,
        outputMint: 'So11111111111111111111111111111111111111112', inAmount: payload.amount,
        outAmount: '24500000' } }],
      ...(!overrides.missingFees ? { signatureFeeLamports: overrides.reverseNetworkFee ?? 5000,
        signatureFeePayer: taker, prioritizationFeeLamports: 0, prioritizationFeePayer: taker,
        rentFeeLamports: 0, rentFeePayer: taker } : {})
    } };
    if (payload.taker) return { status: 200, headers: noHeaders, body: {
      taker: payload.taker,
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
        signatureFeePayer: taker, prioritizationFeeLamports: 0, prioritizationFeePayer: taker,
        rentFeeLamports: overrides.finalRentFee ?? (overrides.withSetup ? 4_078_560 : 2039280), rentFeePayer: taker } : {})
    } };
    const outAmount = prices[forward++] ?? '988142';
    const feeBps = overrides.entryFeeBps ?? 0;
    const grossOut = feeBps > 0 ? String(BigInt(outAmount) * 10000n / BigInt(10000 - feeBps)) : outAmount;
    return { status: 200, headers: noHeaders, body: {
      inAmount: '25000000', outAmount, otherAmountThreshold: overrides.forwardMin ?? outAmount,
      slippageBps: 100, feeBps, routePlan: [{ swapInfo: { ammKey: pool,
        inputMint: payload.inputMint, outputMint: payload.outputMint,
        inAmount: payload.amount, outAmount: grossOut } }]
    } };
  }};
  const rpc = { call: async (work: string, method: string, _params: any[], options: any) => {
    calls.push(`${work}:${method}`);
    assert.equal(options.bypassCache, true);
    if (method === 'getAccountInfo') return { context: { slot: 123 }, value: {
      owner: overrides.mintOwner ?? TOKEN_PROGRAM_ID.toBase58(), data: [mintData.toString('base64'), 'base64'], executable: false
    } };
    if (method === 'getMinimumBalanceForRentExemption') return 2_039_280;
    if (method === 'simulateTransaction') {
      assert.equal(_params[1].innerInstructions,true);
      assert.equal(_params[1].minContextSlot,124);
      const cpiData = Buffer.alloc(25);
      Buffer.from(overrides.wrongDiscriminator ? [0,0,0,0,0,0,0,0] :
        [198,46,21,82,180,217,232,112]).copy(cpiData);
      cpiData.writeBigUInt64LE(overrides.wrongAmount ? 24_000_000n : 25_000_000n,8);
      cpiData.writeBigUInt64LE(988_142n,16);
      return { context: {slot: overrides.staleSimulation ? 122 : 124}, value: {
        err: overrides.simulationError ?? null, unitsConsumed: 1000,
        innerInstructions: overrides.missingTrace ? null : [{ index:overrides.withSetup ? 4 : 0,instructions:[{
          programId:PUMP_SWAP_PROGRAM.toBase58(), stackHeight:2,
          accounts:[pool,taker,key(14).toBase58(),mint,
            'So11111111111111111111111111111111111111112',
            overrides.cpiWrongUserAta ? key(15).toBase58() :
              getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(taker),true).toBase58(),
            getAssociatedTokenAddressSync(new PublicKey('So11111111111111111111111111111111111111112'),
              new PublicKey(taker),true).toBase58(),evidence.baseVault,evidence.quoteVault], data:bs58.encode(cpiData)
        }]}] } };
    }
    throw new Error('UNPLANNED_RPC_METHOD');
  }};
  let poolReads = 0;
  const poolReader = { read: async () => {
    poolReads++;
    return { ok: true as const, evidence: { ...evidence,
      observedAt: new Date(Date.now() - (poolReads > 1 && overrides.refreshedPoolStale ? 16_000 : 0)).toISOString(),
      physicalSolLamports: poolReads > 1 && overrides.refreshedPoolDrained ? '19000000000' : evidence.physicalSolLamports,
      poolAddress: poolReads > 1 && overrides.refreshedPoolChanged ? key(23).toBase58() : evidence.poolAddress,
      slot: poolReads > 1 ? 124 : 123
    } };
  } };
  return { preflight: new PreFlightEngine(jupiter as any, rpc as any, taker, poolReader as any), calls, requests };
}

test('reverse and adverse fee-bearing preflight orders include public taker while momentum remains quote-only', async () => {
  const f = fixture({ forwardMin: '980000' });
  const result = await f.preflight.run({ mint, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000 });
  assert.equal(result.accepted, true, JSON.stringify(result));
  const reverse = f.requests.filter(request => request.inputMint === mint);
  assert.equal(reverse.length, 2);
  assert.equal(reverse.every(request => request.taker === taker), true);
  assert.equal(f.requests.slice(0, 4).every(request => request.taker === undefined), true);
});

test('4D accepts real 25M lamport size with unsigned final compiled order and no execute endpoint', async () => {
  const { preflight, calls } = fixture();
  const result = await preflight.run({ mint, stakeLamports: 25_000_000, availableLamports: 100_000_000,
    reservedGasLamports: 5_000_000, poolHints: [pool] });
  assert.equal(result.accepted, true, JSON.stringify(result));
  if (!result.accepted) return;
  assert.equal(result.order.inAmount, '25000000');
  assert.equal(result.evidence.pool.poolAddress, pool);
  assert.equal(result.evidence.momentum.samples.length, 4);
  assert.ok(calls.includes('CRITICAL:simulateTransaction'));
  assert.ok(calls.every(call => !call.includes('execute')));
});

test('4D tolerates Jupiter platform fee on direct route (gross AMM out vs net order out)', async () => {
  const f = fixture({ entryFeeBps: 10 });
  const result = await f.preflight.run({ mint, stakeLamports: 25_000_000, availableLamports: 100_000_000,
    reservedGasLamports: 5_000_000, poolHints: [pool] });
  assert.equal(result.accepted, true, JSON.stringify(result));
});

test('4D rejects Token-2022 and losing reverse minOut before final order', async () => {
  const token2022 = fixture({ mintOwner: key(11).toBase58() });
  const first = await token2022.preflight.run({ mint, stakeLamports: 25_000_000, availableLamports: 100_000_000,
    reservedGasLamports: 5_000_000, poolHints: [pool] });
  assert.deepEqual(first.accepted, false);
  assert.ok(token2022.calls.every(call => !call.includes('simulateTransaction')));
  const loss = fixture({ reverseMin: '23000000' });
  const second = await loss.preflight.run({ mint, stakeLamports: 25_000_000, availableLamports: 100_000_000,
    reservedGasLamports: 5_000_000, poolHints: [pool] });
  assert.equal(second.accepted, false);
  assert.ok(loss.calls.every(call => !call.includes('simulateTransaction')));
});

test('4D rejects simulation value.err and lease loss after an awaited boundary', async () => {
  const simulation = fixture({ simulationError: { InstructionError: [0, 'Custom'] } });
  const first = await simulation.preflight.run({ mint, stakeLamports: 25_000_000, availableLamports: 100_000_000,
    reservedGasLamports: 5_000_000, poolHints: [pool] });
  assert.equal(first.accepted, false);
  let checks = 0;
  const lost = fixture();
  const second = await lost.preflight.run({ mint, stakeLamports: 25_000_000, availableLamports: 100_000_000,
    reservedGasLamports: 5_000_000, poolHints: [pool],
    assertLeaseActive: async () => { if (++checks === 2) throw new Error('LEASE_LOST'); } });
  assert.equal(second.accepted, false);
  assert.ok(lost.calls.every(call => !call.includes('simulateTransaction')));
});

test('4D rejects returned slippage above requested 100 bps and final minimum worse than preflight', async () => {
  const slippage = fixture({ finalSlippageBps: 101 });
  assert.equal((await slippage.preflight.run({ mint, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000 })).accepted, false);
  const worse = fixture({ finalMin: '980000' });
  assert.equal((await worse.preflight.run({ mint, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000 })).accepted, false);
});

test('4D includes adverse forward minimum in reverse loss bound and fails missing thresholds', async () => {
  const adverse = fixture({ forwardMin: '900000', adverseReverseMin: '23000000' });
  assert.equal((await adverse.preflight.run({ mint, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000 })).accepted, false);
  const missing = fixture({ reverseMin: '' });
  assert.equal((await missing.preflight.run({ mint, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000 })).accepted, false);
});

test('taker-paid network fees can push a borderline quote over five percent', async () => {
  const fee = fixture({ reverseMin: '23760000', reverseNetworkFee: 10_000, finalNetworkFee: 10_000 });
  const result = await fee.preflight.run({ mint, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000 });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'ROUND_TRIP_LOSS');
});

test('missing fee estimates or final order fee increase reject before simulation acceptance', async () => {
  const unknown = fixture({ missingFees: true });
  const first = await unknown.preflight.run({ mint, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000 });
  assert.equal(first.accepted, false);
  const increased = fixture({ reverseMin: '23760000', finalNetworkFee: 20_000 });
  const second = await increased.preflight.run({ mint, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000 });
  assert.equal(second.accepted, false);
});

test('compiled order rejects wrong signing taker and pool merely listed in unrelated instruction', async () => {
  for (const options of [{ wrongTaker: true }, { unusedPool: true }]) {
    const f = fixture(options);
    const result = await f.preflight.run({ mint, stakeLamports: 25_000_000,
      availableLamports: 100_000_000, reservedGasLamports: 5_000_000 });
    assert.equal(result.accepted, false);
    assert.ok(f.calls.every(call => !call.includes('simulateTransaction')));
  }
});

test('compiled order binds the exact PumpSwap discriminator and quote amount, not stray matching bytes', async () => {
  for (const options of [{ wrongDiscriminator: true }, { wrongAmount: true },
    { unrelatedInstruction: true }, {missingTrace:true}, {staleSimulation:true}]) {
    const f = fixture(options);
    const result = await f.preflight.run({ mint, stakeLamports: 25_000_000,
      availableLamports: 100_000_000, reservedGasLamports: 5_000_000 });
    assert.equal(result.accepted, false, JSON.stringify(options));
    assert.equal(result.reason, options.unrelatedInstruction ? 'UNSUPPORTED_ROUTE_INSTRUCTION' : 'SIMULATION_ROUTE_UNPROVEN');
  }
});

test('v0 loaded addresses order all table writable keys before all readonly keys', () => {
  assert.deepEqual(assembleV0AccountKeys(['static'], [
    { writable: ['w1'], readonly: ['r1'] }, { writable: ['w2'], readonly: ['r2'] }
  ]), ['static','w1','w2','r1','r2']);
});

test('official Raydium CPMM swap_base_input CPI binds pool, vaults, mints, amount and minimum', () => {
  const rayPool = { ...evidence, venue:'Raydium CPMM' as const,
    programId:RAYDIUM_CPMM_PROGRAM.toBase58() };
  const data = Buffer.alloc(24);
  Buffer.from([143,190,90,218,196,30,51,222]).copy(data);
  data.writeBigUInt64LE(25_000_000n,8);
  data.writeBigUInt64LE(988_142n,16);
  const accounts = [taker,key(17).toBase58(),key(18).toBase58(),pool,
    getAssociatedTokenAddressSync(new PublicKey('So11111111111111111111111111111111111111112'),
      new PublicKey(taker),true).toBase58(),
    getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(taker),true).toBase58(),
    evidence.quoteVault,evidence.baseVault,
    TOKEN_PROGRAM_ID.toBase58(),TOKEN_PROGRAM_ID.toBase58(),
    'So11111111111111111111111111111111111111112',mint,key(21).toBase58()];
  const trace = (payload: Buffer, keys = accounts) => [{index:2,instructions:[{
    programId:RAYDIUM_CPMM_PROGRAM.toBase58(),stackHeight:2,accounts:keys,data:bs58.encode(payload)
  }]}];
  assert.equal(hasBoundSwapCpi(trace(data),2,rayPool,mint,taker,25_000_000n,988_142n),true);
  const wrongAmount = Buffer.from(data); wrongAmount.writeBigUInt64LE(24_000_000n,8);
  assert.equal(hasBoundSwapCpi(trace(wrongAmount),2,rayPool,mint,taker,25_000_000n,988_142n),false);
  assert.equal(hasBoundSwapCpi(trace(data),2,rayPool,mint,taker,25_000_000n,988_143n),false);
  assert.equal(hasBoundSwapCpi(trace(data,[...accounts.slice(0,6),key(22).toBase58(),...accounts.slice(7)]),
    2,rayPool,mint,taker,25_000_000n,988_142n),false);
  assert.equal(hasBoundSwapCpi(trace(data),1,rayPool,mint,taker,25_000_000n,988_142n),false);
});

test('official Raydium AMM V4 SwapBaseIn CPI binds pool, authority, user ATAs, amount and minimum', () => {
  const [authority] = PublicKey.findProgramAddressSync([Buffer.from('amm authority')], RAYDIUM_AMM_V4_PROGRAM);
  const v4Pool = { ...evidence, venue: 'Raydium AMM V4' as const,
    programId: RAYDIUM_AMM_V4_PROGRAM.toBase58() };
  const data = Buffer.alloc(17);
  data[0] = 9;
  data.writeBigUInt64LE(25_000_000n, 1);
  data.writeBigUInt64LE(988_142n, 9);
  const inputAta = getAssociatedTokenAddressSync(new PublicKey('So11111111111111111111111111111111111111112'),
    new PublicKey(taker), true).toBase58();
  const outputAta = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(taker), true).toBase58();
  const accounts = [
    TOKEN_PROGRAM_ID.toBase58(), pool, authority.toBase58(), key(10).toBase58(), key(11).toBase58(),
    evidence.quoteVault, evidence.baseVault, key(12).toBase58(), key(13).toBase58(), key(14).toBase58(),
    key(15).toBase58(), key(16).toBase58(), key(17).toBase58(), key(18).toBase58(), key(19).toBase58(),
    inputAta, outputAta, taker
  ];
  const trace = (payload: Buffer, keys = accounts) => [{index: 2, instructions: [{
    programId: RAYDIUM_AMM_V4_PROGRAM.toBase58(), stackHeight: 2, accounts: keys, data: bs58.encode(payload)
  }]}];
  assert.equal(hasBoundSwapCpi(trace(data), 2, v4Pool, mint, taker, 25_000_000n, 988_142n), true);
  const wrongAmount = Buffer.from(data); wrongAmount.writeBigUInt64LE(24_000_000n, 1);
  assert.equal(hasBoundSwapCpi(trace(wrongAmount), 2, v4Pool, mint, taker, 25_000_000n, 988_142n), false);
  assert.equal(hasBoundSwapCpi(trace(data), 2, v4Pool, mint, taker, 25_000_000n, 988_143n), false);
  assert.equal(hasBoundSwapCpi(trace(data), 1, v4Pool, mint, taker, 25_000_000n, 988_142n), false);
});

test('fresh physical reserve proof is required after quotes before final simulation', async () => {
  for (const options of [{refreshedPoolDrained:true},{refreshedPoolStale:true},
    {refreshedPoolChanged:true}]) {
    const f = fixture(options);
    const result = await f.preflight.run({mint,stakeLamports:25_000_000,
      availableLamports:100_000_000,reservedGasLamports:5_000_000});
    assert.equal(result.accepted,false,JSON.stringify(options));
    assert.ok(f.calls.every(call=>call!=='CRITICAL:simulateTransaction'));
  }
});

test('first buy accepts only canonical funded WSOL and target ATA setup with self-refund cleanup', async () => {
  assert.equal(VersionedTransaction.deserialize(Buffer.from(unsignedOrder({withSetup:true}),'base64')).version,0);
  const good = fixture({withSetup:true});
  const accepted = await good.preflight.run({mint,stakeLamports:25_000_000,
    availableLamports:100_000_000,reservedGasLamports:5_000_000});
  assert.equal(accepted.accepted,true,JSON.stringify(accepted));
  for (const setupMalice of ['owner','destination','amount','cleanup'] as const) {
    const malicious = fixture({withSetup:true,setupMalice});
    const denied = await malicious.preflight.run({mint,stakeLamports:25_000_000,
      availableLamports:100_000_000,reservedGasLamports:5_000_000});
    assert.equal(denied.accepted,false,setupMalice);
    assert.equal(denied.reason,'UNSUPPORTED_ROUTE_INSTRUCTION');
    assert.ok(malicious.calls.every(call=>call!=='CRITICAL:simulateTransaction'));
  }
});

test('simulation CPI cannot deliver bought tokens to a foreign user account', async () => {
  const f = fixture({withSetup:true,cpiWrongUserAta:true});
  const denied = await f.preflight.run({mint,stakeLamports:25_000_000,
    availableLamports:100_000_000,reservedGasLamports:5_000_000});
  assert.equal(denied.accepted,false);
  assert.equal(denied.reason,'SIMULATION_ROUTE_UNPROVEN');
});

test('auxiliary ATA rent and compute priority cannot exceed declared capital estimate', async () => {
  for (const options of [{withSetup:true,finalRentFee:2_039_280},
    {expensiveCompute:true}]) {
      const f = fixture(options);
      const denied = await f.preflight.run({mint,stakeLamports:25_000_000,
        availableLamports:100_000_000,reservedGasLamports:5_000_000});
      assert.equal(denied.accepted,false,JSON.stringify(options));
      assert.ok(f.calls.every(call=>call!=='CRITICAL:simulateTransaction'));
    }
});

test('preflightEngine accepts Token-2022 mint with safe metadata extensions [18, 19]', async () => {
  const mintBuf = Buffer.alloc(166 + 4 + 10 + 4 + 20);
  mintBuf[44] = 6;
  mintBuf[45] = 1;
  mintBuf[165] = 1;
  mintBuf.writeUInt16LE(18, 166);
  mintBuf.writeUInt16LE(10, 168);
  mintBuf.writeUInt16LE(19, 166 + 14);
  mintBuf.writeUInt16LE(20, 166 + 16);

  const f = fixture({ mintOwner: TOKEN_2022_PROGRAM_ID.toBase58(), mintData: mintBuf });
  const result = await f.preflight.run({ mint, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000, poolHints: [pool] });
  assert.equal(result.accepted, true);
});

test('preflightEngine rejects Token-2022 mint with dangerous extension or active authority', async () => {
  // Case 1: TransferFeeConfig (extension 1)
  const feeMintBuf = Buffer.alloc(166 + 4 + 10);
  feeMintBuf[44] = 6;
  feeMintBuf[45] = 1;
  feeMintBuf[165] = 1;
  feeMintBuf.writeUInt16LE(1, 166);
  feeMintBuf.writeUInt16LE(10, 168);

  const f1 = fixture({ mintOwner: TOKEN_2022_PROGRAM_ID.toBase58(), mintData: feeMintBuf });
  const res1 = await f1.preflight.run({ mint, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000, poolHints: [pool] });
  assert.equal(res1.accepted, false);
  assert.equal(res1.reason, 'UNSAFE_TOKEN_2022_EXTENSIONS');

  // Case 2: PermanentDelegate (extension 12)
  const delMintBuf = Buffer.alloc(166 + 4 + 10);
  delMintBuf[44] = 6;
  delMintBuf[45] = 1;
  delMintBuf[165] = 1;
  delMintBuf.writeUInt16LE(12, 166);
  delMintBuf.writeUInt16LE(10, 168);

  const f2 = fixture({ mintOwner: TOKEN_2022_PROGRAM_ID.toBase58(), mintData: delMintBuf });
  const res2 = await f2.preflight.run({ mint, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000, poolHints: [pool] });
  assert.equal(res2.accepted, false);
  assert.equal(res2.reason, 'UNSAFE_TOKEN_2022_EXTENSIONS');

  // Case 3: Token-2022 with active mint authority
  const authMintBuf = Buffer.alloc(166 + 4 + 10);
  authMintBuf.writeUInt32LE(1, 0); // mint authority active!
  authMintBuf[44] = 6;
  authMintBuf[45] = 1;
  authMintBuf[165] = 1;
  authMintBuf.writeUInt16LE(18, 166);
  authMintBuf.writeUInt16LE(10, 168);

  const f3 = fixture({ mintOwner: TOKEN_2022_PROGRAM_ID.toBase58(), mintData: authMintBuf });
  const res3 = await f3.preflight.run({ mint, stakeLamports: 25_000_000,
    availableLamports: 100_000_000, reservedGasLamports: 5_000_000, poolHints: [pool] });
  assert.equal(res3.accepted, false);
  assert.equal(res3.reason, 'MINT_OR_FREEZE_AUTHORITY_ACTIVE');
});

test('validateEntryAuxiliaries and hasBoundSwapCpi accept Token-2022 target ATA', () => {
  const wallet = new PublicKey(taker);
  const target = new PublicKey(mint);
  const wsol = new PublicKey('So11111111111111111111111111111111111111112');
  const wsolAta = getAssociatedTokenAddressSync(wsol, wallet, true);
  const targetAta2022 = getAssociatedTokenAddressSync(target, wallet, true, TOKEN_2022_PROGRAM_ID);
  
  const instructions = [
    createAssociatedTokenAccountIdempotentInstruction(wallet, wsolAta, wallet, wsol),
    createAssociatedTokenAccountIdempotentInstruction(wallet, targetAta2022, wallet, target, TOKEN_2022_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wsolAta, lamports: 25_000_000 }),
    createSyncNativeInstruction(wsolAta),
    new TransactionInstruction({ programId: new PublicKey(JUPITER_SWAP_PROGRAM), keys: [], data: Buffer.alloc(0) }),
    createCloseAccountInstruction(wsolAta, wallet, wallet)
  ];

  const seen = validateEntryAuxiliaries(instructions, 4, taker, mint, 25_000_000, 10_000);
  assert.equal(seen, 2, 'Should accept Token-2022 target ATA preparation');

  const cpiData = Buffer.alloc(25);
  Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]).copy(cpiData);
  cpiData.writeBigUInt64LE(25_000_000n, 8);
  cpiData.writeBigUInt64LE(988_142n, 16);

  const innerGroups = [{
    index: 4,
    instructions: [{
      programId: PUMP_SWAP_PROGRAM.toBase58(),
      stackHeight: 2,
      data: bs58.encode(cpiData),
      accounts: [
        pool,
        key(20).toBase58(),
        key(21).toBase58(),
        mint,
        'So11111111111111111111111111111111111111112',
        targetAta2022.toBase58(),
        wsolAta.toBase58(),
        key(8).toBase58(),
        key(9).toBase58()
      ]
    }]
  }];

  const pass = hasBoundSwapCpi(innerGroups, 4, evidence, mint, taker, 25_000_000n, 988_142n);
  assert.equal(pass, true, 'hasBoundSwapCpi should bind Token-2022 output ATA');
});

test('directRouteMatches: tolera taxa deduzida na entrada (SOL) e na saida (Token)', () => {
  const inputMint = 'So11111111111111111111111111111111111111112';
  const outputMint = mint;
  const poolAddress = pool;

  // 1. Taxa deduzida na entrada: solicitado 25_000_000, swapInfo.inAmount = 24_975_000 (10 bps de fee)
  const orderInputFee: any = {
    feeBps: 10,
    outAmount: '1000000',
    routePlan: [{
      swapInfo: {
        ammKey: poolAddress,
        inputMint,
        outputMint,
        inAmount: '24975000',
        outAmount: '1000000'
      }
    }]
  };
  assert.equal(directRouteMatches(orderInputFee, inputMint, outputMint, '25000000', poolAddress), true, 'Deve aceitar taxa deduzida na entrada');

  // 2. Taxa deduzida na saida: gross > net com feeBps
  const orderOutputFee: any = {
    feeBps: 10,
    outAmount: '999000',
    routePlan: [{
      swapInfo: {
        ammKey: poolAddress,
        inputMint,
        outputMint,
        inAmount: '25000000',
        outAmount: '1000000'
      }
    }]
  };
  assert.equal(directRouteMatches(orderOutputFee, inputMint, outputMint, '25000000', poolAddress), true, 'Deve aceitar taxa deduzida na saida');

  // 3. Rejeita se a pool divergente
  assert.equal(directRouteMatches(orderInputFee, inputMint, outputMint, '25000000', 'wrong-pool'), false, 'Deve rejeitar pool divergente');

  // 4. Rejeita se diferenca de entrada exceder feeBps
  const orderExcessiveInputDiff: any = {
    feeBps: 10,
    outAmount: '1000000',
    routePlan: [{
      swapInfo: {
        ammKey: poolAddress,
        inputMint,
        outputMint,
        inAmount: '24000000', // 1_000_000 de diferenca > 25_000 (10 bps)
        outAmount: '1000000'
      }
    }]
  };
  assert.equal(directRouteMatches(orderExcessiveInputDiff, inputMint, outputMint, '25000000', poolAddress), false, 'Deve rejeitar desconto de entrada maior que feeBps');
});

test('feeEstimate: aceita taxa deterministica de 5.000 lamports em cotacao reversa sem fundos do token', () => {
  const reverseOrderWithoutFunds: any = {
    errorCode: 1,
    errorMessage: 'Insufficient funds',
    transaction: '',
    outAmount: '16000000'
  };
  const result = feeEstimate(reverseOrderWithoutFunds, taker, true);
  assert.deepEqual(result, { network: 5000, rent: 0 });

  // Rejeita na ordem de entrada (forward buy), onde a transação real é mandatória
  const forwardOrderWithoutFunds: any = {
    errorCode: 1,
    errorMessage: 'Insufficient funds',
    transaction: ''
  };
  const forwardResult = feeEstimate(forwardOrderWithoutFunds, taker, false);
  assert.equal(forwardResult, null);
});

test('isJupiterRouteInstruction: reconhece route_v2 e shared_accounts_route_v2 da Jupiter v6', () => {
  const routeV2Disc = createHash('sha256').update('global:route_v2').digest().subarray(0, 8);
  const sharedV2Disc = createHash('sha256').update('global:shared_accounts_route_v2').digest().subarray(0, 8);
  const dummyPayload = Buffer.concat([routeV2Disc, Buffer.alloc(20)]);
  const dummySharedPayload = Buffer.concat([sharedV2Disc, Buffer.alloc(20)]);

  assert.equal(isJupiterRouteInstruction(JUPITER_SWAP_PROGRAM, dummyPayload, [taker], taker), true,
    'Deve aceitar instrucao route_v2 da Jupiter v6');
  assert.equal(isJupiterRouteInstruction(JUPITER_SWAP_PROGRAM, dummySharedPayload, [taker], taker), true,
    'Deve aceitar instrucao shared_accounts_route_v2 da Jupiter v6');
  assert.equal(isJupiterRouteInstruction('WrongProgramId111111111111111111111111111111', dummyPayload, [taker], taker), false,
    'Deve rejeitar programId diferente da Jupiter');
});

test('4D tolera variacao micro de AMM (20 bps) na ordem final sem disparar FINAL_ORDER_INVALID', async () => {
  // forward.outAmount = 988142
  // final.outAmount com queda de 20 bps = 986165 (988142 * 0.998)
  const slightDrop = fixture({ finalMin: '986165' });
  const result = await slightDrop.preflight.run({
    mint,
    stakeLamports: 25_000_000,
    availableLamports: 100_000_000,
    reservedGasLamports: 5_000_000
  });
  assert.equal(result.accepted, true, 'Deve aceitar variacao micro de 20 bps na ordem final');
});

test('4D aceita cotacao reversa multirrota (split AMM) na simulacao de saida para round-trip', async () => {
  const multiRouteReverse = fixture();
  // Override para simular resposta da Jupiter com 2 pernas (Pump AMM + Meteora DLMM) na cotacao reversa
  const originalRequest = (multiRouteReverse.preflight as any).jupiterHub.request;
  (multiRouteReverse.preflight as any).jupiterHub.request = async (work: string, endpoint: string, payload: any, options: any) => {
    const res = await originalRequest(work, endpoint, payload, options);
    if (payload.inputMint === mint) {
      // Cotacao reversa com 2 pernas
      res.body.routePlan = [
        { swapInfo: { ammKey: 'MeteoraPool1111111111111111111111111111111', inputMint: mint, outputMint: 'So11111111111111111111111111111111111111112', percent: 20 } },
        { swapInfo: { ammKey: pool, inputMint: mint, outputMint: 'So11111111111111111111111111111111111111112', percent: 80 } }
      ];
    }
    return res;
  };

  const result = await multiRouteReverse.preflight.run({
    mint,
    stakeLamports: 25_000_000,
    availableLamports: 100_000_000,
    reservedGasLamports: 5_000_000
  });
  assert.equal(result.accepted, true, 'Deve aprovar preflight quando cotacao reversa agrega multiplas AMMs');
});
