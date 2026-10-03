export interface ExitPathPoint {
  atMs: number;
  valueSol: number;
}

export interface ProfitLock {
  peakPct: number;
  floorPct: number;
}

export interface ExitReplayPolicy {
  name: string;
  stopLossPct: number;
  earlyTrailingTriggerPct: number;
  earlyTrailingDistance: number;
  partialTakeProfitPct: number;
  partialFraction: number;
  runnerTrailingDistance: number;
  profitLocks?: ProfitLock[];
}

export interface ExitReplayCosts {
  feeBps: number;
  slippageBps: number;
  entryCostSol?: number;
  exitCostSol?: number;
}

export interface ExitReplayResult {
  policy: string;
  capturedNetSol: number;
  netReturnPct: number;
  maxGiveBackFromPeakPct: number;
  realizedSlippageSol: number;
  prematureExit: boolean;
  exitReason: 'STOP_LOSS' | 'TRAILING_STOP' | 'PROFIT_LOCK' | 'END_OF_PATH';
  exitAtMs: number;
}

export const BASELINE_CURRENT: ExitReplayPolicy = {
  name: 'BASELINE_CURRENT',
  stopLossPct: -0.06,
  earlyTrailingTriggerPct: 0.08,
  earlyTrailingDistance: 0.06,
  partialTakeProfitPct: 0.35,
  partialFraction: 0.50,
  runnerTrailingDistance: 0.10
};

export const TIERED_PROFIT_LOCK: ExitReplayPolicy = {
  ...BASELINE_CURRENT,
  name: 'TIERED_PROFIT_LOCK',
  // Shadow candidates: at activation these floors are tighter than the 10%
  // runner, so this policy can produce evidence distinct from the baseline.
  profitLocks: [
    { peakPct: 0.50, floorPct: 0.40 },
    { peakPct: 1.00, floorPct: 0.85 },
    { peakPct: 2.00, floorPct: 1.80 },
    { peakPct: 3.00, floorPct: 2.70 }
  ]
};

export const PARTIAL_HARVEST_EARLIER: ExitReplayPolicy = {
  ...BASELINE_CURRENT,
  name: 'PARTIAL_HARVEST_EARLIER',
  partialTakeProfitPct: 0.20,
  partialFraction: 0.35
};

// Research-only alternatives: these do not alter the live position exit engine.
export const STOP_ONLY: ExitReplayPolicy = {
  ...BASELINE_CURRENT,
  name: 'STOP_ONLY',
  earlyTrailingTriggerPct: Infinity,
  partialTakeProfitPct: Infinity,
  partialFraction: 0
};

export const RUNNER_ONLY: ExitReplayPolicy = {
  ...BASELINE_CURRENT,
  name: 'RUNNER_ONLY',
  earlyTrailingTriggerPct: BASELINE_CURRENT.partialTakeProfitPct,
  earlyTrailingDistance: BASELINE_CURRENT.runnerTrailingDistance,
  partialTakeProfitPct: Infinity,
  partialFraction: 0
};

export const SHADOW_EXIT_POLICIES: readonly ExitReplayPolicy[] = [
  STOP_ONLY,
  BASELINE_CURRENT,
  PARTIAL_HARVEST_EARLIER,
  RUNNER_ONLY,
  TIERED_PROFIT_LOCK
];

function netSale(grossSol: number, fraction: number, costs: ExitReplayCosts): { net: number; slip: number } {
  const gross = Math.max(0, grossSol) * Math.max(0, Math.min(1, fraction));
  const slip = gross * Math.max(0, costs.slippageBps) / 10_000;
  const fee = gross * Math.max(0, costs.feeBps) / 10_000;
  const transactionCost = Math.max(0, costs.exitCostSol ?? 0);
  return { net: Math.max(0, gross - slip - fee) - transactionCost, slip };
}

export function replayExitPolicy(
  path: ExitPathPoint[],
  policy: ExitReplayPolicy,
  costs: ExitReplayCosts
): ExitReplayResult {
  if (path.length === 0 || !Number.isFinite(path[0].valueSol) || path[0].valueSol <= 0) {
    throw new Error('Exit replay requires a positive entry value.');
  }

  const entry = path[0].valueSol;
  let peak = entry;
  let partialTaken = false;
  let remainingFraction = 1;
  let capturedNetSol = -Math.max(0, costs.entryCostSol ?? 0);
  let realizedSlippageSol = 0;
  let exitIndex = path.length - 1;
  let exitReason: ExitReplayResult['exitReason'] = 'END_OF_PATH';
  let fullyExited = false;

  for (let i = 1; i < path.length; i++) {
    const point = path[i];
    peak = Math.max(peak, point.valueSol);
    const pnlPct = (point.valueSol - entry) / entry;
    const peakPct = (peak - entry) / entry;

    if (!partialTaken && policy.partialFraction > 0 && pnlPct >= policy.partialTakeProfitPct) {
      const sale = netSale(point.valueSol, policy.partialFraction, costs);
      capturedNetSol += sale.net;
      realizedSlippageSol += sale.slip;
      remainingFraction -= policy.partialFraction;
      partialTaken = true;
    }

    let trigger: ExitReplayResult['exitReason'] | undefined;
    if (pnlPct <= policy.stopLossPct) {
      trigger = 'STOP_LOSS';
    } else {
      const locks = [...(policy.profitLocks ?? [])]
        .filter(lock => peakPct >= lock.peakPct)
        .sort((a, b) => b.peakPct - a.peakPct);
      if (locks[0] && pnlPct <= locks[0].floorPct) {
        trigger = 'PROFIT_LOCK';
      } else if (
        partialTaken &&
        point.valueSol <= peak * (1 - policy.runnerTrailingDistance)
      ) {
        trigger = 'TRAILING_STOP';
      } else if (
        !partialTaken &&
        peakPct >= policy.earlyTrailingTriggerPct &&
        point.valueSol <= peak * (1 - policy.earlyTrailingDistance)
      ) {
        trigger = 'TRAILING_STOP';
      }
    }

    if (trigger) {
      const sale = netSale(point.valueSol, remainingFraction, costs);
      capturedNetSol += sale.net;
      realizedSlippageSol += sale.slip;
      remainingFraction = 0;
      exitIndex = i;
      exitReason = trigger;
      fullyExited = true;
      break;
    }
  }

  if (!fullyExited) {
    const last = path[path.length - 1];
    const sale = netSale(last.valueSol, remainingFraction, costs);
    capturedNetSol += sale.net;
    realizedSlippageSol += sale.slip;
  }

  const exitPoint = path[exitIndex];
  const laterPeak = Math.max(...path.slice(exitIndex + 1).map(point => point.valueSol), exitPoint.valueSol);
  const prematureExit = fullyExited && laterPeak > exitPoint.valueSol;
  const maxGiveBackFromPeakPct = peak > 0
    ? Math.max(0, (peak - exitPoint.valueSol) / peak) * 100
    : 0;

  return {
    policy: policy.name,
    capturedNetSol,
    netReturnPct: ((capturedNetSol - entry) / entry) * 100,
    maxGiveBackFromPeakPct,
    realizedSlippageSol,
    prematureExit,
    exitReason,
    exitAtMs: exitPoint.atMs
  };
}
