/**
 * Nexus Quant Solana — Financial Readiness Boot Fence (Finding R-P0-01)
 *
 * Implements strict startup fencing to prevent any financial mutations
 * (panic, position exit, liquidation, sweep) before the database is initialized,
 * schema validated, and all durable debts and positions rehydrated into safety guards.
 *
 * Lifecycle states:
 * - BOOTING: Process started, database not yet connected or initialized.
 * - RECOVERING_FINANCIAL_STATE: Database connected, rehydrating durable debts, positions, and locks.
 * - READY: All debts recovered, safety guards armed, mutations safe to accept.
 * - FAILED_SAFE: DB unreachable, schema missing/invalid, or debt recovery threw.
 *                All financial endpoints remain irreversibly blocked (HTTP 503).
 */

export type FinancialReadinessState =
  | 'BOOTING'
  | 'RECOVERING_FINANCIAL_STATE'
  | 'READY'
  | 'FAILED_SAFE';

export interface FinancialReadinessStatus {
  state: FinancialReadinessState;
  reason?: string;
  updatedAtMs: number;
}

let currentState: FinancialReadinessState = 'BOOTING';
let currentReason: string | undefined = 'Service initialization in progress';
let lastUpdatedAtMs: number = Date.now();

export class FinancialNotReadyError extends Error {
  public readonly readinessState: FinancialReadinessState;
  public readonly code: string = 'FINANCIAL_STATE_NOT_READY';

  constructor(state: FinancialReadinessState, reason?: string) {
    super(
      `FINANCIAL_STATE_NOT_READY: Financial mutations are blocked in state '${state}'. Reason: ${reason || 'Startup or recovery in progress'}`
    );
    this.name = 'FinancialNotReadyError';
    this.readinessState = state;
  }
}

export function getFinancialReadiness(): FinancialReadinessState {
  return currentState;
}

export function getFinancialReadinessStatus(): FinancialReadinessStatus {
  return {
    state: currentState,
    reason: currentReason,
    updatedAtMs: lastUpdatedAtMs
  };
}

export function setFinancialReadiness(state: FinancialReadinessState, reason?: string): void {
  currentState = state;
  currentReason = reason;
  lastUpdatedAtMs = Date.now();
  console.log(`🛡️ [FinancialReadiness] State changed to '${state}'${reason ? ` (reason: ${reason})` : ''}`);
}

export function assertFinancialReady(): void {
  if (currentState !== 'READY') {
    throw new FinancialNotReadyError(currentState, currentReason);
  }
}

export function isFinancialReady(): boolean {
  return currentState === 'READY';
}

/**
 * Identifies whether an incoming HTTP route and method represents a financial mutation
 * that could move funds, trigger swaps, liquidate holdings, or affect custody balances.
 */
export function isFinancialMutationEndpoint(pathname: string, method: string): boolean {
  const normMethod = (method || '').toUpperCase();
  if (normMethod !== 'POST' && normMethod !== 'PUT' && normMethod !== 'PATCH' && normMethod !== 'DELETE') {
    return false;
  }

  // Panic endpoints
  if (pathname.startsWith('/api/panic/')) {
    return true;
  }

  // Position exits & liquidations
  if (pathname.startsWith('/api/positions/')) {
    if (pathname.endsWith('/exit') || pathname === '/api/positions/liquidate-all') {
      return true;
    }
  }

  // Wallet holdings liquidation & rent sweep
  if (pathname === '/api/wallet/liquidate-holding' || pathname === '/api/wallet/sweep-rent') {
    return true;
  }

  return false;
}
