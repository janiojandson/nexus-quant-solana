import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { DurableEntryRegistrar, DurableEntryReceipt } from '../execution/entryAdmission.js';
import { assertAtomicAmountToNumber } from '../execution/atomicAmount.js';

export interface LedgerPositionState {
  tokenAmount: number; initialCapitalSol: number; remainingCostSol: number;
  cumulativeGrossProceedsSol: number; cumulativeNetProceedsSol: number;
  highestTpStepReached: number; stopLossPct: number;
  confirmedRealPrincipalRecoverySol?: number;
  mint?: string; traceId?: string; symbol?: string; entryPriceUsd?: number;
  entryTimestamp?: number; initialTokenAmount?: number; entryPairAddress?: string;
  entryLiquidityUsd?: number; entryPhysicalSolLamports?: string;
  accountingMode?: 'SHADOW' | 'LIVE'; status?: string;
  executablePeakSolValue?: number; observablePeakSolValue?: number;
  lastJupiterExecutableSolValue?: number; lastHealthyExitRouteAt?: number;
}
export interface LedgerFill {
  fillId: string; tokenAmount: number; grossProceedsSol: number;
  feeSol: number; rentRecoveredSol?: number; nextStep: number; isFull: boolean;
}
export interface DurableExitFill extends LedgerFill {
  accountingMode: 'SHADOW'; traceId: string;
  quoteEvidence?: { expectedOutLamports: number; minimumOutLamports: number;
    bpsHaircutLamports: number; networkFeeLamports: number;
    rentReserveLamports: number; conservativeNetLamports: number };
  executablePeakSolValue?: number; observablePeakSolValue?: number;
  lastJupiterExecutableSolValue?: number; lastHealthyExitRouteAt?: number;
}
export interface DurableFillResult { applied: boolean; position: LedgerPositionState }
export interface ConfirmedLiveFill {
  traceId: string; mint: string; fillId: string; soldAtomic: number;
  /** Confirmed wallet SOL delta after the transaction fee, not Jupiter expected output. */
  receivedLamports: number; feeLamports: number;
  initialCapitalSol: number; initialTokenAmount: number;
  entryPriceUsd: number; entryTimestamp: Date; exitPriceUsd: number;
  exitReason: string; nextStep: number; isFull: boolean;
}
const precise = (value: number): number => Math.round(value * 1e12) / 1e12;

/** Pure transition after an immutable fill ID wins the database insert. */
export function computeExitFill(position: LedgerPositionState, fill: LedgerFill): LedgerPositionState {
  if (!fill.fillId || !Number.isSafeInteger(position.tokenAmount) || position.tokenAmount <= 0 ||
      !Number.isSafeInteger(fill.tokenAmount) || fill.tokenAmount <= 0 || fill.tokenAmount > position.tokenAmount ||
      !Number.isFinite(fill.grossProceedsSol) || fill.grossProceedsSol < 0 ||
      !Number.isFinite(fill.feeSol) || fill.feeSol < 0 ||
      !Number.isFinite(position.remainingCostSol) || position.remainingCostSol < 0 ||
      (fill.isFull !== (fill.tokenAmount === position.tokenAmount))) throw new Error('INVALID_EXIT_FILL');
  if ((fill.rentRecoveredSol ?? 0) !== 0) throw new Error('SHADOW_RENT_MUST_BE_ZERO');
  if (!Number.isInteger(fill.nextStep) || fill.nextStep < position.highestTpStepReached || fill.nextStep > 2)
    throw new Error('INVALID_EXIT_STEP');
  const remaining = position.tokenAmount - fill.tokenAmount;
  const remainingCostSol = remaining === 0 ? 0 :
    precise(position.remainingCostSol * remaining / position.tokenAmount);
  return {
    ...position, tokenAmount: remaining, remainingCostSol,
    cumulativeGrossProceedsSol: precise(position.cumulativeGrossProceedsSol + fill.grossProceedsSol),
    cumulativeNetProceedsSol: precise(position.cumulativeNetProceedsSol + fill.grossProceedsSol - fill.feeSol),
    confirmedRealPrincipalRecoverySol: position.confirmedRealPrincipalRecoverySol ?? 0,
    highestTpStepReached: fill.nextStep,
    stopLossPct: fill.nextStep >= 1 ? Math.max(position.stopLossPct, 0) : position.stopLossPct,
    status: fill.isFull ? 'FULLY_CLOSED' : 'PARTIAL_CLOSED'
  };
}

