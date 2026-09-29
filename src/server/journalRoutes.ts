// ============================================================
// journalRoutes.ts — Nexus Quant Solana
// Rotas de observabilidade e telemetria para o Decision Journal & Calibração
// 100% não-bloqueante, consultas assíncronas com tratamento seguro
// ============================================================

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import type { DecisionLogger } from '../database/decisionJournal.js';

export async function handleJournalRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pgPool: Pool | null,
  journal: DecisionLogger | null
): Promise<boolean> {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method || 'GET';

  if (!pathname.startsWith('/api/journal')) {
    return false;
  }

  // ──────────────────────────────────────────────
  // CARD 1: Funil de Coleta — GET /api/journal/stats
  // ──────────────────────────────────────────────
  if (pathname === '/api/journal/stats' && method === 'GET') {
    if (!pgPool) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        totalDecisions: 0,
        totalClosedTrades: 0,
        targetN: 150,
        decisionBreakdown: [],
        buffer: journal ? journal.getStats() : { bufferSize: 0, totalLogged: 0, totalFlushed: 0, totalErrors: 0 },
        progressPct: 0,
      }));
      return true;
    }

    try {
      const [decisions, trades, rejBuffer] = await Promise.all([
        pgPool.query('SELECT COUNT(*) FROM decision_journal'),
        pgPool.query(`
          SELECT COUNT(*) FROM trade_outcomes
          WHERE status IN ('FULLY_CLOSED','WATCHDOG_CLOSED','PANIC_CLOSED')
        `),
        pgPool.query(`
          SELECT decision, COUNT(*) as total
          FROM decision_journal
          GROUP BY decision
          ORDER BY total DESC
        `),
      ]);

      const bufferStats = journal ? journal.getStats() : { bufferSize: 0, totalLogged: 0, totalFlushed: 0, totalErrors: 0 };
      const totalDecisions = parseInt(decisions.rows[0]?.count || '0', 10);
      const totalClosedTrades = parseInt(trades.rows[0]?.count || '0', 10);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        totalDecisions,
        totalClosedTrades,
        targetN: 150,
        decisionBreakdown: rejBuffer.rows.map(r => ({ decision: r.decision, total: parseInt(r.total, 10) })),
        buffer: bufferStats,
        progressPct: Math.min(100, Math.round((totalClosedTrades / 150) * 100)),
      }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'Falha ao buscar estatísticas do journal' }));
    }
    return true;
  }

  // ──────────────────────────────────────────────
  // CARD 2: Lift por Gate — GET /api/journal/gates
  // ──────────────────────────────────────────────
  if (pathname === '/api/journal/gates' && method === 'GET') {
    if (!pgPool) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        lastCalibrationAt: null,
        gates: [],
        summary: { keep: 0, adjust: 0, remove: 0, waiting: 0 },
      }));
      return true;
    }

    try {
      const [gatesRes, lastRunRes] = await Promise.all([
        pgPool.query(`
          SELECT
            gate_name,
            sample_size,
            win_rate,
            ev_net_pct,
            ci_lower_pct,
            ci_upper_pct,
            lift_pct,
            gate_verdict,
            computed_at
          FROM calibration_snapshots
          WHERE computed_at = (
            SELECT MAX(computed_at)
            FROM calibration_snapshots
            WHERE gate_name NOT IN ('LATENCY_ABORT', 'SLIPPAGE_CHECK')
          )
          AND gate_name NOT IN ('LATENCY_ABORT', 'SLIPPAGE_CHECK')
          ORDER BY lift_pct DESC NULLS LAST
        `),
        pgPool.query(`
          SELECT MAX(computed_at) as last_run
          FROM calibration_snapshots
        `),
      ]);

      const gates = gatesRes.rows.map(g => ({
        gate_name: g.gate_name,
        sample_size: Number(g.sample_size),
        win_rate: g.win_rate != null ? Number(g.win_rate) : null,
        ev_net_pct: g.ev_net_pct != null ? Number(g.ev_net_pct) : null,
        ci_lower_pct: g.ci_lower_pct != null ? Number(g.ci_lower_pct) : null,
        ci_upper_pct: g.ci_upper_pct != null ? Number(g.ci_upper_pct) : null,
        lift_pct: g.lift_pct != null ? Number(g.lift_pct) : null,
        gate_verdict: g.gate_verdict,
        computed_at: g.computed_at,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        lastCalibrationAt: lastRunRes.rows[0]?.last_run || null,
        gates,
        summary: {
          keep: gates.filter(g => g.gate_verdict === 'KEEP').length,
          adjust: gates.filter(g => ['LOOSEN', 'TIGHTEN'].includes(g.gate_verdict)).length,
          remove: gates.filter(g => g.gate_verdict === 'REMOVE').length,
          waiting: gates.filter(g => g.gate_verdict === 'INSUFFICIENT_DATA').length,
        },
      }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'Falha ao buscar lift por gate' }));
    }
    return true;
  }

  // ──────────────────────────────────────────────
  // CARD 3: Latência vs EV — GET /api/journal/latency
  // ──────────────────────────────────────────────
  if (pathname === '/api/journal/latency' && method === 'GET') {
    if (!pgPool) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ buckets: [] }));
      return true;
    }

    try {
      const result = await pgPool.query(`
        SELECT
          metadata->>'latencyBucket' as bucket,
          sample_size,
          win_rate,
          ev_net_pct,
          ci_lower_pct,
          ci_upper_pct
        FROM calibration_snapshots
        WHERE gate_name = 'LATENCY_ABORT'
          AND computed_at = (
            SELECT MAX(computed_at)
            FROM calibration_snapshots
            WHERE gate_name = 'LATENCY_ABORT'
          )
        ORDER BY sample_size DESC
      `);

      const buckets = result.rows.map(b => ({
        bucket: b.bucket || 'N/A',
        sample_size: Number(b.sample_size),
        win_rate: b.win_rate != null ? Number(b.win_rate) : null,
        ev_net_pct: b.ev_net_pct != null ? Number(b.ev_net_pct) : null,
        ci_lower_pct: b.ci_lower_pct != null ? Number(b.ci_lower_pct) : null,
        ci_upper_pct: b.ci_upper_pct != null ? Number(b.ci_upper_pct) : null,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ buckets }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'Falha ao buscar latência vs ev' }));
    }
    return true;
  }

  // ──────────────────────────────────────────────
  // CARD 4: Faixa de Maturação — GET /api/journal/maturity
  // ──────────────────────────────────────────────
  if (pathname === '/api/journal/maturity' && method === 'GET') {
    if (!pgPool) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ageBuckets: [],
        rejectionsByAge: [],
        strategyComparison: [],
        note: 'PostgreSQL indisponível ou em inicialização.',
      }));
      return true;
    }

    try {
      const [ageBucketsRes, rejectionsRes, comparisonRes] = await Promise.all([
        pgPool.query(`
          SELECT
            CASE
              WHEN dj.token_age_minutes < 5   THEN '0-5 min'
              WHEN dj.token_age_minutes < 8   THEN '5-8 min'
              WHEN dj.token_age_minutes < 15  THEN '8-15 min'
              WHEN dj.token_age_minutes < 30  THEN '15-30 min'
              WHEN dj.token_age_minutes < 60  THEN '30-60 min'
              ELSE '60+ min'
            END AS age_bucket,
            CASE
              WHEN dj.token_age_minutes < 5   THEN 1
              WHEN dj.token_age_minutes < 8   THEN 2
              WHEN dj.token_age_minutes < 15  THEN 3
              WHEN dj.token_age_minutes < 30  THEN 4
              WHEN dj.token_age_minutes < 60  THEN 5
              ELSE 6
            END AS bucket_order,
            COUNT(*) AS n_trades,
            COUNT(*) FILTER (WHERE tj.pnl_pct > 0) AS wins,
            COUNT(*) FILTER (WHERE tj.pnl_pct <= 0) AS losses,
            ROUND(
              COUNT(*) FILTER (WHERE tj.pnl_pct > 0)::numeric /
              NULLIF(COUNT(*), 0) * 100, 1
            ) AS win_rate_pct,
            ROUND(AVG(tj.pnl_pct), 2) AS avg_pnl_pct,
            ROUND(AVG(tj.pnl_pct) FILTER (WHERE tj.pnl_pct > 0), 2) AS avg_win_pct,
            ROUND(AVG(tj.pnl_pct) FILTER (WHERE tj.pnl_pct <= 0), 2) AS avg_loss_pct,
            ROUND(SUM(tj.net_pnl_sol), 6) AS total_net_pnl_sol
          FROM decision_journal dj
          INNER JOIN trade_outcomes tj ON dj.trace_id = tj.trace_id
          WHERE dj.decision = 'ENTRY_APPROVED'
            AND tj.status IN ('FULLY_CLOSED','WATCHDOG_CLOSED','PANIC_CLOSED')
            AND dj.token_age_minutes IS NOT NULL
            AND tj.pnl_pct IS NOT NULL
          GROUP BY 1, 2
          ORDER BY 2
        `),
        pgPool.query(`
          SELECT
            CASE
              WHEN token_age_minutes < 5   THEN '0-5 min'
              WHEN token_age_minutes < 8   THEN '5-8 min'
              WHEN token_age_minutes < 15  THEN '8-15 min'
              WHEN token_age_minutes < 30  THEN '15-30 min'
              WHEN token_age_minutes < 60  THEN '30-60 min'
              ELSE '60+ min'
            END AS age_bucket,
            COUNT(*) AS total_evaluated,
            COUNT(*) FILTER (WHERE decision = 'ENTRY_APPROVED') AS approved,
            COUNT(*) FILTER (WHERE decision = 'ENTRY_REJECTED') AS rejected
          FROM decision_journal
          WHERE token_age_minutes IS NOT NULL
          GROUP BY 1
          ORDER BY 1
        `),
        pgPool.query(`
          SELECT
            CASE
              WHEN dj.token_age_minutes BETWEEN 3 AND 8   THEN 'momento_doce_3_8min'
              WHEN dj.token_age_minutes BETWEEN 15 AND 30 THEN 'janela_atual_15_30min'
              WHEN dj.token_age_minutes BETWEEN 30 AND 60 THEN 'janela_estendida_30_60min'
            END AS strategy,
            COUNT(*) AS n,
            ROUND(
              COUNT(*) FILTER (WHERE tj.pnl_pct > 0)::numeric /
              NULLIF(COUNT(*), 0) * 100, 1
            ) AS win_rate,
            ROUND(AVG(tj.pnl_pct), 2) AS avg_pnl_pct,
            ROUND(SUM(tj.net_pnl_sol), 6) AS total_pnl_sol
          FROM decision_journal dj
          INNER JOIN trade_outcomes tj ON dj.trace_id = tj.trace_id
          WHERE dj.decision = 'ENTRY_APPROVED'
            AND tj.status IN ('FULLY_CLOSED','WATCHDOG_CLOSED','PANIC_CLOSED')
            AND dj.token_age_minutes IS NOT NULL
            AND tj.pnl_pct IS NOT NULL
          GROUP BY 1
          HAVING COUNT(*) >= 30
          ORDER BY avg_pnl_pct DESC
        `),
      ]);

      const ageBuckets = ageBucketsRes.rows.map(r => ({
        age_bucket: r.age_bucket,
        n_trades: parseInt(r.n_trades, 10),
        wins: parseInt(r.wins, 10),
        losses: parseInt(r.losses, 10),
        win_rate_pct: r.win_rate_pct != null ? Number(r.win_rate_pct) : 0,
        avg_pnl_pct: r.avg_pnl_pct != null ? Number(r.avg_pnl_pct) : 0,
        avg_win_pct: r.avg_win_pct != null ? Number(r.avg_win_pct) : 0,
        avg_loss_pct: r.avg_loss_pct != null ? Number(r.avg_loss_pct) : 0,
        total_net_pnl_sol: r.total_net_pnl_sol != null ? Number(r.total_net_pnl_sol) : 0,
      }));

      const rejectionsByAge = rejectionsRes.rows.map(r => ({
        age_bucket: r.age_bucket,
        total_evaluated: parseInt(r.total_evaluated, 10),
        approved: parseInt(r.approved, 10),
        rejected: parseInt(r.rejected, 10),
      }));

      const strategyComparison = comparisonRes.rows.map(r => ({
        strategy: r.strategy,
        n: parseInt(r.n, 10),
        win_rate: r.win_rate != null ? Number(r.win_rate) : 0,
        avg_pnl_pct: r.avg_pnl_pct != null ? Number(r.avg_pnl_pct) : 0,
        total_pnl_sol: r.total_pnl_sol != null ? Number(r.total_pnl_sol) : 0,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ageBuckets,
        rejectionsByAge,
        strategyComparison,
        note: strategyComparison.length >= 2
          ? 'Dados suficientes para comparação de estratégias.'
          : 'Aguardando N ≥ 30 em cada faixa para determinação estatística.',
      }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err?.message || 'Falha ao buscar análise de maturação' }));
    }
    return true;
  }

  return false;
}
