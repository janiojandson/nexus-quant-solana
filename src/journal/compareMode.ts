/**
 * Nexus Quant Solana — V2.1B Compare Mode & Restart Matrix
 *
 * Compares legacy execution facts against shadow journal facts and defines
 * deterministic recovery actions for the 8 lifecycle crash points.
 */

export interface JournalComparisonMismatch {
  field: string;
  legacyValue: unknown;
  shadowValue: unknown;
  severity: 'INFO' | 'WARN' | 'CRITICAL';
  mismatchReason?: string;
}

export interface LegacyExecutionFact {
  tradeId?: string;
  positionId?: string;
  requestedAmountAtomic: string;
  signature?: string;
  providerResult: string; // 'SUCCESS' | 'FAILED' | 'SUBMITTED_UNCONFIRMED'
  proceedsLamports: string;
  isPartial: boolean;
  terminalState: string; // 'APPLIED' | 'FAILED' | 'UNCERTAIN'
}

export interface ShadowJournalFact {
  tradeId?: string;
  positionId?: string;
  requestedAmountAtomic: string;
  signature?: string;
  providerResult: string;
  proceedsLamports: string;
  isPartial: boolean;
  terminalState: string;
}

export interface JournalComparisonReport {
  matches: boolean;
  mismatches: JournalComparisonMismatch[];
  legacyFact: LegacyExecutionFact;
  shadowFact: ShadowJournalFact;
  evaluatedAtWallMs: number;
}

/**
 * Compares legacy execution fact against V2.1 shadow journal fact.
 */
export function compareLegacyVsShadow(
  legacy: LegacyExecutionFact,
  shadow: ShadowJournalFact
): JournalComparisonReport {
  const mismatches: JournalComparisonMismatch[] = [];

  // 1. requestedAmountAtomic
  if (legacy.requestedAmountAtomic !== shadow.requestedAmountAtomic) {
    mismatches.push({
      field: 'requestedAmountAtomic',
      legacyValue: legacy.requestedAmountAtomic,
      shadowValue: shadow.requestedAmountAtomic,
      severity: 'CRITICAL',
      mismatchReason: 'Divergência na quantidade atômica solicitada para venda'
    });
  }

  // 2. signature
  if ((legacy.signature || '') !== (shadow.signature || '')) {
    mismatches.push({
      field: 'signature',
      legacyValue: legacy.signature,
      shadowValue: shadow.signature,
      severity: 'CRITICAL',
      mismatchReason: 'Assinatura on-chain divergente entre executor legado e shadow journal'
    });
  }

  // 3. providerResult
  if (legacy.providerResult !== shadow.providerResult) {
    mismatches.push({
      field: 'providerResult',
      legacyValue: legacy.providerResult,
      shadowValue: shadow.providerResult,
      severity: 'WARN',
      mismatchReason: 'Resultado do provedor (Jupiter/Pump) divergente'
    });
  }

  // 4. proceeds
  if (legacy.proceedsLamports !== shadow.proceedsLamports) {
    mismatches.push({
      field: 'proceedsLamports',
      legacyValue: legacy.proceedsLamports,
      shadowValue: shadow.proceedsLamports,
      severity: 'CRITICAL',
      mismatchReason: 'Valor bruto em lamports divergente'
    });
  }

  // 5. partial / final identity
  if (legacy.isPartial !== shadow.isPartial) {
    mismatches.push({
      field: 'isPartial',
      legacyValue: legacy.isPartial,
      shadowValue: shadow.isPartial,
      severity: 'CRITICAL',
      mismatchReason: 'Classificação de saída parcial vs total divergente'
    });
  }

  // 6. terminalState
  if (legacy.terminalState !== shadow.terminalState) {
    mismatches.push({
      field: 'terminalState',
      legacyValue: legacy.terminalState,
      shadowValue: shadow.terminalState,
      severity: 'WARN',
      mismatchReason: 'Estado terminal divergente'
    });
  }

  return {
    matches: mismatches.length === 0,
    mismatches,
    legacyFact: legacy,
    shadowFact: shadow,
    evaluatedAtWallMs: Date.now()
  };
}

// ==========================================
// RESTART MATRIX RECOVERY ACTIONS
// ==========================================