function fromRow(row: Record<string, unknown>): LedgerPositionState {
  return {
    mint: String(row.mint), traceId: String(row.trace_id), symbol: String(row.symbol ?? row.mint),
    accountingMode: String(row.accounting_mode) as 'SHADOW' | 'LIVE',
    tokenAmount: String(row.token_amount) === '0' && row.status === 'FULLY_CLOSED'
      ? 0 : assertAtomicAmountToNumber(String(row.token_amount)),
    initialTokenAmount: assertAtomicAmountToNumber(String(row.initial_token_amount ?? row.token_amount)),
    initialCapitalSol: Number(row.initial_capital_sol), remainingCostSol: Number(row.remaining_cost_sol),
    cumulativeGrossProceedsSol: Number(row.cumulative_gross_proceeds_sol),
    cumulativeNetProceedsSol: Number(row.cumulative_net_proceeds_sol),
    confirmedRealPrincipalRecoverySol: Number(row.confirmed_real_principal_recovery_sol ?? 0),
    highestTpStepReached: Number(row.highest_tp_step), stopLossPct: Number(row.stop_loss_pct),
    entryPriceUsd: Number(row.entry_price_usd ?? 0),
    entryTimestamp: row.entry_timestamp ? new Date(String(row.entry_timestamp)).getTime() : undefined,
    entryPairAddress: row.entry_pair_address ? String(row.entry_pair_address) : undefined,
    entryLiquidityUsd: row.entry_liquidity_usd == null ? undefined : Number(row.entry_liquidity_usd),
    entryPhysicalSolLamports: row.entry_physical_sol_lamports == null ? undefined : String(row.entry_physical_sol_lamports),
    status: String(row.status ?? 'OPEN'),
    executablePeakSolValue: row.executable_peak_sol_value == null ? undefined : Number(row.executable_peak_sol_value),
    observablePeakSolValue: row.observable_peak_sol_value == null ? undefined : Number(row.observable_peak_sol_value),
    lastJupiterExecutableSolValue: row.last_jupiter_executable_sol_value == null ? undefined : Number(row.last_jupiter_executable_sol_value),
    lastHealthyExitRouteAt: row.last_healthy_exit_route_at ? new Date(String(row.last_healthy_exit_route_at)).getTime() : undefined
  };
}

