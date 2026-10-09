import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction
} from '@solana/web3.js';
import { resolveExecutionMode, type ExecutionEnvironment } from '../execution/executionMode.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from '@solana/spl-token';
import { PUMP_PROGRAM_ID, derivePumpBondingCurvePda } from './pumpBondingCurve.js';
import {
  PUMP_BUYBACK_FEE_RECIPIENTS,
  PUMP_MAYHEM_FEE_RECIPIENTS,
  PUMP_NORMAL_FEE_RECIPIENTS,
  decodePumpSellBondingCurveState,
  validatePumpSellState
} from './pumpSellValidator.js';
import {
  PUMP_DIRECT_SELL_MAX_SLIPPAGE_BPS,
  quotePumpBondingCurveSell,
  type PumpSellQuote
} from './pumpSellQuote.js';

export const PUMP_FEE_PROGRAM_ID = new PublicKey(
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'
);
export const PUMP_SELL_V2_DISCRIMINATOR = Buffer.from([
  93, 246, 130, 60, 231, 233, 64, 178
]);
export const PUMP_DIRECT_SELL_MAX_PRIORITY_FEE_MICROLAMPORTS = 1_000_000;
export const PUMP_DIRECT_SELL_COMPUTE_UNIT_LIMIT = 400_000;
export const PUMP_DIRECT_SELL_DEFAULT_FEE_BPS = 125;
const U64_MAX = (1n << 64n) - 1n;

export interface PumpSellExecutorConnection {
  getAccountInfo(key: PublicKey, commitment?: unknown): Promise<{ owner: PublicKey; data: Buffer } | null>;
  getLatestBlockhash(commitment?: unknown): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  simulateTransaction(transaction: VersionedTransaction, options: { sigVerify: false }): Promise<{ value: { err: unknown; unitsConsumed?: number } }>;
  sendRawTransaction(rawTransaction: Buffer | Uint8Array, options?: unknown): Promise<string>;
  confirmTransaction(
    strategy: { signature: string; blockhash: string; lastValidBlockHeight: number },
    commitment?: unknown
  ): Promise<{ value: { err: unknown } }>;
}

export interface PumpSellRequest {
  mint: PublicKey;
  userKeypair?: Keypair;
  userPublicKey?: PublicKey;
  tokenAmountAtomic: bigint;
  slippageBps?: number;
  totalFeeBps?: number;
  priorityFeeMicroLamports?: number;
  feeRecipient?: PublicKey;
  buybackFeeRecipient?: PublicKey;
}

export interface PumpBuiltSell {
  transaction: Transaction;
  quote: PumpSellQuote;
  feeRecipient: PublicKey;
  buybackFeeRecipient: PublicKey;
  blockhash: string;
  lastValidBlockHeight: number;
  bondingCurve: PublicKey;
}

export interface PumpSellExecutionResult {
  status: 'SUCCESS' | 'FAILED' | 'SUBMITTED_UNCONFIRMED';
  hypothetical?: boolean;
  txSignature?: string;
  expectedNetSolLamports?: bigint;
  minSolOutputLamports?: bigint;
  actualReceivedLamports?: bigint;
  unitsConsumed?: number;
  reconciled?: boolean;
  error?: string;
}

export interface PumpSellReconciledTrade {
  signature: string;
  soldAtomic: bigint;
  receivedLamports?: bigint;
}

export interface PumpSellReconciler {
  reconcileRecentSell(
    mintAddress: string,
    sinceTimestampMs: number,
    expectedAmountAtomic: bigint
  ): Promise<PumpSellReconciledTrade | null>;
}

export function derivePumpGlobalPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('global')],
    PUMP_PROGRAM_ID
  )[0];
}

export function derivePumpFeeConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config'), PUMP_PROGRAM_ID.toBuffer()],
    PUMP_FEE_PROGRAM_ID
  )[0];
}

export function derivePumpSharingConfigPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('sharing-config'), mint.toBuffer()],
    PUMP_FEE_PROGRAM_ID
  )[0];
}

export function derivePumpCreatorVaultPda(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMP_PROGRAM_ID
  )[0];
}

export function derivePumpUserVolumeAccumulatorPda(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMP_PROGRAM_ID
  )[0];
}

export function derivePumpEventAuthorityPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PUMP_PROGRAM_ID
  )[0];
}

function u64Buffer(value: bigint): Buffer {
  if (value < 0n || value > U64_MAX) {
    throw new Error('Pump direct sell amount/min-out exceeds u64 range.');
  }
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
}

