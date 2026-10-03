export type RoutedExitStatus =
  | 'SUCCESS'
  | 'DRY_RUN_SUCCESS'
  | 'FAILED'
  | 'SUBMITTED_UNCONFIRMED';

export interface RoutedExitAttempt {
  status: RoutedExitStatus;
  txSignature: string;
  inAmount: number;
  outAmount: number;
  error?: string;
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
