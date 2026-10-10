export interface ExitCapacityInput {
  generalRps: number;
  monitorIntervalMs: number;
  openPositions: number;
  hasLocalExitSensor: boolean;
  protectionRequestsPerMinute?: number;
}

export interface ExitCapacityResult {
  admit: boolean;
  requiredRps: number;
  availableRps: number;
  pollIntervalMs: number;
  reason?: string;
}

export function evaluateExitCapacity(input: ExitCapacityInput): ExitCapacityResult {
  const protectionBudget = Math.max(0, Number(input.protectionRequestsPerMinute ?? 60));
  const positions = Math.max(0, Math.floor(Number(input.openPositions) || 0));
  const pollIntervalMs = positions >= 2 ? 2500 : 1500;
  // One position costs 40/min. Two positions cost 48/min, leaving 12/min
  // for exit orders and reconciliation on the PROTECTION organization.
  const reservedPerMinute = positions >= 2 ? 12 : 20;
  const availableRps = Math.max(0, protectionBudget - reservedPerMinute) / 60;
  const requiredRps = input.hasLocalExitSensor
    ? 0
    : positions * (1000 / pollIntervalMs);
  const admit = positions <= 2 && requiredRps <= availableRps;

  return {
    admit,
    requiredRps,
    availableRps,
    pollIntervalMs,
    reason: admit
      ? undefined
      : positions > 2 ? 'Maximum 2 active positions.'
      : `Exit protection capacity exceeded: required ${requiredRps.toFixed(3)} RPS, available ${availableRps.toFixed(3)} RPS.`
  };
}
