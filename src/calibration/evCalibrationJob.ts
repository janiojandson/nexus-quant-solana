import { UNMEASURED_LEGACY_GATES } from '../audit/contractGates.js';
// ============================================================
// evCalibrationJob.ts — Nexus Quant Solana
// Cron noturno (03:00 UTC) — Modo Informativo (READ-ONLY)
// Lê decision_journal + trade_outcomes
// Escreve em calibration_snapshots
// NUNCA altera limiares operacionais
// ============================================================

import { Pool, PoolClient } from 'pg';
import {
  wilsonCI,
  meanCI,
  calculateEV,
  calculateLift,
  gateVerdict,
} from './stats.js';

// ──────────────────────────────────────────────
// CONFIGURAÇÃO
// ──────────────────────────────────────────────

export const CONFIG = {
  MIN_SAMPLE_SIZE: 30,          // N mínimo para conclusão estatística (MANDATÓRIO)
  WINDOW_DAYS: 30,              // janela de análise (rolling)
  AVG_COSTS_PCT: 2.5,           // custos médios por trade (%)
  LATENCY_BUCKETS: [            // buckets de latência para análise
    { label: 'FAST_0_400',     min: 0,    max: 400 },
    { label: 'MEDIUM_400_800', min: 400,  max: 800 },
    { label: 'SLOW_800_1500',  min: 800,  max: 1500 },
    { label: 'VERY_SLOW_1500+',min: 1500, max: Infinity },
  ],
} as const;

// ──────────────────────────────────────────────
// TIPOS INTERNOS
// ──────────────────────────────────────────────

export interface GateMetric {
  gateName: string;
  gateResult: 'PASS' | 'FAIL' | 'WARN';
  sampleSize: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  evNetPct: number;
  ciLowerPct: number;
  ciUpperPct: number;
  liftPct: number;
  verdict: string;
}

export interface LatencyMetric {
  bucket: string;
  sampleSize: number;
  winRate: number;
  evNetPct: number;
  ciLowerPct: number;
  ciUpperPct: number;
}

export interface CalibrationReport {
  computedAt: Date;
  windowDays: number;
  totalTrades: number;
  totalDecisions: number;
  overallWinRate: number;
  overallEV: number;
  gateMetrics: GateMetric[];
  latencyMetrics: LatencyMetric[];
  warnings: string[];
}

// ──────────────────────────────────────────────
// JOB PRINCIPAL
// ──────────────────────────────────────────────

export class EVCalibrationJob {
  private pool: Pool | null;

  constructor(pool: Pool | null) {
    this.pool = pool;
  }

