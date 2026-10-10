import { AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { JupiterOrgHub } from '../hubs/jupiterOrgHub.js';
import type { HeliusRpcHub } from '../hubs/heliusRpcHub.js';
import { ConfirmedPoolReader, type ConfirmedPoolEvidence, type PoolEvidenceReader } from '../pump/confirmedPoolReader.js';
import { PUMP_PROGRAM_ID } from '../pump/pumpBondingCurve.js';
import { observeEntryMomentum, type EntryMomentumResult } from './entryMomentumGate.js';
import { publicTakerFeeEstimate } from './publicTakerFeeProof.js';
import { assembleV0AccountKeys, hasBoundSwapCpi, isJupiterRouteInstruction,
  referencesProgram, validateEntryAuxiliaries } from './entryRoutePolicy.js';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DEADLINE_MS = 10_000;
interface V2Order {
  taker?: string;
  requestId?: string; transaction?: string | null; inAmount?: string; outAmount?: string;
  otherAmountThreshold?: string; slippageBps?: number; feeBps?: number;
  routePlan?: unknown; errorCode?: number; transactionVersion?: number;
  signatureFeeLamports?: number; signatureFeePayer?: string | null;
  prioritizationFeeLamports?: number; prioritizationFeePayer?: string | null;
  rentFeeLamports?: number; rentFeePayer?: string | null;
  expireAt?: string;
}
export interface PreflightRequest {
  mint: string; stakeLamports: number; poolHints?: readonly string[];
  /** Observed wallet balance and untouchable gas reserve from sizing policy. */
  availableLamports: number; reservedGasLamports: number;
  signal?: AbortSignal; assertLeaseActive?: () => Promise<void>;
}
export interface PreflightEvidence {
  mintSlot: number; pool: ConfirmedPoolEvidence; momentum: EntryMomentumResult;
  forwardOutAmount: string; forwardMinOutAmount: string;
  reverseMinOutLamports: string; adverseReverseMinOutLamports: string;
  roundTripLossPct: number; takerNetworkFeeLamports: number;
  entryRentReserveLamports: number; simulationUnitsConsumed: number | null;
}
export type PreflightResult =
  | { accepted: true; evidence: PreflightEvidence; order: Required<Pick<V2Order,'requestId'|'transaction'|'inAmount'|'outAmount'>> & V2Order }
  | { accepted: false; reason: string; evidence?: Partial<PreflightEvidence> };
const positiveInteger = (raw: unknown): bigint | null =>
  typeof raw === 'string' && /^[0-9]+$/.test(raw) && BigInt(raw) > 0n ? BigInt(raw) : null;
const deny = (reason: string): PreflightResult => ({ accepted: false, reason });
function feeEstimate(order: V2Order, taker: string): {network: number; rent: number} | null {
  return publicTakerFeeEstimate(order as unknown as Record<string, unknown>, taker);
}
function directRouteMatches(order: V2Order, inputMint: string, outputMint: string,
  amount: string, poolAddress: string): boolean {
  if (!Array.isArray(order.routePlan) || order.routePlan.length !== 1) return false;
  const step = order.routePlan[0] as {swapInfo?: Record<string,unknown>} | null;
  const info = step?.swapInfo;
  return info?.ammKey === poolAddress && info.inputMint === inputMint &&
    info.outputMint === outputMint && info.inAmount === amount &&
    info.outAmount === order.outAmount;
}
/** One typed, unsigned entry preflight. It never calls /execute or exposes a signer. */
export class PreFlightEngine {
  private readonly reader: PoolEvidenceReader;
  constructor(private readonly jupiterHub: Pick<JupiterOrgHub,'request'>,
    private readonly rpcHub: Pick<HeliusRpcHub,'call'>,
    private readonly walletPublicKey: string,
    reader?: PoolEvidenceReader) {
    this.reader = reader ?? new ConfirmedPoolReader(rpcHub);
  }

  async run(request: PreflightRequest): Promise<PreflightResult> {
    try {
      const mint = new PublicKey(request.mint).toBase58();
      new PublicKey(this.walletPublicKey);
      if (!Number.isSafeInteger(request.stakeLamports) || request.stakeLamports <= 0 ||
          !Number.isSafeInteger(request.availableLamports) || request.availableLamports <= 0 ||
          !Number.isSafeInteger(request.reservedGasLamports) || request.reservedGasLamports < 0)
        return deny('INVALID_CAPITAL_PROOF');
      const guard = async () => {
        if (request.signal?.aborted) throw new Error('LEASE_LOST');
        await request.assertLeaseActive?.();
        if (request.signal?.aborted) throw new Error('LEASE_LOST');
      };
      await guard();
      const poolResult = await this.reader.read(mint, request.poolHints);
      await guard();
      if (!poolResult.ok) return deny(poolResult.code);
      const pool = poolResult.evidence;
      if (pool.kind !== 'PHYSICAL_POOL_CONFIRMED' ||
          pool.programId === PUMP_PROGRAM_ID.toBase58() ||
          (pool.baseMint !== mint && pool.quoteMint !== mint) ||
          !((pool.baseMint === SOL_MINT) || (pool.quoteMint === SOL_MINT)) ||
          BigInt(pool.physicalSolLamports) <= 0n)
        return deny('INVALID_PHYSICAL_POOL');
      const mintResponse = await this.rpcHub.call('STATE', 'getAccountInfo', [mint, {
        encoding: 'base64', commitment: 'confirmed', minContextSlot: pool.slot
      }], { bypassCache: true, signal: request.signal });
      await guard();
      const mintResult = mintResponse as { context?: {slot?:number}; value?: {owner?:string;data?:[string,string];executable?:boolean} };
      const mintSlot = mintResult.context?.slot;
      const account = mintResult.value;
      if (!Number.isSafeInteger(mintSlot) || (mintSlot as number) < pool.slot || !account || account.executable !== false)
        return deny('MINT_STATE_UNAVAILABLE');
      if (account.owner === TOKEN_2022_PROGRAM_ID.toBase58()) return deny('TOKEN_2022_UNSUPPORTED');
      if (account.owner !== TOKEN_PROGRAM_ID.toBase58() || account.data?.[1] !== 'base64') return deny('INVALID_MINT_PROGRAM');
      const data = Buffer.from(account.data[0], 'base64');
      if (data.length !== 82 || data.readUInt32LE(0) !== 0 || data.readUInt32LE(46) !== 0)
        return deny('MINT_OR_FREEZE_AUTHORITY_ACTIVE');
      const decimals = data[44];
      if (decimals > 18) return deny('INVALID_MINT_DECIMALS');
      const inputAmount = String(request.stakeLamports);
      const getOrder = async (inputMint: string, outputMint: string, amount: string,
        deadlineMs = Date.now() + DEADLINE_MS, taker?: string): Promise<V2Order> => {
        const response = await this.jupiterHub.request('ENTRY','/swap/v2/order',{
          inputMint, outputMint, amount, slippageBps: 100, ...(taker ? { taker } : {})
        }, { deadlineMs, signal: request.signal });
        await guard();
        if (response.status !== 200 || !response.body || typeof response.body !== 'object') throw new Error('ORDER_UNAVAILABLE');
        const order = response.body as V2Order;
        if (!Number.isInteger(order.slippageBps) || order.slippageBps! < 0 || order.slippageBps! > 100)
          throw new Error('SLIPPAGE_ABOVE_REQUEST');
        if (!Number.isInteger(order.feeBps) || order.feeBps! < 0 || order.feeBps! > 10_000)
          throw new Error('FEE_RATE_UNAVAILABLE');
        if (!directRouteMatches(order,inputMint,outputMint,amount,pool.poolAddress) ||
            referencesProgram(order.routePlan, PUMP_PROGRAM_ID.toBase58()))
          throw new Error('UNCONFIRMED_QUOTE_ROUTE');
        return order;
      };
      const momentum = await observeEntryMomentum(async deadlineMs => {
        const order = await getOrder(SOL_MINT, mint, inputAmount, deadlineMs);
        return { inputAmountAtomic: order.inAmount ?? '', outputAmountAtomic: order.outAmount ?? '',
          tokenDecimals: decimals, observedAtMs: performance.now() };
      }, undefined, undefined, request.signal);
      await guard();
      if (!momentum.pass) return deny('MOMENTUM_' + momentum.reason);
      const forward = await getOrder(SOL_MINT, mint, inputAmount);
      const out = positiveInteger(forward.outAmount);
      const forwardMin = positiveInteger(forward.otherAmountThreshold);
      if (!out || !forwardMin || forwardMin > out || positiveInteger(forward.inAmount) !== BigInt(inputAmount))
        return deny('FORWARD_QUOTE_INVALID');
      const reverse = await getOrder(mint, SOL_MINT, out.toString(), Date.now() + DEADLINE_MS, this.walletPublicKey);
      const minOut = positiveInteger(reverse.otherAmountThreshold);
      if (!minOut || positiveInteger(reverse.inAmount) !== out || !positiveInteger(reverse.outAmount))
        return deny('REVERSE_QUOTE_INVALID');
      // The expected output and the guaranteed forward minimum are distinct
      // swap sizes. Price both explicitly; never extrapolate an AMM curve.
      const adverse = forwardMin === out ? reverse : await getOrder(mint, SOL_MINT, forwardMin.toString(),
        Date.now() + DEADLINE_MS, this.walletPublicKey);
      const adverseMin = positiveInteger(adverse.otherAmountThreshold);
      if (!adverseMin || positiveInteger(adverse.inAmount) !== forwardMin || !positiveInteger(adverse.outAmount))
        return deny('ADVERSE_REVERSE_QUOTE_INVALID');
      const expectedExitFees = feeEstimate(reverse, this.walletPublicKey);
      const adverseExitFees = feeEstimate(adverse, this.walletPublicKey);
      if (!expectedExitFees || !adverseExitFees) return deny('FEE_ESTIMATE_UNAVAILABLE');
      const final = await getOrder(SOL_MINT, mint, inputAmount, Date.now() + DEADLINE_MS, this.walletPublicKey);
      if (!final.requestId || !final.transaction || positiveInteger(final.inAmount) !== BigInt(inputAmount) ||
          !positiveInteger(final.outAmount) || !positiveInteger(final.otherAmountThreshold) ||
          positiveInteger(final.outAmount)! < out || positiveInteger(final.otherAmountThreshold)! < forwardMin ||
          (final.transactionVersion !== undefined && final.transactionVersion !== 0) ||
          (final.expireAt !== undefined && (!Number.isFinite(Date.parse(final.expireAt)) || Date.parse(final.expireAt) <= Date.now())))
        return deny('FINAL_ORDER_INVALID');
      const entryFees = feeEstimate(final, this.walletPublicKey);
      if (!entryFees) return deny('FEE_ESTIMATE_UNAVAILABLE');
      // feeBps may already affect quoted outAmount. Taking it again is a
      // conservative haircut, never a claim about actual net PnL.
      const feeBps = final.feeBps! + Math.max(reverse.feeBps!, adverse.feeBps!);
      const network = entryFees.network + Math.max(expectedExitFees.network, adverseExitFees.network);
      const conservative = Number(minOut < adverseMin ? minOut : adverseMin) * (1 - feeBps / 10_000) - network;
      const lossPct = 100 * (1 - conservative / request.stakeLamports);
      if (!Number.isFinite(lossPct) || lossPct >= 5) return deny('ROUND_TRIP_LOSS');
      if (request.availableLamports - request.stakeLamports - entryFees.network - entryFees.rent <
          request.reservedGasLamports) return deny('ENTRY_FEE_RENT_CAPITAL');
      if (referencesProgram(final.routePlan, PUMP_PROGRAM_ID.toBase58())) return deny('BONDING_CURVE_ROUTE');
      await guard();
      const refresh = await this.reader.read(mint, [pool.poolAddress]);
      await guard();
      if (!refresh.ok) return deny(refresh.code);
      const freshPool = refresh.evidence;
      const minReserveSol = Number(process.env.MIN_POOL_RESERVE_SOL || 20);
      const freshAt = Date.parse(freshPool.observedAt);
      if (freshPool.kind !== 'PHYSICAL_POOL_CONFIRMED' ||
          freshPool.slot < pool.slot || freshPool.poolAddress !== pool.poolAddress ||
          freshPool.programId !== pool.programId || freshPool.baseMint !== pool.baseMint ||
          freshPool.quoteMint !== pool.quoteMint || freshPool.baseVault !== pool.baseVault ||
          freshPool.quoteVault !== pool.quoteVault || !Number.isFinite(freshAt) ||
          freshAt > Date.now() + 1000 || Date.now() - freshAt > 15_000 ||
          !Number.isFinite(minReserveSol) || minReserveSol <= 0 ||
          !/^[0-9]+$/.test(freshPool.physicalSolLamports) ||
          BigInt(freshPool.physicalSolLamports) < BigInt(Math.ceil(minReserveSol * 1e9)))
        return deny('STALE_OR_DRAINED_POOL_PROOF');
      const transaction = VersionedTransaction.deserialize(Buffer.from(final.transaction, 'base64'));
      if (transaction.version !== 0 || transaction.signatures.length !== transaction.message.header.numRequiredSignatures)
        return deny('UNSUPPORTED_TRANSACTION_VERSION');
      if (transaction.message.header.numRequiredSignatures !== 1 ||
          transaction.message.staticAccountKeys[0]?.toBase58() !== this.walletPublicKey)
        return deny('WRONG_TRANSACTION_TAKER');
      if (transaction.signatures.some(signature => signature.some(byte => byte !== 0)))
        return deny('SIGNED_SHADOW_TRANSACTION');
      const tables: {writable:string[];readonly:string[]}[] = [];
      for (const lookup of transaction.message.addressTableLookups) {
        const response = await this.rpcHub.call('STATE','getAccountInfo',[lookup.accountKey.toBase58(),{
          encoding:'base64',commitment:'confirmed',minContextSlot:freshPool.slot
        }],{ bypassCache:true,signal:request.signal });
        await guard();
        const result = response as {context?:{slot?:number};value?:{owner?:string;data?:[string,string]}};
        if ((result.context?.slot ?? 0) < freshPool.slot || result.value?.owner !== AddressLookupTableProgram.programId.toBase58() ||
            result.value.data?.[1] !== 'base64') return deny('LOOKUP_TABLE_UNAVAILABLE');
        const table = AddressLookupTableAccount.deserialize(Buffer.from(result.value.data[0], 'base64'));
        const loaded = {writable: [] as string[],readonly: [] as string[]};
        for (const index of lookup.writableIndexes) {
          const address = table.addresses[index];
          if (!address) return deny('LOOKUP_INDEX_UNAVAILABLE');
          loaded.writable.push(address.toBase58());
        }
        for (const index of lookup.readonlyIndexes) {
          const address = table.addresses[index];
          if (!address) return deny('LOOKUP_INDEX_UNAVAILABLE');
          loaded.readonly.push(address.toBase58());
        }
        tables.push(loaded);
      }
      const addresses = assembleV0AccountKeys(transaction.message.staticAccountKeys.map(key => key.toBase58()),tables);
      if (!addresses.includes(pool.poolAddress) || !addresses.includes(pool.programId) ||
          addresses.includes(PUMP_PROGRAM_ID.toBase58())) return deny('ROUTE_POOL_MISMATCH');
      const jupiterIndexes: number[] = [];
      const decodedInstructions: TransactionInstruction[] = [];
      for (const [index,instruction] of transaction.message.compiledInstructions.entries()) {
        const keys = instruction.accountKeyIndexes.map(index => addresses[index]);
        const program = addresses[instruction.programIdIndex];
        if (!program || keys.some(key=>!key)) return deny('UNSUPPORTED_ROUTE_INSTRUCTION');
        decodedInstructions.push(new TransactionInstruction({programId:new PublicKey(program),
          keys:instruction.accountKeyIndexes.map(accountIndex=>({
            pubkey:new PublicKey(addresses[accountIndex]),
            isSigner:transaction.message.isAccountSigner(accountIndex),
            isWritable:transaction.message.isAccountWritable(accountIndex)
          })),data:Buffer.from(instruction.data)}));
        if (isJupiterRouteInstruction(program,instruction.data,keys,this.walletPublicKey) &&
            keys.includes(pool.poolAddress) && keys.includes(mint) && keys.includes(pool.programId))
          jupiterIndexes.push(index);
      }
      if (jupiterIndexes.length !== 1) return deny('UNSUPPORTED_ROUTE_INSTRUCTION');
      const ataCreations = validateEntryAuxiliaries(decodedInstructions,jupiterIndexes[0],
        this.walletPublicKey,mint,request.stakeLamports,
        final.prioritizationFeePayer === this.walletPublicKey ? final.prioritizationFeeLamports! : 0);
      if (ataCreations === null) return deny('UNSUPPORTED_ROUTE_INSTRUCTION');
      if (ataCreations > 0) {
        const rentResponse = await this.rpcHub.call('STATE','getMinimumBalanceForRentExemption',
          [165,{commitment:'confirmed'}],{bypassCache:true,signal:request.signal});
        await guard();
        if (!Number.isSafeInteger(rentResponse) || (rentResponse as number) < 0 ||
            entryFees.rent < (rentResponse as number) * ataCreations)
          return deny('ENTRY_FEE_RENT_CAPITAL');
      }
      transaction.signatures = transaction.signatures.map(() => new Uint8Array(64));
      const unsignedBase64 = Buffer.from(transaction.serialize()).toString('base64');
      await guard();
      const simulation = await this.rpcHub.call('CRITICAL','simulateTransaction',[unsignedBase64,{
        sigVerify:false,encoding:'base64',commitment:'confirmed',replaceRecentBlockhash:true,
        minContextSlot:freshPool.slot,innerInstructions:true
      }],{bypassCache:true,signal:request.signal});
      await guard();
      const simulated = simulation as {context?:{slot?:number};value?:{
        err?:unknown;unitsConsumed?:number;innerInstructions?:unknown}};
      const value = simulated.value;
      if (!value || value.err !== null) return deny('SIMULATION_REJECTED');
      if (!Number.isSafeInteger(simulated.context?.slot) || simulated.context!.slot! < freshPool.slot ||
          !hasBoundSwapCpi(value.innerInstructions,jupiterIndexes[0],freshPool,mint,this.walletPublicKey,
            BigInt(request.stakeLamports),positiveInteger(final.otherAmountThreshold)!))
        return deny('SIMULATION_ROUTE_UNPROVEN');
      if (Date.now() - freshAt > 15_000) return deny('STALE_OR_DRAINED_POOL_PROOF');
      return { accepted:true, order: { ...final, requestId:final.requestId, transaction:unsignedBase64,
        inAmount:final.inAmount!,outAmount:final.outAmount! }, evidence: {
        mintSlot:mintSlot as number,pool:freshPool,momentum,forwardOutAmount:out.toString(),
        forwardMinOutAmount:forwardMin.toString(),reverseMinOutLamports:minOut.toString(),
        adverseReverseMinOutLamports:adverseMin.toString(),roundTripLossPct:lossPct,
        takerNetworkFeeLamports:network,entryRentReserveLamports:entryFees.rent,
        simulationUnitsConsumed:Number.isFinite(value.unitsConsumed) ? value.unitsConsumed! : null
      } };
    } catch(error) {
      return deny(error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : 'PREFLIGHT_UNAVAILABLE');
    }
  }
}
