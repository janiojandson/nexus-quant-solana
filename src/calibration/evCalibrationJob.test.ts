import test from 'node:test';
import assert from 'node:assert';
import { EVCalibrationJob, CONFIG } from './evCalibrationJob.js';

test('EVCalibrationJob: roda gracioso em modo headless sem pool Postgres', async () => {
  const job = new EVCalibrationJob(null);
  const report = await job.run();

  assert.strictEqual(report.windowDays, 30);
  assert.strictEqual(report.totalTrades, 0);
  assert.strictEqual(report.totalDecisions, 0);
  assert.ok(report.warnings.some(w => w.includes('PostgreSQL Pool ausente')));
});

test('EVCalibrationJob: CONFIG possui MIN_SAMPLE_SIZE = 30 obrigatório', () => {
  assert.strictEqual(CONFIG.MIN_SAMPLE_SIZE, 30);
  assert.strictEqual(CONFIG.WINDOW_DAYS, 30);
});
