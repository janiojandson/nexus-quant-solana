export type PumpStrategyCohort =
  | 'BIRTH_0_15S'
  | 'BIRTH_15_60S'
  | 'EARLY_1_5M'
  | 'CURVE_5_15M'
  | 'NEAR_GRAD_60_80'
  | 'NEAR_GRAD_80_95'
  | 'NEAR_GRAD_95_100'
  | 'POST_GRAD_0_2M'
  | 'POST_GRAD_2_10M';

export interface PumpCohortInput {
  ageMs: number;
  progressPct?: number;
  graduatedAtMs?: number;
  nowMs: number;
}

export function classifyPumpCohort(input: PumpCohortInput): PumpStrategyCohort | undefined {
  if (Number.isFinite(input.graduatedAtMs) && input.graduatedAtMs! >= 0 && input.nowMs >= input.graduatedAtMs!) {
    const sinceGraduation = input.nowMs - input.graduatedAtMs!;
    if (sinceGraduation < 2 * 60_000) return 'POST_GRAD_0_2M';
    if (sinceGraduation <= 10 * 60_000) return 'POST_GRAD_2_10M';
    return undefined;
  }

  const progress = Math.max(0, Number(input.progressPct) || 0);
  if (progress >= 95) return 'NEAR_GRAD_95_100';
  if (progress >= 80) return 'NEAR_GRAD_80_95';
  if (progress >= 60) return 'NEAR_GRAD_60_80';

  const ageMs = Math.max(0, Number(input.ageMs) || 0);
  if (ageMs < 15_000) return 'BIRTH_0_15S';
  if (ageMs < 60_000) return 'BIRTH_15_60S';
  if (ageMs < 5 * 60_000) return 'EARLY_1_5M';
  if (ageMs <= 15 * 60_000) return 'CURVE_5_15M';
  return undefined;
}