function assertRequestCaps(request: PumpSellRequest): {
  slippageBps: number;
  priorityFeeMicroLamports: number;
  totalFeeBps: number;
} {
  if (request.tokenAmountAtomic <= 0n || request.tokenAmountAtomic > U64_MAX) {
    throw new Error('Pump direct sell token amount must be a positive u64 atomic amount.');
  }
  const slippageBps = request.slippageBps ?? 500;
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > PUMP_DIRECT_SELL_MAX_SLIPPAGE_BPS
  ) {
    throw new Error(
      `Pump direct sell slippage exceeds hard cap ${PUMP_DIRECT_SELL_MAX_SLIPPAGE_BPS} bps.`
    );
  }
  const priorityFeeMicroLamports = request.priorityFeeMicroLamports ?? 100_000;
  if (
    !Number.isInteger(priorityFeeMicroLamports) ||
    priorityFeeMicroLamports < 0 ||
    priorityFeeMicroLamports > PUMP_DIRECT_SELL_MAX_PRIORITY_FEE_MICROLAMPORTS
  ) {
    throw new Error(
      `Pump direct sell priority fee exceeds cap ${PUMP_DIRECT_SELL_MAX_PRIORITY_FEE_MICROLAMPORTS} micro-lamports/CU.`
    );
  }
  const totalFeeBps = request.totalFeeBps ?? PUMP_DIRECT_SELL_DEFAULT_FEE_BPS;
  if (!Number.isFinite(totalFeeBps) || totalFeeBps < 0 || totalFeeBps >= 10_000) {
    throw new Error('Pump direct sell total fee bps is invalid.');
  }
  return { slippageBps, priorityFeeMicroLamports, totalFeeBps };
}

export class PumpSellExecutor {
  constructor(
    private readonly connection: PumpSellExecutorConnection,
    private readonly reconciler?: PumpSellReconciler,
    private readonly executionEnv: ExecutionEnvironment = process.env
  ) {}

