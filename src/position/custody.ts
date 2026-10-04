/**
 * Nexus Quant Solana — V2.3-R Custody Policy & Canonical ATA Verification (Commit R4)
 *
 * Implements:
 * - P1-08: Formal CANONICAL_ATA_STRICT custody policy rejecting ambiguous non-ATA accounts.
 * - P1-09: reconcilePositionCustody detecting external balance shifts, bumping version, and blocking old quotes.
 */

import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
  PositionVersion,
  DurablePosition,
  PositionMutationRecord,
  DEFAULT_TOKEN_PROGRAM_ID,
  AmbiguousTokenAccountCustodyError,
  ReconciliationEvidenceMetadata
} from './types.js';
import { IPositionRepository } from './repository.js';

export const CUSTODY_POLICY = 'CANONICAL_ATA_STRICT' as const;

/**
 * Derives the canonical Associated Token Address for a given wallet and mint.
 */
export function deriveCanonicalAta(
  walletId: string,
  mint: string,
  tokenProgramId: string = DEFAULT_TOKEN_PROGRAM_ID
): string {
  const walletPubkey = new PublicKey(walletId);
  const mintPubkey = new PublicKey(mint);
  const programPubkey = new PublicKey(tokenProgramId);

  const ata = getAssociatedTokenAddressSync(
    mintPubkey,
    walletPubkey,
    false, // allowOwnerOffCurve = false: strict canonical ATA
    programPubkey
  );

  return ata.toBase58();
}

/**
 * Validates that an account address matches the deterministic canonical ATA.
 * Rejects ambiguous non-ATA accounts (P1-08).
 */
export function assertCanonicalAtaCustody(
  walletId: string,
  mint: string,
  tokenAccountAddress: string,
  tokenProgramId: string = DEFAULT_TOKEN_PROGRAM_ID
): void {
  const canonicalAta = deriveCanonicalAta(walletId, mint, tokenProgramId);
  if (tokenAccountAddress !== canonicalAta) {
    throw new AmbiguousTokenAccountCustodyError(
      `Custody account ${tokenAccountAddress} is not the canonical ATA for wallet ${walletId} and mint ${mint} (expected ${canonicalAta}). Non-canonical or ambiguous accounts are rejected under CANONICAL_ATA_STRICT policy.`,
      walletId,
      mint,
      {
        providedAccount: tokenAccountAddress,
        canonicalAta,
        tokenProgramId
      }
    );
  }
}

export interface ReconcilePositionCustodyInput {
  positionRepo: IPositionRepository;
  positionId: string;
  expectedVersion: PositionVersion;
  observedAtaBalanceAtomic: bigint;
  evidence: ReconciliationEvidenceMetadata;
  client?: any;
}

export interface CustodyReconciliationResult {
  divergenceDetected: boolean;
  deltaAtomic: bigint;
  previousBalanceAtomic: bigint;
  newBalanceAtomic: bigint;
  previousVersion: PositionVersion;
  newVersion: PositionVersion;
  position: DurablePosition;
  mutation?: PositionMutationRecord;
}

/**
 * Reconciles on-chain custody balance with durable position balance (P1-09).
 * If on-chain balance matches, returns without mutation or version bump.
 * If divergence is detected:
 * - records RECONCILIATION_ADJUSTMENT mutation
 * - increments version by 1
 * - automatically invalidates any pre-existing quotes bound to the old version
 */
export async function reconcilePositionCustody(
  input: ReconcilePositionCustodyInput
): Promise<CustodyReconciliationResult> {
  const position = await input.positionRepo.getPosition(input.positionId, input.client);
  if (!position) {
    throw new Error(`Position ${input.positionId} not found`);
  }

  if (position.positionVersion !== input.expectedVersion) {
    throw new Error(
      `Stale version for custody reconciliation: expected ${input.expectedVersion}, found ${position.positionVersion}`
    );
  }

  const previousBalanceAtomic = position.tokenAmountAtomic;
  const observed = input.observedAtaBalanceAtomic;

  if (observed === previousBalanceAtomic) {
    return {
      divergenceDetected: false,
      deltaAtomic: 0n,
      previousBalanceAtomic,
      newBalanceAtomic: observed,
      previousVersion: position.positionVersion,
      newVersion: position.positionVersion,
      position
    };
  }

  // Divergence detected: apply reconciliation adjustment
  const res = await input.positionRepo.applyReconciliationAdjustment(
    {
      positionId: input.positionId,
      expectedVersion: input.expectedVersion,
      observedBalanceAtomic: observed,
      evidence: input.evidence
    },
    input.client
  );

  return {
    divergenceDetected: true,
    deltaAtomic: observed - previousBalanceAtomic,
    previousBalanceAtomic,
    newBalanceAtomic: observed,
    previousVersion: input.expectedVersion,
    newVersion: res.position.positionVersion,
    position: res.position,
    mutation: res.mutation
  };
}