export type LifecycleStage =
  | 'CREATED'
  | 'CLAIMED'
  | 'PREPARED'
  | 'SIGNED'
  | 'SUBMITTED'
  | 'UNKNOWN'
  | 'CONFIRMED'
  | 'FILL_RECORDED_PRE_APPLY';

export interface RestartRecoveryAction {
  stage: LifecycleStage;
  safeAction:
    | 'CLAIM_ALLOWED'
    | 'RECLAIM_AFTER_LEASE'
    | 'RECONCILE_OR_RETRY_UNSENT'
    | 'MUST_RECONCILE'
    | 'APPLY_IDEMPOTENTLY'
    | 'IDEMPOTENT_RECOVERY_APPLIED'
    | 'COMPLETE_IDEMPOTENTLY';
  safeToCreateNewAttempt: boolean;
  canBlindlyResend: boolean;
  requiresBlockchainReconciliation: boolean;
  description: string;
}

export function determineRestartAction(stage: LifecycleStage): RestartRecoveryAction {
  switch (stage) {
    case 'CREATED':
      return {
        stage,
        safeAction: 'CLAIM_ALLOWED',
        safeToCreateNewAttempt: true,
        canBlindlyResend: true,
        requiresBlockchainReconciliation: false,
        description: 'Intent recém-criado sem tentativa associada: seguro criar nova tentativa após claim (SAFE_TO_CREATE_NEW_ATTEMPT).'
      };

    case 'CLAIMED':
      return {
        stage,
        safeAction: 'RECLAIM_AFTER_LEASE',
        safeToCreateNewAttempt: true,
        canBlindlyResend: true,
        requiresBlockchainReconciliation: false,
        description: 'Reivindicado sem tentativa financeira emitida: seguro criar nova tentativa após expiração da lease (SAFE_TO_CREATE_NEW_ATTEMPT).'
      };

    case 'PREPARED':
      return {
        stage,
        safeAction: 'RECONCILE_OR_RETRY_UNSENT',
        safeToCreateNewAttempt: true,
        canBlindlyResend: true,
        requiresBlockchainReconciliation: false,
        description: 'Tentativa preparada localmente não-assinada e comprovadamente não-transmitida: seguro preparar novamente (SAFE_TO_CREATE_NEW_ATTEMPT).'
      };

    case 'SIGNED':
      return {
        stage,
        safeAction: 'MUST_RECONCILE',
        safeToCreateNewAttempt: false,
        canBlindlyResend: false,
        requiresBlockchainReconciliation: true,
        description: 'Transação assinada: processo pode ter morrido durante broadcast. Conservadoramente exige reconciliação (MUST_RECONCILE).'
      };

    case 'SUBMITTED':
      return {
        stage,
        safeAction: 'MUST_RECONCILE',
        safeToCreateNewAttempt: false,
        canBlindlyResend: false,
        requiresBlockchainReconciliation: true,
        description: 'Transação enviada para rede: PROIBIDO retransmitir cegamente. Exige reconciliação on-chain (MUST_RECONCILE).'
      };

    case 'UNKNOWN':
      return {
        stage,
        safeAction: 'MUST_RECONCILE',
        safeToCreateNewAttempt: false,
        canBlindlyResend: false,
        requiresBlockchainReconciliation: true,
        description: 'Timeout de transporte: estado on-chain desconhecido. Exige reconciliação antes de qualquer ação (MUST_RECONCILE).'
      };

    case 'CONFIRMED':
      return {
        stage,
        safeAction: 'APPLY_IDEMPOTENTLY',
        safeToCreateNewAttempt: false,
        canBlindlyResend: false,
        requiresBlockchainReconciliation: false,
        description: 'Transação confirmada on-chain: aplicar fill idempotentemente e finalizar posição (APPLY_IDEMPOTENTLY).'
      };

    case 'FILL_RECORDED_PRE_APPLY':
      return {
        stage,
        safeAction: 'COMPLETE_IDEMPOTENTLY',
        safeToCreateNewAttempt: false,
        canBlindlyResend: false,
        requiresBlockchainReconciliation: false,
        description: 'Fill registrado no ledger mas crash ocorreu antes de Intent APPLIED: completar idempotentemente (COMPLETE_IDEMPOTENTLY).'
      };
  }
}
