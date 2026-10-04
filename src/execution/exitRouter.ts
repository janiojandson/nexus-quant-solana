export type RoutedExitStatus =
  | 'SUCCESS'
  | 'DRY_RUN_SUCCESS'
  | 'FAILED'
  | 'SUBMITTED_UNCONFIRMED';

export type ExecutionConfirmationStage =
  | 'PROVIDER_RECEIPT'
  | 'CHAIN_CONFIRMED'
  | 'ECONOMICALLY_RECONCILED';

export interface ExecutionAmountMismatch {
  requestedAmountAtomic: number;
  executedAmountAtomic: number;
  deltaAtomic: number;
}

export interface RoutedExitAttempt {
  status: RoutedExitStatus;
  txSignature: string;
  inAmount: number;
  outAmount: number;
  error?: string;
  confirmationStage?: ExecutionConfirmationStage;
  requestedAmountAtomic?: number;
  executedInAmountAtomic?: number;
  actualDebitAtomic?: number;
  amountMismatch?: ExecutionAmountMismatch;
}

export type ExitRoutePath = 'JUPITER' | 'PUMP_DIRECT';

export interface ExitRouterResult {
  path: ExitRoutePath;
  result: RoutedExitAttempt;
  fallbackReason?:
    | 'JUPITER_DEFINITIVE_FAILURE'
    | 'JUPITER_UNCERTAIN_BLOCKS_FALLBACK'
    | 'PUMP_FALLBACK_DISABLED';
}

export interface ExitRouterOptions {
  pumpFallbackEnabled: boolean;
}

/**
 * Reconciles requested exit amount with the actual debit reported by the execution engine.
 * Emits an ExecutionAmountMismatch structure if the executed amount diverged.
 */
export function reconcileExecutionAmounts(
  requestedAmountAtomic: number,
  executedInAmountAtomic: number
): {
  actualDebitAtomic: number;
  amountMismatch?: ExecutionAmountMismatch;
} {
  const safeExecuted = Number.isSafeInteger(executedInAmountAtomic) && executedInAmountAtomic > 0
    ? executedInAmountAtomic
    : requestedAmountAtomic;

  if (requestedAmountAtomic !== safeExecuted) {
    return {
      actualDebitAtomic: safeExecuted,
      amountMismatch: {
        requestedAmountAtomic,
        executedAmountAtomic: safeExecuted,
        deltaAtomic: Math.abs(requestedAmountAtomic - safeExecuted)
      }
    };
  }

  return { actualDebitAtomic: safeExecuted };
}

export class ExitRouter {
  private readonly pumpFallbackEnabled: boolean;

  constructor(options: ExitRouterOptions) {
    this.pumpFallbackEnabled = Boolean(options.pumpFallbackEnabled);
  }

  isPumpFallbackEnabled(): boolean {
    return this.pumpFallbackEnabled;
  }

  async routeAfterJupiter(
    jupiterResult: RoutedExitAttempt,
    runPumpFallback: () => Promise<RoutedExitAttempt>
  ): Promise<ExitRouterResult> {
    if (
      jupiterResult.status === 'SUCCESS' ||
      jupiterResult.status === 'DRY_RUN_SUCCESS'
    ) {
      return { path: 'JUPITER', result: jupiterResult };
    }

    if (jupiterResult.status === 'SUBMITTED_UNCONFIRMED') {
      return {
        path: 'JUPITER',
        result: jupiterResult,
        fallbackReason: 'JUPITER_UNCERTAIN_BLOCKS_FALLBACK'
      };
    }

    if (!this.pumpFallbackEnabled) {
      return {
        path: 'JUPITER',
        result: jupiterResult,
        fallbackReason: 'PUMP_FALLBACK_DISABLED'
      };
    }

    const pumpResult = await runPumpFallback();
    return {
      path: 'PUMP_DIRECT',
      result: pumpResult,
      fallbackReason: 'JUPITER_DEFINITIVE_FAILURE'
    };
  }
}
