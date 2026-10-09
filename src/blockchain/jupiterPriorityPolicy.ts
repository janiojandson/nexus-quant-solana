import type { JupiterPriority } from './jupiterTrafficCoordinator.js';
import type { JupiterWork } from '../hubs/jupiterOrgHub.js';
export function hubWorkForPriority(priority:JupiterPriority):JupiterWork {
  if(priority===0||priority===1) return 'EXIT';
  if(priority===2||priority===3) return 'RECONCILE';
  if(priority===4||priority===5) return 'ENTRY';
  throw new Error('Jupiter quote research disabled; discovery uses token endpoints only');
}

export type JupiterWorkKind =
  | 'EMERGENCY_EXIT'
  | 'PROTECTIVE_EXIT'
  | 'EXIT_CONFIRMATION'
  | 'POSITION_HEALTH'
  | 'ENTRY_ORDER'
  | 'ENTRY_SIZING'
  | 'PUMP_RESEARCH';

const PRIORITY: Record<JupiterWorkKind, JupiterPriority> = {
  EMERGENCY_EXIT: 0,
  PROTECTIVE_EXIT: 1,
  EXIT_CONFIRMATION: 2,
  POSITION_HEALTH: 3,
  ENTRY_ORDER: 4,
  ENTRY_SIZING: 5,
  PUMP_RESEARCH: 6
};

export function priorityForJupiterWork(kind: JupiterWorkKind): JupiterPriority {
  return PRIORITY[kind];
}
