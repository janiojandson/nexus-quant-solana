
export interface ProfitProtectionInput {
  remainingCost: number;
  initialCost: number;
  confirmedProceeds?: number;
  executableValue: number;
  peakValue: number;
  remainingFraction: number;
  quoteAgeMs: number;
  estimatedExitFee: number;
  maxSlippageBps: number;
}
export function evaluateProfitProtectionShadow(p: ProfitProtectionInput) {
  const result = (action: string, reason: string, fraction = 0) =>
    ({ mode: 'SHADOW' as const, action, reason, fraction, requiresPartialQuote: fraction > 0 && fraction < 1 });
  if (![p.remainingCost, p.initialCost, p.executableValue, p.peakValue, p.remainingFraction,
    p.quoteAgeMs, p.estimatedExitFee, p.maxSlippageBps].every(Number.isFinite) ||
    p.remainingCost <= 0 || p.initialCost <= 0 || p.executableValue < 0 ||
    p.remainingFraction <= 0 || p.remainingFraction > 1 || p.quoteAgeMs < 0 ||
    p.estimatedExitFee < 0 || p.maxSlippageBps < 0 || p.maxSlippageBps > 750) {
    return result('UNKNOWN', 'INVALID_INPUT');
  }
  if (p.quoteAgeMs > 3_000) return result('REQUOTE', 'STALE_QUOTE');
  // A gap cannot be filled retroactively at the trailing threshold.
  if (p.peakValue >= p.remainingCost * 1.08 && p.executableValue <= p.peakValue * 0.90) {
    return result('EXIT_ALL', 'EXECUTABLE_DRAWDOWN', 1);
  }
  const pnl = p.executableValue / p.remainingCost - 1;
  if (p.confirmedProceeds == null || !Number.isFinite(p.confirmedProceeds) || p.confirmedProceeds < 0) {
    const target = pnl >= 3 ? 0.20 : pnl >= 2 ? 0.30 : undefined;
    if (target != null && p.remainingFraction > target) {
      return result('HARVEST', 'EXPOSURE_ONLY_CONFIRMED_PROCEEDS_UNKNOWN', 1 - target / p.remainingFraction);
    }
    return result('UNKNOWN', 'CONFIRMED_PROCEEDS_UNAVAILABLE');
  }
  const recoveryGap = Math.max(0, p.initialCost - p.confirmedProceeds);
  if (pnl >= 1 && recoveryGap > 0) {
    const conservativeValue = p.executableValue * (1 - p.maxSlippageBps / 10_000);
    const fraction = Math.min(1, (recoveryGap + p.estimatedExitFee) / conservativeValue);
    return result('RECOVER_CAPITAL', 'ESTIMATE_REQUIRES_EXACT_PARTIAL_QUOTE', fraction);
  }
  const targetRemaining = pnl >= 3 ? 0.20 : pnl >= 2 ? 0.30 : undefined;
  if (targetRemaining != null && p.remainingFraction > targetRemaining) {
    return result('HARVEST', 'REDUCE_ORIGINAL_TOKEN_EXPOSURE', 1 - targetRemaining / p.remainingFraction);
  }
  return result('HOLD', recoveryGap === 0 ? 'CAPITAL_RECOVERED_BEFORE_UNACCOUNTED_COSTS' : 'BELOW_RECOVERY_TRIGGER');
}

const lastReports = new Map<string, { signature: string; at: number }>();
/** Observations only: no orders, position mutation, or simulated fills. */
export function reportProfitProtectionShadow(key: string, input: ProfitProtectionInput): void {
  const decision = evaluateProfitProtectionShadow(input);
  const signature = decision.action + ':' + decision.reason;
  const now = Date.now();
  const previous = lastReports.get(key);
  if (previous?.signature === signature && now - previous.at < 30_000) return;
  if (lastReports.size >= 128 && !lastReports.has(key)) lastReports.delete(lastReports.keys().next().value!);
  lastReports.set(key, { signature, at: now });
  console.log('[PROFIT_PROTECTION_SHADOW] ' + JSON.stringify({
    key, ...decision, ...input, costsComplete: false, actualFill: false
  }));
}
