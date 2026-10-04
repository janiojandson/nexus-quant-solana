import type { GateEvaluation } from '../database/decisionJournal.js';
import type { SecurityAuditResult, TokenSecurityMetadata } from '../risk/memeRiskGatekeeper.js';

export function buildContractGates(audit: SecurityAuditResult, token: Partial<TokenSecurityMetadata> = {}): GateEvaluation[] {
  const report = audit.rugCheckReport;
  const authority = (gate: 'MINT_AUTHORITY' | 'FREEZE_AUTHORITY', value: string | null | undefined): GateEvaluation => {
    if (value === null) return {gate, result:'PASS', detail:'Observed revoked authority'};
    if (typeof value === 'string' && value.length > 0) return {gate, result:'FAIL', detail:'Observed active authority'};
    return {gate, result:'WARN', detail:'NOT_EVALUATED: authority unavailable'};
  };
  const top = report?.topHoldersPct;
  const topKnown = typeof top === 'number' && Number.isFinite(top) && top >= 0 && top <= 100;
  return [
    authority('MINT_AUTHORITY', report ? report.mintAuthority : token.mintAuthority),
    authority('FREEZE_AUTHORITY', report ? report.freezeAuthority : token.freezeAuthority),
    topKnown
      ? {gate:'TOP_HOLDERS', result:top <= 35 ? 'PASS' : 'FAIL', value:top, threshold:35, detail:'RugCheck top five, using the same facts as the risk decision'}
      : {gate:'TOP_HOLDERS', result:'WARN', threshold:35, detail:'NOT_EVALUATED: holder concentration unavailable'},
    {gate:'DISTANCE_FROM_LOW', result:'WARN', detail:'NOT_EVALUATED: no measured low is available'}
  ];
}

export const UNMEASURED_LEGACY_GATES = new Set(['TOP_HOLDERS', 'MINT_AUTHORITY', 'FREEZE_AUTHORITY', 'DISTANCE_FROM_LOW']);
export function presentRejectionEvidence(row: Record<string, any>): Record<string, any> {
  const raw: GateEvaluation[] = Array.isArray(row.gate_details) ? row.gate_details : [];
  const measured = Number(row.gate_evidence_version) >= 2;
  const gates: GateEvaluation[] = raw.map(g => !measured && UNMEASURED_LEGACY_GATES.has(g.gate)
    ? {gate:g.gate, result:'WARN', detail:'LEGACY_UNVERIFIED: historical placeholder; measurement unavailable'}
    : g);
  const first = gates.find(g => g.result === 'FAIL') ?? gates.find(g => g.result === 'WARN');
  return {...row, gate_details:gates, first_gate:first?.gate ?? null, first_result:first?.result ?? null,
    actual_value:first?.value ?? null, required_threshold:first?.threshold ?? null};
}
