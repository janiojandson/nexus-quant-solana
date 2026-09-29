// ============================================================
// calibrationCron.ts — Agendamento do job
// Executa a cada 24h às 03:00 UTC
// ============================================================

import { Pool } from 'pg';
import cron from 'node-cron';
import { EVCalibrationJob, CalibrationReport } from './evCalibrationJob.js';

export function startCalibrationCron(pgPool: Pool | null): void {
  // Executa todo dia às 03:00 UTC
  cron.schedule('0 3 * * *', async () => {
    console.log('[Cron] ⏰ Disparando EV Calibration Job Noturno (03:00 UTC)...');
    try {
      const job = new EVCalibrationJob(pgPool);
      await job.run();
    } catch (err: any) {
      console.error('[Cron] Erro no calibration job:', err.message);
    }
  }, {
    timezone: 'UTC',
  });

  console.log('⏰ [Cron] EV Calibration Job agendado: 03:00 UTC diário.');
}

/**
 * Execução manual sob demanda (para testes / dashboard / API).
 * Rota: POST /api/calibration/run
 */
export async function runCalibrationNow(pgPool: Pool | null): Promise<CalibrationReport> {
  const job = new EVCalibrationJob(pgPool);
  return job.run();
}