const receiptFromRow = (row: Record<string, unknown>): DurableEntryReceipt => ({
  durable: true, positionRegistered: true, accountingMode: 'SHADOW',
  entryIntentId: String(row.entry_intent_id), traceId: String(row.trace_id)
});
const stableIntentId = (mint: string, pairAddress: string, source: string): string => {
  const hex = createHash('sha256').update(`SHADOW:${mint}:${pairAddress}:${source}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
};
export class PostgresPositionLedger implements DurableEntryRegistrar {
  constructor(private readonly pool: Pick<Pool, 'connect' | 'query'> | null,
    private readonly onRegistered?: (position: LedgerPositionState) => void) {}

  async recover(input: { candidate: Parameters<DurableEntryRegistrar['register']>[0]['candidate'];
    abortSignal?: AbortSignal; lease?: Parameters<DurableEntryRegistrar['register']>[0]['lease'] }): Promise<DurableEntryReceipt | null> {
    if (!this.pool) throw new Error('PERSISTENCE_UNAVAILABLE');
    if (input.abortSignal?.aborted) throw new Error('LEASE_LOST');
    await input.lease?.assertLeaseActive();
    if (input.abortSignal?.aborted) throw new Error('LEASE_LOST');
    if (input.lease && !input.lease.sourceEventAt) throw new Error('SOURCE_EVENT_UNAVAILABLE');
    const result = input.lease
      ? await this.pool.query(`SELECT p.* FROM quant_position_ledger p
          JOIN sentinel_handoff h ON h.mint = p.mint
          WHERE p.accounting_mode = 'SHADOW' AND p.mint = $1
            AND p.source_event_at = $2::timestamptz
            AND h.created_at = $2::timestamptz AND h.lease_id = $3
            AND h.lease_expires_at > clock_timestamp() AND h.consumed_by_quant = FALSE
          ORDER BY p.entry_timestamp DESC LIMIT 1`,
        [input.candidate.mint, input.lease.sourceEventAt, input.lease.leaseId])
      : await this.pool.query(`SELECT * FROM quant_position_ledger
          WHERE accounting_mode = 'SHADOW' AND mint = $1 AND status <> 'FULLY_CLOSED'
          ORDER BY entry_timestamp DESC LIMIT 1`, [input.candidate.mint]);
    if (result.rowCount !== 1) return null;
    if (input.abortSignal?.aborted) throw new Error('LEASE_LOST');
    const position = fromRow(result.rows[0]);
    if (position.status !== 'FULLY_CLOSED') this.onRegistered?.(position);
    return receiptFromRow(result.rows[0]);
  }

  async register(input: Parameters<DurableEntryRegistrar['register']>[0]): ReturnType<DurableEntryRegistrar['register']> {
    if (!this.pool) throw new Error('PERSISTENCE_UNAVAILABLE');
    const guard = async () => {
      if (input.abortSignal?.aborted) throw new Error('LEASE_LOST');
      await input.lease?.assertLeaseActive();
      if (input.abortSignal?.aborted) throw new Error('LEASE_LOST');
    };
    await guard();
    if (input.accountingMode !== 'SHADOW' || input.accepted.accepted !== true ||
        input.accepted.order.inAmount !== String(input.stakeLamports) ||
        !Number.isSafeInteger(input.stakeLamports) || input.stakeLamports <= 0 ||
        input.accepted.evidence.pool.poolAddress !== input.candidate.pairAddress)
      throw new Error('ENTRY_EVIDENCE_MISMATCH');
    const tokenAmount = assertAtomicAmountToNumber(input.accepted.order.outAmount);
    if (input.lease && !input.lease.sourceEventAt) throw new Error('SOURCE_EVENT_UNAVAILABLE');
    const intentId = stableIntentId(input.candidate.mint, input.candidate.pairAddress,
      input.lease?.sourceEventAt ?? input.accepted.order.requestId);
    const traceId = randomUUID();
    const client = await this.pool.connect();
    let committed = false;
    try {
      await guard();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(721551)');
      if (input.abortSignal?.aborted) throw new Error('LEASE_LOST');
      if (input.lease) {
        const lease = await client.query(`SELECT mint FROM sentinel_handoff
          WHERE mint = $1 AND lease_id = $2 AND status = 'POOL_CONFIRMED'
            AND consumed_by_quant = FALSE AND lease_expires_at > clock_timestamp()
            AND created_at = $3::timestamptz
            AND pool_proof IS NOT NULL FOR UPDATE`, [input.candidate.mint, input.lease.leaseId,
              input.lease.sourceEventAt]);
        if (lease.rowCount !== 1) throw new Error('LEASE_LOST');
      }
      const existing = await client.query(`SELECT * FROM quant_position_ledger
        WHERE accounting_mode = 'SHADOW' AND mint = $1
          AND (status <> 'FULLY_CLOSED' OR source_event_at = $2::timestamptz)
        ORDER BY entry_timestamp DESC LIMIT 1 FOR UPDATE`,
        [input.candidate.mint, input.lease?.sourceEventAt ?? null]);
      if (existing.rowCount) {
        if (input.abortSignal?.aborted) throw new Error('LEASE_LOST');
        await client.query('COMMIT'); committed = true;
        const position = fromRow(existing.rows[0]);
        if (position.status !== 'FULLY_CLOSED') this.onRegistered?.(position);
        return receiptFromRow(existing.rows[0]);
      }
      const count = await client.query(`SELECT COUNT(*)::int AS active_count FROM quant_position_ledger
        WHERE accounting_mode = 'SHADOW' AND status <> 'FULLY_CLOSED'`);
      if (Number(count.rows[0]?.active_count) >= 2) throw new Error('POSITION_CAPACITY_EXCEEDED');
      if (input.abortSignal?.aborted) throw new Error('LEASE_LOST');
      const assertFreshEntryProof = () => {
        const now = Date.now();
        const observedAt = Date.parse(input.accepted.evidence.pool.observedAt);
        const orderExpiry = input.accepted.order.expireAt
          ? Date.parse(input.accepted.order.expireAt) : null;
        if (!Number.isFinite(observedAt) || now - observedAt > 15_000 ||
            observedAt > now + 2_000 ||
            (orderExpiry !== null && (!Number.isFinite(orderExpiry) || orderExpiry <= now)))
          throw new Error('STALE_ENTRY_PROOF');
      };
      assertFreshEntryProof();
      const capitalSol = input.stakeLamports / 1e9;
      const saved = await client.query(`INSERT INTO quant_position_ledger (
          accounting_mode, trace_id, entry_intent_id, mint, symbol, entry_pair_address,
          entry_price_usd, entry_liquidity_usd, entry_physical_sol_lamports,
          entry_timestamp, initial_token_amount,
          token_amount, initial_capital_sol, remaining_cost_sol, highest_tp_step,
          stop_loss_pct, executable_peak_sol_value, observable_peak_sol_value,
          entry_request_id, entry_evidence, lease_id, source_event_at)
        VALUES ('SHADOW',$1,$2,$3,$4,$5,$6,$7,$14,NOW(),$8,$8,$9,$9,0,-0.125,$9,$9,$10,$11::jsonb,$12,$13::timestamptz)
        RETURNING *`, [traceId, intentId, input.candidate.mint, input.candidate.symbol,
        input.candidate.pairAddress, input.candidate.priceUsd, input.candidate.liquidityUsd,
        String(tokenAmount), capitalSol, input.accepted.order.requestId,
        JSON.stringify({ evidence: input.accepted.evidence, order: {
          requestId: input.accepted.order.requestId, inAmount: input.accepted.order.inAmount,
          outAmount: input.accepted.order.outAmount,
          otherAmountThreshold: input.accepted.order.otherAmountThreshold } }),
        input.lease?.leaseId ?? null, input.lease?.sourceEventAt ?? null,
        input.accepted.evidence.pool.physicalSolLamports]);
      if (input.abortSignal?.aborted) throw new Error('LEASE_LOST');
      if (input.lease) {
        const stillValid = await client.query(`SELECT 1 FROM sentinel_handoff
          WHERE mint = $1 AND lease_id = $2 AND consumed_by_quant = FALSE
            AND lease_expires_at > clock_timestamp()
            AND created_at = $3::timestamptz`, [input.candidate.mint, input.lease.leaseId,
              input.lease.sourceEventAt]);
        if (stillValid.rowCount !== 1) throw new Error('LEASE_LOST');
      }
      assertFreshEntryProof();
      await client.query('COMMIT'); committed = true;
      const position = fromRow(saved.rows[0]);
      this.onRegistered?.(position);
      return receiptFromRow(saved.rows[0]);
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => {});
      // A lost COMMIT acknowledgement is reconciled by stable intent, never blindly reinserted.
      if (!committed && error instanceof Error && error.message !== 'LEASE_LOST') {
        try {
          const recovered = await this.pool.query(`SELECT * FROM quant_position_ledger
            WHERE accounting_mode = 'SHADOW' AND entry_intent_id = $1`, [intentId]);
          if (recovered.rowCount === 1) {
            const position = fromRow(recovered.rows[0]);
            if (position.status !== 'FULLY_CLOSED') this.onRegistered?.(position);
            return receiptFromRow(recovered.rows[0]);
          }
        } catch { /* Retain original failure without claiming an unverified commit. */ }
      }
      throw error;
    } finally { client.release(); }
  }

  async appendExitFill(fill: DurableExitFill): Promise<DurableFillResult> {
    if (!this.pool || fill.accountingMode !== 'SHADOW') throw new Error('PERSISTENCE_UNAVAILABLE');
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(`SELECT * FROM quant_position_ledger
        WHERE accounting_mode = $1 AND trace_id = $2 FOR UPDATE`,
        [fill.accountingMode, fill.traceId]);
      if (found.rowCount !== 1) throw new Error('POSITION_NOT_FOUND');
      const current = fromRow(found.rows[0]);
      const inserted = await client.query(`INSERT INTO quant_position_exit_fills
        (accounting_mode, trace_id, fill_id, token_amount, gross_proceeds_sol,
         fee_sol, rent_recovered_sol, next_step, is_full, quote_evidence)
        VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9::jsonb)
        ON CONFLICT (accounting_mode, trace_id, fill_id) DO NOTHING RETURNING fill_id`,
        [fill.accountingMode, fill.traceId, fill.fillId, String(fill.tokenAmount),
          fill.grossProceedsSol, fill.feeSol, fill.nextStep, fill.isFull,
          JSON.stringify(fill.quoteEvidence ?? {})]);
      if (inserted.rowCount === 0) {
        await client.query('COMMIT');
        return { applied: false, position: current };
      }
      if (current.status === 'FULLY_CLOSED') throw new Error('POSITION_CLOSED');
      const next = computeExitFill(current, fill);
      const updated = await client.query(`UPDATE quant_position_ledger SET
        token_amount = $3, remaining_cost_sol = $4,
        cumulative_gross_proceeds_sol = $5, cumulative_net_proceeds_sol = $6,
        highest_tp_step = $7, stop_loss_pct = $8, status = $9,
        executable_peak_sol_value = COALESCE($10, executable_peak_sol_value),
        observable_peak_sol_value = COALESCE($11, observable_peak_sol_value),
        last_jupiter_executable_sol_value = COALESCE($12, last_jupiter_executable_sol_value),
        last_healthy_exit_route_at = COALESCE($13, last_healthy_exit_route_at),
        updated_at = NOW()
        WHERE accounting_mode = $1 AND trace_id = $2 RETURNING *`,
        [fill.accountingMode, fill.traceId, String(next.tokenAmount), next.remainingCostSol,
          next.cumulativeGrossProceedsSol, next.cumulativeNetProceedsSol,
          next.highestTpStepReached, next.stopLossPct, next.status,
          fill.executablePeakSolValue ?? null, fill.observablePeakSolValue ?? null,
          fill.lastJupiterExecutableSolValue ?? null,
          fill.lastHealthyExitRouteAt ? new Date(fill.lastHealthyExitRouteAt) : null]);
      if (updated.rowCount !== 1) throw new Error('POSITION_UPDATE_FAILED');
      await client.query('COMMIT');
      return { applied: true, position: fromRow(updated.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async readOpenShadowPositions(): Promise<LedgerPositionState[]> {
    if (!this.pool) throw new Error('PERSISTENCE_UNAVAILABLE');
    const result = await this.pool.query(`SELECT * FROM quant_position_ledger
      WHERE accounting_mode = 'SHADOW' AND status IN ('OPEN','PARTIAL_CLOSED')
      ORDER BY entry_timestamp`);
    return result.rows.map(fromRow);
  }

  async assertLiveExitReady(traceId?: string, tokenAmount?: number): Promise<void> {
    if (!this.pool) throw new Error('LIVE_LEDGER_UNAVAILABLE');
    await this.pool.query(`SELECT 1 FROM quant_live_exit_fills LIMIT 0`);
    await this.pool.query(`SELECT accounting_mode, initial_capital_sol,
      remaining_cost_sol, remaining_token_amount, highest_tp_step, stop_loss_pct,
      cumulative_gross_proceeds_sol, cumulative_fee_sol,
      cumulative_net_proceeds_sol, cumulative_pnl_sol
      FROM trade_outcomes LIMIT 0`);
    if (traceId) {
      const existing = await this.pool.query(`SELECT accounting_mode,status,remaining_cost_sol,
        remaining_token_amount FROM trade_outcomes WHERE trace_id = $1`, [traceId]);
      if (existing.rowCount === 1) {
        const row = existing.rows[0];
        if (row.accounting_mode != null && row.accounting_mode !== 'LIVE')
          throw new Error('LIVE_OUTCOME_MODE_MISMATCH');
        if (row.status === 'FULLY_CLOSED' || row.status === 'WATCHDOG_CLOSED' || row.status === 'PANIC_CLOSED')
          throw new Error('LIVE_POSITION_ALREADY_CLOSED');
        if (row.status === 'PARTIAL_CLOSED' &&
            (row.remaining_cost_sol == null || row.remaining_token_amount == null))
          throw new Error('LEGACY_PARTIAL_REQUIRES_RECONCILIATION');
        if (row.remaining_token_amount != null && tokenAmount != null &&
            Number(row.remaining_token_amount) !== tokenAmount)
          throw new Error('LIVE_POSITION_AMOUNT_RECONCILIATION_REQUIRED');
      }
    }
  }

  async appendConfirmedLiveFill(fill: ConfirmedLiveFill): Promise<{ applied: boolean;
    remainingTokenAmount: number; remainingCostSol: number; highestTpStepReached: number;
    stopLossPct: number; status: string }> {
    if (!this.pool || !fill.traceId || !fill.fillId || !Number.isSafeInteger(fill.soldAtomic) ||
      fill.soldAtomic <= 0 || !Number.isSafeInteger(fill.receivedLamports) ||
      fill.receivedLamports <= 0 || !Number.isSafeInteger(fill.feeLamports) ||
      fill.feeLamports < 0 || !Number.isSafeInteger(fill.initialTokenAmount) ||
      fill.initialTokenAmount < fill.soldAtomic || !Number.isFinite(fill.initialCapitalSol) ||
      fill.initialCapitalSol <= 0) throw new Error('INVALID_CONFIRMED_LIVE_FILL');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO trade_outcomes
        (trace_id,mint,entry_price_usd,entry_size_sol,entry_timestamp,
         accounting_mode,initial_capital_sol,remaining_cost_sol,
         remaining_token_amount,highest_tp_step,stop_loss_pct,status,
         cumulative_gross_proceeds_sol,cumulative_fee_sol,
         cumulative_net_proceeds_sol,cumulative_pnl_sol)
        VALUES ($1,$2,$3,$4,$5,'LIVE',$4,$4,$6,0,-0.125,'OPEN',0,0,0,0)
        ON CONFLICT (trace_id) DO NOTHING`,
        [fill.traceId, fill.mint, fill.entryPriceUsd, fill.initialCapitalSol,
          fill.entryTimestamp, String(fill.initialTokenAmount)]);
      const locked = await client.query(`SELECT * FROM trade_outcomes
        WHERE trace_id = $1 AND accounting_mode = 'LIVE' FOR UPDATE`, [fill.traceId]);
      if (locked.rowCount !== 1) throw new Error('LIVE_OUTCOME_MODE_MISMATCH');
      const row = locked.rows[0];
      if (row.status === 'PARTIAL_CLOSED' &&
          (row.initial_capital_sol == null || row.remaining_cost_sol == null || row.remaining_token_amount == null))
        throw new Error('LEGACY_PARTIAL_REQUIRES_RECONCILIATION');
      const currentAmount = row.remaining_token_amount == null
        ? fill.initialTokenAmount : String(row.remaining_token_amount) === '0' && row.status === 'FULLY_CLOSED'
          ? 0 : assertAtomicAmountToNumber(String(row.remaining_token_amount));
      const currentCost = Number(row.remaining_cost_sol ?? fill.initialCapitalSol);
      const initialCapital = Number(row.initial_capital_sol ?? fill.initialCapitalSol);
      const inserted = await client.query(`INSERT INTO quant_live_exit_fills
        (accounting_mode,trace_id,fill_id,token_amount,confirmed_wallet_delta_sol,
         gross_proceeds_sol,fee_sol,next_step,is_full)
        VALUES ('LIVE',$1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (accounting_mode,trace_id,fill_id) DO NOTHING RETURNING fill_id`,
        [fill.traceId, fill.fillId, String(fill.soldAtomic), fill.receivedLamports / 1e9,
          (fill.receivedLamports + fill.feeLamports) / 1e9,
          fill.feeLamports / 1e9, fill.nextStep, fill.isFull]);
      if (inserted.rowCount === 0) {
        await client.query('COMMIT');
        return { applied: false, remainingTokenAmount: currentAmount,
          remainingCostSol: currentCost, highestTpStepReached: Number(row.highest_tp_step ?? 0),
          stopLossPct: Number(row.stop_loss_pct ?? -0.125), status: String(row.status) };
      }
      if (fill.soldAtomic > currentAmount || fill.isFull !== (fill.soldAtomic === currentAmount) ||
          fill.nextStep < Number(row.highest_tp_step ?? 0) || fill.nextStep > 2)
        throw new Error('LIVE_FILL_AMOUNT_OR_STEP_MISMATCH');
      const nextAmount = currentAmount - fill.soldAtomic;
      const nextCost = nextAmount === 0 ? 0 : precise(currentCost * nextAmount / currentAmount);
      const realizedCost = initialCapital - nextCost;
      const gross = precise(Number(row.cumulative_gross_proceeds_sol ?? row.exit_size_sol ?? 0) +
        (fill.receivedLamports + fill.feeLamports) / 1e9);
      const fees = precise(Number(row.cumulative_fee_sol ?? row.fees_total_sol ?? 0) +
        fill.feeLamports / 1e9);
      const net = precise(gross - fees);
      const pnl = precise(net - realizedCost);
      const status = fill.isFull ? 'FULLY_CLOSED' : 'PARTIAL_CLOSED';
      const stop = fill.nextStep >= 1 ? Math.max(Number(row.stop_loss_pct ?? -0.125), 0) :
        Number(row.stop_loss_pct ?? -0.125);
      const updated = await client.query(`UPDATE trade_outcomes SET
        entry_size_sol = $2, initial_capital_sol = $2,
        remaining_cost_sol = $3, remaining_token_amount = $4,
        highest_tp_step = $5, stop_loss_pct = $6,
        exit_price_usd = $7, exit_size_sol = $8, exit_timestamp = NOW(),
        exit_reason = $9::decision_type, pnl_sol = $10,
        pnl_pct = $11, fees_total_sol = $12, rent_recovered_sol = 0,
        net_pnl_sol = $10, status = $13,
        cumulative_gross_proceeds_sol = $8, cumulative_fee_sol = $12,
        cumulative_net_proceeds_sol = $14, cumulative_pnl_sol = $10
        WHERE trace_id = $1 AND accounting_mode = 'LIVE'`,
        [fill.traceId, initialCapital, nextCost, String(nextAmount), fill.nextStep,
          stop, fill.exitPriceUsd, gross, fill.exitReason, pnl,
          realizedCost > 0 ? pnl / realizedCost * 100 : 0, fees, status, net]);
      if (updated.rowCount !== 1) throw new Error('LIVE_OUTCOME_UPDATE_FAILED');
      await client.query('COMMIT');
      return { applied: true, remainingTokenAmount: nextAmount, remainingCostSol: nextCost,
        highestTpStepReached: fill.nextStep, stopLossPct: stop, status };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async updateShadowWatermarks(traceId: string, values: {
    executablePeakSolValue: number; observablePeakSolValue: number;
    lastJupiterExecutableSolValue: number; lastHealthyExitRouteAt: number
  }): Promise<void> {
    if (!this.pool || !traceId || Object.values(values).some(v => !Number.isFinite(v) || v <= 0))
      throw new Error('INVALID_SHADOW_WATERMARK');
    const result = await this.pool.query(`UPDATE quant_position_ledger SET
        executable_peak_sol_value = GREATEST(COALESCE(executable_peak_sol_value,0),$2),
        observable_peak_sol_value = GREATEST(COALESCE(observable_peak_sol_value,0),$3),
        last_jupiter_executable_sol_value = $4,
        last_healthy_exit_route_at = GREATEST(COALESCE(last_healthy_exit_route_at,to_timestamp(0)),$5),
        updated_at = NOW()
      WHERE accounting_mode = 'SHADOW' AND trace_id = $1 AND status <> 'FULLY_CLOSED'`,
      [traceId, values.executablePeakSolValue, values.observablePeakSolValue,
        values.lastJupiterExecutableSolValue, new Date(values.lastHealthyExitRouteAt)]);
    if (result.rowCount !== 1) throw new Error('POSITION_NOT_FOUND');
  }
}
