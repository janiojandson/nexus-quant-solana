/**
 * Nexus Quant Solana — Financial Exit Safety Guard
 *
 * Unified pre-execution safety layer for ALL SELL / EXIT operations:
 * - Automated monitor exits (SL, TP, Trailing, Time-Stop)
 * - Watchdog defensive exits
 * - Manual individual exits (/api/positions/:mint/exit and /api/panic/:mint)
 * - Panic-all liquidations (/api/positions/liquidate-all and /api/panic/all)
 * - Direct holding liquidations (/api/wallet/liquidate-holding)
 *
 * Mandatory checks before any irreversible financial attempt:
 * 1. In-flight collision lock (no overlapping sells on the same mint/position).
 * 2. Unresolved execution debt / uncertain mints (both in-memory and persistent DB).
 * 3. Atomic amount validation (strictly bigint > 0n, no unsafe float math).
 * 4. Safe BigInt to Number coercion (asserts <= Number.MAX_SAFE_INTEGER).
 */

export interface ExitSafetyValidationResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly code?:
    | 'IN_FLIGHT_COLLISION'
    | 'UNRESOLVED_RECONCILIATION_DEBT'
    | 'INVALID_ATOMIC_AMOUNT'
    | 'EXCEEDS_SAFE_INTEGER_LIMIT'
    | 'POSITION_NOT_FOUND';
}

export class FinancialExitSafetyGuard {
  private inFlightMints = new Set<string>();
  private persistentUnresolvedMints = new Set<string>();

  /**
   * Registers a mint with persistent unresolved execution debt (loaded at boot or on runtime timeout).
   */
  public registerUnresolvedDebt(mint: string): void {
    this.persistentUnresolvedMints.add(mint);
  }

  /**
   * Clears unresolved debt after confirmed on-chain reconciliation.
   */
  public clearUnresolvedDebt(mint: string): void {
    this.persistentUnresolvedMints.delete(mint);
  }

  /**
   * Alias for clearUnresolvedDebt.
   */
  public clearDebt(mint: string): void {
    this.clearUnresolvedDebt(mint);
  }

  /**
   * Returns whether a mint currently has unresolved execution debt.
   */
  public hasUnresolvedDebt(mint: string): boolean {
    return this.persistentUnresolvedMints.has(mint);
  }

  /**
   * Returns all mints currently blocked by unresolved debt.
   */
  public getUnresolvedDebtMints(): string[] {
    return Array.from(this.persistentUnresolvedMints);
  }

  /**
   * Acquires execution lock for a mint.
   * Throws or returns validation failure if collision or debt exists.
   */
  public acquireExitLock(mint: string, amountAtomic: bigint): ExitSafetyValidationResult {
    if (this.inFlightMints.has(mint)) {
      return {
        allowed: false,
        code: 'IN_FLIGHT_COLLISION',
        reason: `EXIT_ALREADY_IN_FLIGHT: A sell transaction is already in flight for mint ${mint}.`
      };
    }

    if (this.persistentUnresolvedMints.has(mint)) {
      return {
        allowed: false,
        code: 'UNRESOLVED_RECONCILIATION_DEBT',
        reason: `UNRESOLVED_EXECUTION_DEBT: Mint ${mint} has pending uncertain state or reconciliation debt. New sells blocked until reconciled.`
      };
    }

    if (amountAtomic <= 0n) {
      return {
        allowed: false,
        code: 'INVALID_ATOMIC_AMOUNT',
        reason: `INVALID_ATOMIC_AMOUNT: Exit amount must be strictly greater than 0, received ${amountAtomic}.`
      };
    }

    this.inFlightMints.add(mint);
    return { allowed: true };
  }

  /**
   * Releases execution lock for a mint.
   */
  public releaseExitLock(mint: string): void {
    this.inFlightMints.delete(mint);
  }

  /**
   * Safely checks whether a sell can proceed without acquiring lock.
   */
  public validateExit(mint: string, amountAtomic: bigint): ExitSafetyValidationResult {
    if (this.inFlightMints.has(mint)) {
      return {
        allowed: false,
        code: 'IN_FLIGHT_COLLISION',
        reason: `EXIT_ALREADY_IN_FLIGHT: A sell transaction is already in flight for mint ${mint}.`
      };
    }

    if (this.persistentUnresolvedMints.has(mint)) {
      return {
        allowed: false,
        code: 'UNRESOLVED_RECONCILIATION_DEBT',
        reason: `UNRESOLVED_EXECUTION_DEBT: Mint ${mint} has pending uncertain state or reconciliation debt.`
      };
    }

    if (amountAtomic <= 0n) {
      return {
        allowed: false,
        code: 'INVALID_ATOMIC_AMOUNT',
        reason: `INVALID_ATOMIC_AMOUNT: Exit amount must be strictly greater than 0, received ${amountAtomic}.`
      };
    }

    return { allowed: true };
  }

  /**
   * Boolean check for safe exit status (used in tests and runtime inspection).
   */
  public checkSafeToExit(mint: string, amountAtomic: bigint = 1n): { canExit: boolean; reason?: string; code?: string } {
    const res = this.validateExit(mint, amountAtomic);
    return {
      canExit: res.allowed,
      reason: res.code === 'UNRESOLVED_RECONCILIATION_DEBT' ? 'UNRESOLVED_EXIT_DEBT' : res.code,
      code: res.code
    };
  }
}

/**
 * Global singleton safety guard instance.
 */
export const financialExitSafetyGuard = new FinancialExitSafetyGuard();

/**
 * Safely converts a BigInt atomic amount to a JavaScript Number.
 * Throws TypeError if value exceeds Number.MAX_SAFE_INTEGER to prevent silent precision loss.
 */
export function safeBigIntToNumber(value: bigint, context: string = 'financial_amount'): number {
  if (value < 0n) {
    throw new TypeError(`safeBigIntToNumber: Negative value not permitted for ${context}: ${value}`);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `safeBigIntToNumber: Atomic value ${value} exceeds Number.MAX_SAFE_INTEGER (9007199254740991) in ${context}. Unsafe float conversion rejected.`
    );
  }
  return Number(value);
}

/**
 * Safely parses an atomic amount from string or bigint.
 */
export function parseAtomicAmountBigInt(rawAmount: string | number | bigint): bigint {
  if (typeof rawAmount === 'bigint') {
    return rawAmount;
  }
  if (typeof rawAmount === 'number') {
    if (!Number.isSafeInteger(rawAmount)) {
      throw new RangeError(
        `parseAtomicAmountBigInt: Number ${rawAmount} is not a safe integer. Rejecting imprecise conversion.`
      );
    }
    return BigInt(Math.trunc(rawAmount));
  }
  if (typeof rawAmount === 'string') {
    const trimmed = rawAmount.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new TypeError(`parseAtomicAmountBigInt: Invalid atomic string "${rawAmount}".`);
    }
    return BigInt(trimmed);
  }
  throw new TypeError(`parseAtomicAmountBigInt: Unsupported type for atomic amount: ${typeof rawAmount}`);
}