  async buildSell(request: PumpSellRequest): Promise<PumpBuiltSell> {
    const caps = assertRequestCaps(request);
    const user = request.userPublicKey ?? request.userKeypair?.publicKey;
    if (!user) throw new Error('Pump direct sell public owner is required.');
    const bondingCurve = derivePumpBondingCurvePda(request.mint);

    const [mintInfo, curveInfo] = await Promise.all([
      this.connection.getAccountInfo(request.mint, 'confirmed'),
      this.connection.getAccountInfo(bondingCurve, 'confirmed')
    ]);
    if (!mintInfo) throw new Error('Pump direct sell mint account is missing.');
    if (!curveInfo) throw new Error('Pump direct sell bonding curve account is missing.');

    const baseTokenProgram = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : mintInfo.owner.equals(TOKEN_PROGRAM_ID)
        ? TOKEN_PROGRAM_ID
        : null;
    if (!baseTokenProgram) {
      throw new Error(`Pump direct sell unsupported mint token program: ${mintInfo.owner.toBase58()}.`);
    }

    const decoded = decodePumpSellBondingCurveState(curveInfo.data);
    if (!decoded) throw new Error('Pump direct sell bonding curve cannot be decoded fail-closed.');

    const feeRecipient = request.feeRecipient ??
      (decoded.isMayhemMode ? PUMP_MAYHEM_FEE_RECIPIENTS : PUMP_NORMAL_FEE_RECIPIENTS)[0];
    const buybackFeeRecipient = request.buybackFeeRecipient ?? PUMP_BUYBACK_FEE_RECIPIENTS[0];

    const userBaseAta = getAssociatedTokenAddressSync(
      request.mint,
      user,
      false,
      baseTokenProgram
    );
    const curveBaseAta = getAssociatedTokenAddressSync(
      request.mint,
      bondingCurve,
      true,
      baseTokenProgram
    );

    const [userAtaInfo, curveAtaInfo, globalInfo, feeConfigInfo] = await Promise.all([
      this.connection.getAccountInfo(userBaseAta, 'confirmed'),
      this.connection.getAccountInfo(curveBaseAta, 'confirmed'),
      this.connection.getAccountInfo(derivePumpGlobalPda(), 'confirmed'),
      this.connection.getAccountInfo(derivePumpFeeConfigPda(), 'confirmed')
    ]);

    if (!userAtaInfo) throw new Error('Pump direct sell user base ATA is missing.');
    if (!curveAtaInfo) throw new Error('Pump direct sell bonding-curve base ATA is missing.');
    if (!globalInfo || !globalInfo.owner.equals(PUMP_PROGRAM_ID)) {
      throw new Error('Pump direct sell Global PDA missing or wrong program owner.');
    }
    if (!feeConfigInfo || !feeConfigInfo.owner.equals(PUMP_FEE_PROGRAM_ID)) {
      throw new Error('Pump direct sell FeeConfig PDA missing or wrong fee-program owner.');
    }

    const validation = validatePumpSellState({
      mint: request.mint,
      user,
      bondingCurve,
      bondingCurveAccount: curveInfo,
      mintAccountOwner: mintInfo.owner,
      baseTokenProgram,
      userBaseAta,
      userBaseAtaAccountOwner: userAtaInfo.owner,
      curveBaseAta,
      curveBaseAtaAccountOwner: curveAtaInfo.owner,
      feeRecipient,
      buybackFeeRecipient
    });
    if (!validation.ok || !validation.state) {
      throw new Error(`Pump direct sell validation failed: ${validation.reason || 'unknown'}`);
    }

    const state = validation.state;
    const quote = quotePumpBondingCurveSell({
      tokenAmountAtomic: request.tokenAmountAtomic,
      virtualTokenReserves: state.virtualTokenReserves,
      virtualSolReserves: state.virtualSolReserves,
      totalFeeBps: caps.totalFeeBps,
      slippageBps: caps.slippageBps
    });

    const creatorVault = derivePumpCreatorVaultPda(state.creator);
    const sharingConfig = derivePumpSharingConfigPda(request.mint);
    const userVolumeAccumulator = derivePumpUserVolumeAccumulatorPda(user);
    const sharingInfo = await this.connection.getAccountInfo(sharingConfig, 'confirmed');
    if (sharingInfo && !sharingInfo.owner.equals(PUMP_FEE_PROGRAM_ID)) {
      throw new Error('Pump direct sell SharingConfig owner is not the Pump fee program.');
    }

    const associatedQuoteFeeRecipient = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      feeRecipient,
      true,
      TOKEN_PROGRAM_ID
    );
    const associatedQuoteBuybackFeeRecipient = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      buybackFeeRecipient,
      true,
      TOKEN_PROGRAM_ID
    );
    const associatedQuoteBondingCurve = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      bondingCurve,
      true,
      TOKEN_PROGRAM_ID
    );
    const associatedQuoteUser = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      user,
      false,
      TOKEN_PROGRAM_ID
    );
    const associatedCreatorVault = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      creatorVault,
      true,
      TOKEN_PROGRAM_ID
    );
    const associatedUserVolumeAccumulator = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      userVolumeAccumulator,
      true,
      TOKEN_PROGRAM_ID
    );

    const instructionData = Buffer.concat([
      PUMP_SELL_V2_DISCRIMINATOR,
      u64Buffer(request.tokenAmountAtomic),
      u64Buffer(quote.minSolOutputLamports)
    ]);

    const sellInstruction = new TransactionInstruction({
      programId: PUMP_PROGRAM_ID,
      keys: [
        { pubkey: derivePumpGlobalPda(), isSigner: false, isWritable: false },
        { pubkey: request.mint, isSigner: false, isWritable: false },
        { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
        { pubkey: baseTokenProgram, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: feeRecipient, isSigner: false, isWritable: true },
        { pubkey: associatedQuoteFeeRecipient, isSigner: false, isWritable: true },
        { pubkey: buybackFeeRecipient, isSigner: false, isWritable: true },
        { pubkey: associatedQuoteBuybackFeeRecipient, isSigner: false, isWritable: true },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: curveBaseAta, isSigner: false, isWritable: true },
        { pubkey: associatedQuoteBondingCurve, isSigner: false, isWritable: true },
        { pubkey: user, isSigner: true, isWritable: true },
        { pubkey: userBaseAta, isSigner: false, isWritable: true },
        { pubkey: associatedQuoteUser, isSigner: false, isWritable: true },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: associatedCreatorVault, isSigner: false, isWritable: true },
        { pubkey: sharingConfig, isSigner: false, isWritable: false },
        { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
        { pubkey: associatedUserVolumeAccumulator, isSigner: false, isWritable: true },
        { pubkey: derivePumpFeeConfigPda(), isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: derivePumpEventAuthorityPda(), isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
      ],
      data: instructionData
    });

    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('confirmed');

    const transaction = new Transaction({
      feePayer: user,
      recentBlockhash: blockhash
    });
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: PUMP_DIRECT_SELL_COMPUTE_UNIT_LIMIT
      })
    );
    if (caps.priorityFeeMicroLamports > 0) {
      transaction.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: caps.priorityFeeMicroLamports
        })
      );
    }
    transaction.add(sellInstruction);

    return {
      transaction,
      quote,
      feeRecipient,
      buybackFeeRecipient,
      blockhash,
      lastValidBlockHeight,
      bondingCurve
    };
  }

  async simulateSell(request: PumpSellRequest): Promise<{
    success: boolean;
    hypothetical: true;
    built?: PumpBuiltSell;
    unitsConsumed?: number;
    error?: string;
  }> {
    try {
      const built = await this.buildSell(request);
      const unsigned = new VersionedTransaction(built.transaction.compileMessage());
      const simulation = await this.connection.simulateTransaction(unsigned, { sigVerify: false });
      if (simulation.value.err) {
        return {
          success: false,
          hypothetical: true,
          built,
          unitsConsumed: simulation.value.unitsConsumed,
          error: `Pump direct sell simulation rejected: ${JSON.stringify(simulation.value.err)}`
        };
      }
      return {
        success: true,
        hypothetical: true,
        built,
        unitsConsumed: simulation.value.unitsConsumed
      };
    } catch (err: any) {
      return { success: false, hypothetical: true, error: err?.message || String(err) };
    }
  }

  async executeSell(request: PumpSellRequest): Promise<PumpSellExecutionResult> {
    const simulation = await this.simulateSell(request);
    if (!simulation.success || !simulation.built) {
      return {
        status: 'FAILED',
        hypothetical: resolveExecutionMode(this.executionEnv).shadow,
        unitsConsumed: simulation.unitsConsumed,
        error: simulation.error || 'Pump direct sell simulation failed.'
      };
    }

    if (!resolveExecutionMode(this.executionEnv).canBroadcast) {
      return {
        status: 'FAILED', hypothetical: true,
        expectedNetSolLamports: simulation.built.quote.netSolLamports,
        minSolOutputLamports: simulation.built.quote.minSolOutputLamports,
        unitsConsumed: simulation.unitsConsumed,
        error: 'Shadow simulation only; no sale submitted.'
      };
    }
    if (!request.userKeypair) {
      return { status: 'FAILED', error: 'Pump direct sell signer required for live execution.' };
    }

    const built = simulation.built;
    if (!resolveExecutionMode(this.executionEnv).canSign) {
      return { status: 'FAILED', hypothetical: true, error: 'Shadow mode blocks Pump signing.' };
    }
    built.transaction.sign(request.userKeypair);
    const submissionStartedAt = Date.now();
    try {
      if (!resolveExecutionMode(this.executionEnv).canBroadcast) {
        return { status: 'FAILED', hypothetical: true, error: 'Shadow mode blocks Pump broadcast.' };
      }
      const txSignature = await this.connection.sendRawTransaction(
        built.transaction.serialize(),
        { skipPreflight: false, maxRetries: 0 }
      );
      const confirmation = await this.connection.confirmTransaction(
        {
          signature: txSignature,
          blockhash: built.blockhash,
          lastValidBlockHeight: built.lastValidBlockHeight
        },
        'confirmed'
      );
      if (confirmation.value.err) {
        return {
          status: 'FAILED',
          txSignature,
          expectedNetSolLamports: built.quote.netSolLamports,
          minSolOutputLamports: built.quote.minSolOutputLamports,
          unitsConsumed: simulation.unitsConsumed,
          error: `Pump direct sell confirmation failed: ${JSON.stringify(confirmation.value.err)}`
        };
      }
      return {
        status: 'SUCCESS',
        txSignature,
        expectedNetSolLamports: built.quote.netSolLamports,
        minSolOutputLamports: built.quote.minSolOutputLamports,
        unitsConsumed: simulation.unitsConsumed
      };
    } catch (err: any) {
      const detail = err?.message || String(err);

      if (this.reconciler) {
        try {
          const reconciled = await this.reconciler.reconcileRecentSell(
            request.mint.toBase58(),
            submissionStartedAt,
            request.tokenAmountAtomic
          );
          if (
            reconciled &&
            reconciled.soldAtomic === request.tokenAmountAtomic &&
            reconciled.signature
          ) {
            return {
              status: 'SUCCESS',
              txSignature: reconciled.signature,
              expectedNetSolLamports: built.quote.netSolLamports,
              minSolOutputLamports: built.quote.minSolOutputLamports,
              actualReceivedLamports: reconciled.receivedLamports,
              unitsConsumed: simulation.unitsConsumed,
              reconciled: true
            };
          }
        } catch {
          // Reconciliation failure must not trigger a duplicate sell.
        }
      }

      return {
        status: 'SUBMITTED_UNCONFIRMED',
        expectedNetSolLamports: built.quote.netSolLamports,
        minSolOutputLamports: built.quote.minSolOutputLamports,
        unitsConsumed: simulation.unitsConsumed,
        reconciled: false,
        error:
          `Pump direct sell submission is uncertain (${detail}); do not retry until on-chain reconciliation completes.`
      };
    }
  }
}
