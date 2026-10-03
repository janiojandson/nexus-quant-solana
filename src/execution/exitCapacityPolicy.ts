export interface ExitCapacityInput {
  generalRps: number;
  monitorIntervalMs: number;
  openPositions: number;
  hasLocalExitSensor: boolean;
}

export interface ExitCapacityResult {
  admit: boolean;
  requiredRps: number;
  availableRps: number;
  reason?: string;
}

export function evaluateExitCapacity(input: ExitCapacityInput): ExitCapacityResult {
  const availableRps = Math.max(0, Number(input.generalRps) || 0);
  const positions = Math.max(0, Math.floor(Number(input.openPositions) || 0));
  const intervalMs = Math.max(1, Number(input.monitorIntervalMs) || 1);
  const requiredRps = input.hasLocalExitSensor
    ? 0
    : positions * (1000 / intervalMs);
  const admit = requiredRps <= availableRps;

  return {
    admit,
    requiredRps,
    availableRps,
    reason: admit
      ? undefined
      : `Exit protection capacity exceeded: required ${requiredRps.toFixed(3)} RPS, available ${availableRps.toFixed(3)} RPS.`
  };
}
