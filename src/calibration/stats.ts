// ============================================================
// stats.ts — Funções estatísticas puras (sem dependência de DB)
// Usadas pelo EV Calibration Job
// ============================================================

/**
 * Intervalo de confiança de Wilson para proporções (win rate).
 * Mais robusto que normal approximation para N pequeno.
 */
export function wilsonCI(
  successes: number,
  trials: number,
  confidence = 0.95
): { lower: number; upper: number; point: number } {
  if (trials === 0) return { lower: 0, upper: 1, point: 0 };

  const z = confidence === 0.95 ? 1.959964 : 1.644854; // 95% ou 90%
  const n = trials;
  const p = successes / n;
  const z2 = z * z;

  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));

  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    point: p,
  };
}

/**
 * Intervalo de confiança para média (EV) usando t-Student.
 * Aproximação: para N >= 30, t ≈ z ≈ 1.96 (95%).
 */
export function meanCI(
  values: number[],
  confidence = 0.95
): { mean: number; lower: number; upper: number; std: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, lower: 0, upper: 0, std: 0 };

  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1 || 1);
  const std = Math.sqrt(variance);
  const se = std / Math.sqrt(n);

  // t-value aproximado para 95% (N >= 30 → t ≈ 1.96)
  // Para N pequeno, escalamos conservadoramente
  let t: number;
  if (n >= 100) t = 1.96;
  else if (n >= 50) t = 2.0;
  else if (n >= 30) t = 2.042;  // t(29) ≈ 2.042
  else if (n >= 20) t = 2.093;
  else if (n >= 10) t = 2.262;
  else t = 2.776;

  return {
    mean,
    lower: mean - t * se,
    upper: mean + t * se,
    std,
  };
}

/**
 * Calcula o EV líquido em %:
 * EV = (winRate × avgWin%) - (lossRate × avgLoss%) - avgCosts%
 */
export function calculateEV(
  winRate: number,
  avgWinPct: number,
  avgLossPct: number,
  avgCostsPct = 2.5 // custos médios: slippage + fees + rent
): number {
  const lossRate = 1 - winRate;
  return winRate * avgWinPct - lossRate * Math.abs(avgLossPct) - avgCostsPct;
}

/**
 * Calcula o lift de um gate:
 * EV(com gate passou) - EV(com gate falhou)
 */
export function calculateLift(
  evWithGate: number,
  evWithoutGate: number
): number {
  return evWithGate - evWithoutGate;
}

/**
 * Determina o veredito de um gate com base no lift e N.
 */
export function gateVerdict(
  lift: number,
  sampleSize: number,
  minSample = 30
): 'KEEP' | 'TIGHTEN' | 'LOOSEN' | 'REMOVE' | 'INSUFFICIENT_DATA' {
  if (sampleSize < minSample) return 'INSUFFICIENT_DATA';
  if (lift > 2.0) return 'KEEP';
  if (lift > 0.5) return 'LOOSEN';    // gate é bom mas talvez restritivo demais
  if (lift > -0.5) return 'TIGHTEN';  // neutro, não faz muito
  return 'REMOVE';                     // gate está prejudicando
}
