import type { JupiterPriority } from '../blockchain/jupiterTrafficCoordinator.js';

export interface WatchdogExitPlanInput {
  entrySol: number;
  tokenAmountAtomic: number;
}

export interface WatchdogExitPlan {
  exitReason: 'WATCHDOG_EXIT';
  pnlPct: number;
  exitSolValue: number;
  options: {
    exitTokenAmount: number;
    shouldCloseAta: true;
    trafficPriority: JupiterPriority;
    initialSlippageBps: number;
  };
}

export function buildWatchdogExitPlan(input: WatchdogExitPlanInput): WatchdogExitPlan {
  const entrySol = Number.isFinite(input.entrySol) && input.entrySol > 0 ? input.entrySol : 0.015;
  return {
    exitReason: 'WATCHDOG_EXIT',
    pnlPct: -0.20,
    // Valor conservador apenas para evitar nova quote antes do /order de emergência.
    // O executor substitui o resultado contábil pelo outAmount realmente confirmado.
    exitSolValue: Math.max(1e-9, entrySol * 0.80),
    options: {
      exitTokenAmount: input.tokenAmountAtomic,
      shouldCloseAta: true,
      trafficPriority: 0,
      initialSlippageBps: 600
    }
  };
}
