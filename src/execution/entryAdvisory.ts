import type { SolanaLayaFacts, SolanaLayaEntryAction, SolanaLayaTacticalDecision } from '../risk/solanaLayaAdapter.js';

export interface EntryAdvisoryTelemetry {
  mode: 'SHADOW';
  status: 'SCHEDULED' | 'MISSING_FACTS' | 'COMPLETED' | 'ERROR';
  action?: SolanaLayaEntryAction;
  score?: number;
  confidence?: number;
  abstention?: string;
  latencyMs?: number;
  error?: string;
}

/** DEX advisory never participates in financial control flow, even on sync throws. */
export function scheduleEntryAdvisory(options: {
  facts?: SolanaLayaFacts;
  evaluate: (facts: SolanaLayaFacts) => Promise<SolanaLayaTacticalDecision<SolanaLayaEntryAction>>;
  report?: (telemetry: EntryAdvisoryTelemetry) => void;
}): EntryAdvisoryTelemetry {
  const telemetry: EntryAdvisoryTelemetry = { mode: 'SHADOW', status: options.facts ? 'SCHEDULED' : 'MISSING_FACTS' };
  if (!options.facts) return telemetry;
  void Promise.resolve()
    .then(() => options.evaluate(options.facts!))
    .then(decision => {
      Object.assign(telemetry, {
        status: 'COMPLETED', action: decision.action, score: decision.score,
        confidence: decision.confidence, abstention: decision.abstention, latencyMs: decision.latencyMs
      });
    })
    .catch((error: unknown) => {
      telemetry.status = 'ERROR';
      telemetry.error = error instanceof Error ? error.message : String(error);
    })
    .then(() => options.report?.(telemetry))
    .catch(() => { /* A telemetry sink must never create an unhandled rejection. */ });
  return telemetry;
}