  /**
   * Executa o ciclo completo de calibração.
   * READ-ONLY: apenas lê dados e escreve snapshots.
   */
  async run(): Promise<CalibrationReport> {
    const startTime = Date.now();
    console.log('[Calibration] 🔬 Iniciando ciclo de calibração estatística EV (READ-ONLY)...');

    const report: CalibrationReport = {
      computedAt: new Date(),
      windowDays: CONFIG.WINDOW_DAYS,
      totalTrades: 0,
      totalDecisions: 0,
      overallWinRate: 0,
      overallEV: 0,
      gateMetrics: [],
      latencyMetrics: [],
      warnings: [],
    };

    if (!this.pool) {
      report.warnings.push('PostgreSQL Pool ausente. Operação em modo headless de calibração.');
      return report;
    }

    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();

      // ── FASE 1: Agregação ──
      const trades = await this.fetchClosedTrades(client);
      const decisions = await this.fetchDecisions(client);

      report.totalTrades = trades.length;
      report.totalDecisions = decisions.length;

      if (trades.length === 0) {
        report.warnings.push('Nenhum trade fechado na janela de análise (30 dias).');
        console.log('[Calibration] Sem trades para analisar.');
        this.printReport(report);
        return report;
      }

      // ── FASE 2: Estatística Global ──
      this.calculateGlobalMetrics(trades, report);

      // ── FASE 3: Lift por Gate ──
      this.calculateGateMetrics(decisions, trades, report);

      // ── FASE 4: Latência vs EV ──
      this.calculateLatencyMetrics(trades, report);

      // ── FASE 5: Escrita em calibration_snapshots ──
      await this.writeSnapshots(client, report);

      const elapsed = Date.now() - startTime;
      console.log(`[Calibration] Concluído em ${elapsed}ms.`);
      this.printReport(report);

      return report;
    } catch (err: any) {
      console.error('[Calibration] Erro no ciclo de calibração:', err.message);
      report.warnings.push(`Erro de execução: ${err.message}`);
      return report;
    } finally {
      if (client) {
        client.release();
      }
    }
  }

  // ────────────────────────────────────────
  // FASE 1: AGREGAÇÃO
  // ────────────────────────────────────────

  private async fetchClosedTrades(
    client: PoolClient
  ): Promise<Array<{
    trace_id: string;
    mint: string;
    net_pnl_sol: number;
    pnl_pct: number;
    exit_reason: string;
    detection_to_send_ms: number | null;
    entry_slippage_pct: number | null;
    exit_slippage_pct: number | null;
    fees_total_sol: number | null;
    rent_recovered_sol: number | null;
    entry_timestamp: Date;
    exit_timestamp: Date | null;
  }>> {
    try {
      const result = await client.query(
        `SELECT
          trace_id, mint, net_pnl_sol, pnl_pct, exit_reason,
          detection_to_send_ms,
          entry_slippage_pct, exit_slippage_pct,
          fees_total_sol, rent_recovered_sol,
          entry_timestamp, exit_timestamp
        FROM trade_outcomes
        WHERE status IN ('FULLY_CLOSED', 'WATCHDOG_CLOSED', 'PANIC_CLOSED')
          AND exit_timestamp >= now() - ($1 || ' days')::interval
          AND net_pnl_sol IS NOT NULL
        ORDER BY exit_timestamp DESC`,
        [CONFIG.WINDOW_DAYS]
      );
      return result.rows.map(r => ({
        ...r,
        net_pnl_sol: Number(r.net_pnl_sol),
        pnl_pct: Number(r.pnl_pct),
        detection_to_send_ms: r.detection_to_send_ms ? Number(r.detection_to_send_ms) : null,
        entry_slippage_pct: r.entry_slippage_pct ? Number(r.entry_slippage_pct) : null,
        exit_slippage_pct: r.exit_slippage_pct ? Number(r.exit_slippage_pct) : null,
        fees_total_sol: r.fees_total_sol ? Number(r.fees_total_sol) : null,
        rent_recovered_sol: r.rent_recovered_sol ? Number(r.rent_recovered_sol) : null,
      }));
    } catch (err: any) {
      console.warn('⚠️ [Calibration] Falha ao consultar trade_outcomes:', err.message);
      return [];
    }
  }

  private async fetchDecisions(
    client: PoolClient
  ): Promise<Array<{
    trace_id: string;
    mint: string;
    decision: string;
    gate_details: string;
    gate_evidence_version?: string | number | null;
    token_age_minutes: number | null;
    liquidity_usd: number | null;
    buy_sell_ratio: number | null;
    distance_from_low: number | null;
    sentinel_regime: string;
    session_hour_utc: number | null;
    latency_to_send_ms: number | null;
  }>> {
    try {
      const result = await client.query(
        `SELECT
          trace_id, mint, decision, gate_details, metadata->>'gateEvidenceVersion' AS gate_evidence_version,
          token_age_minutes, liquidity_usd,
          buy_sell_ratio, distance_from_low,
          sentinel_regime, session_hour_utc, latency_to_send_ms
        FROM decision_journal
        WHERE created_at >= now() - ($1 || ' days')::interval
        ORDER BY created_at DESC`,
        [CONFIG.WINDOW_DAYS]
      );
      return result.rows;
    } catch (err: any) {
      console.warn('⚠️ [Calibration] Falha ao consultar decision_journal:', err.message);
      return [];
    }
  }

  // ────────────────────────────────────────
  // FASE 2: MÉTRICAS GLOBAIS
  // ────────────────────────────────────────

  private calculateGlobalMetrics(
    trades: Array<{ pnl_pct: number; net_pnl_sol: number }>,
    report: CalibrationReport
  ): void {
    const pnlValues = trades.map(t => t.pnl_pct);
    const wins = pnlValues.filter(p => p > 0);
    const losses = pnlValues.filter(p => p <= 0);

    const winRate = wins.length / trades.length;
    const avgWinPct = wins.length > 0
      ? wins.reduce((a, b) => a + b, 0) / wins.length
      : 0;
    const avgLossPct = losses.length > 0
      ? losses.reduce((a, b) => a + b, 0) / losses.length
      : 0;

    // Win rate com IC de Wilson
    const wrCI = wilsonCI(wins.length, trades.length);
    report.overallWinRate = wrCI.point * 100;

    // EV com IC de t-Student
    const ev = calculateEV(winRate, avgWinPct, avgLossPct, CONFIG.AVG_COSTS_PCT);
    report.overallEV = ev;

    // Warnings de amostragem
    if (trades.length < CONFIG.MIN_SAMPLE_SIZE) {
      report.warnings.push(
        `Amostra global insuficiente: N=${trades.length} < ${CONFIG.MIN_SAMPLE_SIZE}. ` +
        `Win rate e EV não são estatisticamente conclusivos.`
      );
    } else {
      report.warnings.push(
        `Win rate global: ${(wrCI.point * 100).toFixed(1)}% ` +
        `[IC 95%: ${(wrCI.lower * 100).toFixed(1)}% – ${(wrCI.upper * 100).toFixed(1)}%]`
      );
    }
  }

  // ────────────────────────────────────────
  // FASE 3: LIFT POR GATE
  // ────────────────────────────────────────

  private calculateGateMetrics(
    decisions: Array<{
      trace_id: string;
      decision: string;
      gate_details: string;
      gate_evidence_version?: string | number | null;
    }>,
    trades: Array<{ trace_id: string; pnl_pct: number }>,
    report: CalibrationReport
  ): void {
    const tradePnlMap = new Map<string, number>();
    for (const t of trades) {
      tradePnlMap.set(t.trace_id, t.pnl_pct);
    }

    const gateData = new Map<
      string,
      {
        pass: { traceIds: string[]; pnls: number[] };
        fail: { traceIds: string[]; pnls: number[] };
      }
    >();

    for (const d of decisions) {
      if (!d.gate_details) continue;

      let gates: Array<{
        gate: string;
        result: string;
        value?: number;
        threshold?: number;
      }>;

      try {
        gates = typeof d.gate_details === 'string' ? JSON.parse(d.gate_details) : d.gate_details;
      } catch {
        continue;
      }

      if (!Array.isArray(gates)) continue;

      for (const g of gates) {
        if (g.result !== 'PASS' && g.result !== 'FAIL') continue;
        if (!(Number(d.gate_evidence_version) >= 2) && UNMEASURED_LEGACY_GATES.has(g.gate)) continue;
        if (!gateData.has(g.gate)) {
          gateData.set(g.gate, {
            pass: { traceIds: [], pnls: [] },
            fail: { traceIds: [], pnls: [] },
          });
        }

        const entry = gateData.get(g.gate)!;
        const pnl = tradePnlMap.get(d.trace_id);

        if (g.result === 'PASS') {
          entry.pass.traceIds.push(d.trace_id);
          if (pnl !== undefined) entry.pass.pnls.push(pnl);
        } else {
          entry.fail.traceIds.push(d.trace_id);
          if (pnl !== undefined) entry.fail.pnls.push(pnl);
        }
      }
    }

    for (const [gateName, data] of gateData) {
      const passPnls = data.pass.pnls;
      const failPnls = data.fail.pnls;

      // ---- Gate PASS ----
      const passWins = passPnls.filter(p => p > 0);
      const passLosses = passPnls.filter(p => p <= 0);
      const passWinRate = passPnls.length > 0
        ? passWins.length / passPnls.length
        : 0;
      const passAvgWin = passWins.length > 0
        ? passWins.reduce((a, b) => a + b, 0) / passWins.length
        : 0;
      const passAvgLoss = passLosses.length > 0
        ? passLosses.reduce((a, b) => a + b, 0) / passLosses.length
        : 0;
      const passEV = calculateEV(
        passWinRate, passAvgWin, passAvgLoss, CONFIG.AVG_COSTS_PCT
      );

      // ---- Gate FAIL (para calcular lift) ----
      const failWins = failPnls.filter(p => p > 0);
      const failLosses = failPnls.filter(p => p <= 0);
      const failWinRate = failPnls.length > 0
        ? failWins.length / failPnls.length
        : 0;
      const failAvgWin = failWins.length > 0
        ? failWins.reduce((a, b) => a + b, 0) / failWins.length
        : 0;
      const failAvgLoss = failLosses.length > 0
        ? failLosses.reduce((a, b) => a + b, 0) / failLosses.length
        : 0;
      const failEV = calculateEV(
        failWinRate, failAvgWin, failAvgLoss, CONFIG.AVG_COSTS_PCT
      );

      const lift = calculateLift(passEV, failEV);
      const sampleSize = passPnls.length + failPnls.length;
      const passCI = meanCI(passPnls);
      const verdict = gateVerdict(lift, sampleSize, CONFIG.MIN_SAMPLE_SIZE);

      if (sampleSize < CONFIG.MIN_SAMPLE_SIZE) {
        report.warnings.push(
          `Gate "${gateName}": N=${sampleSize} < ${CONFIG.MIN_SAMPLE_SIZE}. ` +
          `Veredito classificado como INSUFFICIENT_DATA.`
        );
      }

      report.gateMetrics.push({
        gateName,
        gateResult: 'PASS',
        sampleSize,
        winRate: passWinRate * 100,
        avgWinPct: passAvgWin,
        avgLossPct: passAvgLoss,
        evNetPct: passEV,
        ciLowerPct: passCI.lower,
        ciUpperPct: passCI.upper,
        liftPct: lift,
        verdict,
      });
    }
  }

  // ────────────────────────────────────────
  // FASE 4: LATÊNCIA VS EV
  // ────────────────────────────────────────

  private calculateLatencyMetrics(
    trades: Array<{
      detection_to_send_ms: number | null;
      pnl_pct: number;
    }>,
    report: CalibrationReport
  ): void {
    for (const bucket of CONFIG.LATENCY_BUCKETS) {
      const bucketTrades = trades.filter(t =>
        t.detection_to_send_ms !== null &&
        t.detection_to_send_ms >= bucket.min &&
        t.detection_to_send_ms < bucket.max
      );

      const pnls = bucketTrades.map(t => t.pnl_pct);
      const wins = pnls.filter(p => p > 0);
      const losses = pnls.filter(p => p <= 0);

      const winRate = pnls.length > 0 ? wins.length / pnls.length : 0;
      const avgWin = wins.length > 0
        ? wins.reduce((a, b) => a + b, 0) / wins.length
        : 0;
      const avgLoss = losses.length > 0
        ? losses.reduce((a, b) => a + b, 0) / losses.length
        : 0;
      const ev = calculateEV(winRate, avgWin, avgLoss, CONFIG.AVG_COSTS_PCT);
      const ci = meanCI(pnls);

      if (pnls.length > 0 && pnls.length < CONFIG.MIN_SAMPLE_SIZE) {
        report.warnings.push(
          `Latência "${bucket.label}": N=${pnls.length} < ${CONFIG.MIN_SAMPLE_SIZE}. ` +
          `Dados não estatisticamente conclusivos.`
        );
      }

      report.latencyMetrics.push({
        bucket: bucket.label,
        sampleSize: pnls.length,
        winRate: winRate * 100,
        evNetPct: ev,
        ciLowerPct: ci.lower,
        ciUpperPct: ci.upper,
      });
    }
  }

  // ────────────────────────────────────────
  // FASE 5: ESCRITA EM SNAPSHOTS
  // ────────────────────────────────────────

  private async writeSnapshots(
    client: PoolClient,
    report: CalibrationReport
  ): Promise<void> {
    await client.query('BEGIN');

    try {
      // ── Snapshots por gate ──
      for (const g of report.gateMetrics) {
        await client.query(
          `INSERT INTO calibration_snapshots (
            computed_at, window_days,
            gate_name, gate_result,
            sample_size,
            win_rate, avg_win_pct, avg_loss_pct,
            ev_net_pct, ci_lower_pct, ci_upper_pct,
            lift_pct, gate_verdict, metadata
          ) VALUES (
            $1, $2,
            $3, $4,
            $5,
            $6, $7, $8,
            $9, $10, $11,
            $12, $13, $14
          )`,
          [
            report.computedAt,
            report.windowDays,
            g.gateName,
            g.gateResult,
            g.sampleSize,
            g.winRate,
            g.avgWinPct,
            g.avgLossPct,
            g.evNetPct,
            g.ciLowerPct,
            g.ciUpperPct,
            g.liftPct,
            g.verdict,
            JSON.stringify({
              mode: 'READ_ONLY',
              jobVersion: '1.0.0',
            }),
          ]
        );
      }

      // ── Snapshots por latência (como gates especiais) ──
      for (const l of report.latencyMetrics) {
        await client.query(
          `INSERT INTO calibration_snapshots (
            computed_at, window_days,
            gate_name, gate_result,
            sample_size,
            win_rate,
            ev_net_pct, ci_lower_pct, ci_upper_pct,
            gate_verdict, metadata
          ) VALUES (
            $1, $2,
            $3, $4,
            $5,
            $6,
            $7, $8, $9,
            $10, $11
          )`,
          [
            report.computedAt,
            report.windowDays,
            'LATENCY_ABORT',
            'PASS',
            l.sampleSize,
            l.winRate,
            l.evNetPct,
            l.ciLowerPct,
            l.ciUpperPct,
            l.sampleSize >= CONFIG.MIN_SAMPLE_SIZE
              ? 'KEEP'
              : 'INSUFFICIENT_DATA',
            JSON.stringify({
              latencyBucket: l.bucket,
              mode: 'READ_ONLY',
            }),
          ]
        );
      }

      // ── Snapshot global (meta-registro) ──
      await client.query(
        `INSERT INTO calibration_snapshots (
          computed_at, window_days,
          gate_name, gate_result,
          sample_size,
          win_rate, ev_net_pct,
          metadata
        ) VALUES (
          $1, $2,
          $3, $4,
          $5,
          $6, $7,
          $8
        )`,
        [
          report.computedAt,
          report.windowDays,
          'SLIPPAGE_CHECK',
          'WARN',
          report.totalTrades,
          report.overallWinRate,
          report.overallEV,
          JSON.stringify({
            type: 'GLOBAL_SUMMARY',
            totalTrades: report.totalTrades,
            totalDecisions: report.totalDecisions,
            warnings: report.warnings,
            mode: 'READ_ONLY',
          }),
        ]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.warn('⚠️ [Calibration] Erro ao gravar calibration_snapshots:', (err as Error).message);
    }
  }

  // ────────────────────────────────────────
  // RELATÓRIO CONSOLE (Railway Logs)
  // ────────────────────────────────────────

  private printReport(report: CalibrationReport): void {
    console.log('\n═══════════════════════════════════════════');
    console.log('   EV CALIBRATION REPORT — READ-ONLY');
    console.log('═══════════════════════════════════════════');
    console.log(`  Data: ${report.computedAt.toISOString()}`);
    console.log(`  Janela: ${report.windowDays} dias`);
    console.log(`  Trades fechados: ${report.totalTrades}`);
    console.log(`  Decisões registradas: ${report.totalDecisions}`);
    console.log(`  Win Rate Global: ${report.overallWinRate.toFixed(1)}%`);
    console.log(`  EV Líquido: ${report.overallEV.toFixed(2)}%`);
    console.log('───────────────────────────────────────────');

    if (report.gateMetrics.length > 0) {
      console.log('\n  GATES:');
      console.log(
        '  Gate'.padEnd(25) +
        'N'.padStart(5) +
        'WR%'.padStart(7) +
        'EV%'.padStart(8) +
        'Lift%'.padStart(8) +
        'Verdict'.padStart(22)
      );
      console.log('  ' + '─'.repeat(75));

      for (const g of report.gateMetrics) {
        console.log(
          `  ${g.gateName}`.padEnd(25) +
          `${g.sampleSize}`.padStart(5) +
          `${g.winRate.toFixed(1)}`.padStart(7) +
          `${g.evNetPct.toFixed(2)}`.padStart(8) +
          `${g.liftPct.toFixed(2)}`.padStart(8) +
          `${g.verdict}`.padStart(22)
        );
      }
    }

    if (report.latencyMetrics.length > 0) {
      console.log('\n  LATÊNCIA VS EV:');
      for (const l of report.latencyMetrics) {
        console.log(
          `  ${l.bucket}`.padEnd(25) +
          `${l.sampleSize}`.padStart(5) +
          `${l.winRate.toFixed(1)}%`.padStart(7) +
          `${l.evNetPct.toFixed(2)}%`.padStart(8)
        );
      }
    }

    if (report.warnings.length > 0) {
      console.log('\n  ⚠️  AVISOS:');
      for (const w of report.warnings) {
        console.log(`    • ${w}`);
      }
    }

    console.log('═══════════════════════════════════════════\n');
  }
}
