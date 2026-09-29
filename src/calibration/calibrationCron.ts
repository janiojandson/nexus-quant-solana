// ============================================================
// calibrationCron.ts — Agendamento do job
// Executa a cada 24h às 03:00 UTC
// ============================================================

import { Pool } from 'pg';
import cron from 'node-cron';
import { EVCalibrationJob, CalibrationReport } from './evCalibrationJob.js';

import { CerebroIntegrationService } from '../core/cerebroIntegration.js';

export function startCalibrationCron(pgPool: Pool | null): void {
  // Executa todo dia às 03:00 UTC
  cron.schedule('0 3 * * *', async () => {
    console.log('[Cron] ⏰ Disparando EV Calibration Job Noturno (03:00 UTC)...');
    try {
      const job = new EVCalibrationJob(pgPool);
      const report = await job.run();

      // Dispara Morning Briefing factual via Telegram / Cérebro
      let rugVetoes = 0;
      if (pgPool) {
        try {
          const res = await pgPool.query(
            "SELECT COUNT(*) FROM decision_gate_evaluations WHERE gate_name = 'RUG_CHECK' AND result = 'FAIL'"
          );
          rugVetoes = parseInt(res.rows[0]?.count || '0', 10);
        } catch {
          // não bloqueante
        }
      }

      const cerebro = new CerebroIntegrationService();
      await cerebro.notifyMorningBriefing({
        totalTrades: report.totalTrades,
        totalDecisions: report.totalDecisions,
        winRate: report.overallWinRate,
        overallEV: report.overallEV,
        rugVetoesCount: rugVetoes,
        warnings: report.warnings,
      });
      console.log('[Cron] 🌅 Morning Briefing despachado com sucesso.');
    } catch (err: any) {
      console.error('[Cron] Erro no calibration job / morning briefing:', err.message);
    }
  }, {
    timezone: 'UTC',
  });

  console.log('⏰ [Cron] EV Calibration Job agendado: 03:00 UTC diário (com Morning Briefing).');
}

/**
 * Execução manual sob demanda (para testes / dashboard / API).
 * Rota: POST /api/calibration/run
 */
export async function runCalibrationNow(pgPool: Pool | null): Promise<CalibrationReport> {
  const job = new EVCalibrationJob(pgPool);
  return job.run();
}
