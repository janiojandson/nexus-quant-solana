import type { PumpStrategyCohort } from './pumpCohorts.js';
import type { ExitPathPoint } from './exitPolicyReplay.js';

export type PumpEntryWindow =
  | 'LAUNCH_0_15S'
  | 'ENTRY_30S'
  | 'ENTRY_3M'
  | 'ENTRY_5M'
  | 'NEAR_GRAD_60_80'
  | 'NEAR_GRAD_80_95'
  | 'NEAR_GRAD_95_100'
  | 'POST_GRAD_0_2M'
  | 'POST_GRAD_2_10M';

export interface EntryWindowInput {
  ageMs: number;
  progressPct?: number;
  complete: boolean;
  sinceGraduationMs?: number;
  seen: ReadonlySet<PumpEntryWindow>;
}

export interface ReplayMarkLike {
  observedAtMs: number;
  grossExitValueSol: number;
  executable: boolean;
}

export function dueEntryWindows(input: EntryWindowInput): PumpEntryWindow[] {
  const ageMs = Math.max(0, Number(input.ageMs) || 0);
  const progress = Math.max(0, Number(input.progressPct) || 0);
  const unseen = (window: PumpEntryWindow) => !input.seen.has(window);

  if (input.complete) {
    const since = Math.max(0, Number(input.sinceGraduationMs) || 0);
    if (since < 120_000 && unseen('POST_GRAD_0_2M')) return ['POST_GRAD_0_2M'];
    if (since >= 120_000 && since <= 600_000 && unseen('POST_GRAD_2_10M')) return ['POST_GRAD_2_10M'];
    return [];
  }

  if (progress >= 95) return unseen('NEAR_GRAD_95_100') ? ['NEAR_GRAD_95_100'] : [];
  if (progress >= 80) return unseen('NEAR_GRAD_80_95') ? ['NEAR_GRAD_80_95'] : [];
  if (progress >= 60) return unseen('NEAR_GRAD_60_80') ? ['NEAR_GRAD_60_80'] : [];

  if (ageMs < 15_000) return unseen('LAUNCH_0_15S') ? ['LAUNCH_0_15S'] : [];
  if (ageMs >= 30_000 && ageMs < 60_000) return unseen('ENTRY_30S') ? ['ENTRY_30S'] : [];
  if (ageMs >= 180_000 && ageMs < 300_000) return unseen('ENTRY_3M') ? ['ENTRY_3M'] : [];
  if (ageMs >= 300_000 && ageMs <= 900_000) return unseen('ENTRY_5M') ? ['ENTRY_5M'] : [];
  return [];
}

export function entryWindowToCohort(window: PumpEntryWindow): PumpStrategyCohort {
  switch (window) {
    case 'LAUNCH_0_15S': return 'BIRTH_0_15S';
    case 'ENTRY_30S': return 'BIRTH_15_60S';
    case 'ENTRY_3M': return 'EARLY_1_5M';
    case 'ENTRY_5M': return 'CURVE_5_15M';
    default: return window;
  }
}

export function strategySummaryKey(window: PumpEntryWindow, horizon: string): string {
  return `${window}@${horizon}`;
}

export function buildExecutableReplayPath(
  entryPrincipalSol: number,
  entryAtMs: number,
  marks: ReplayMarkLike[]
): ExitPathPoint[] {
  const path: ExitPathPoint[] = [{ atMs: entryAtMs, valueSol: entryPrincipalSol }];
  for (const mark of marks
    .filter(mark => mark.executable && Number.isFinite(mark.grossExitValueSol) && mark.grossExitValueSol > 0)
    .sort((a, b) => a.observedAtMs - b.observedAtMs)) {
    path.push({ atMs: mark.observedAtMs, valueSol: mark.grossExitValueSol });
  }
  return path;
}
