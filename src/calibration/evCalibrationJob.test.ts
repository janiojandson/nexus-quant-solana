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

test('calibration excludes legacy placeholder gates and unmeasured WARN values', () => {
  const job = new EVCalibrationJob(null);
  const report:any={gateMetrics:[],warnings:[]};
  const gates=JSON.stringify([
    {gate:'TOP_HOLDERS',result:'PASS',value:20},
    {gate:'DISTANCE_FROM_LOW',result:'WARN'},
    {gate:'LIQUIDITY_THRESHOLD',result:'PASS'}
  ]);
  (job as any).calculateGateMetrics([
    {trace_id:'legacy',gate_details:gates},
    {trace_id:'measured',gate_evidence_version:2,gate_details:gates}
  ],[{trace_id:'legacy',pnl_pct:10},{trace_id:'measured',pnl_pct:20}],report);
  assert.strictEqual(report.gateMetrics.find((g:any)=>g.gateName==='TOP_HOLDERS').sampleSize,1);
  assert.strictEqual(report.gateMetrics.find((g:any)=>g.gateName==='LIQUIDITY_THRESHOLD').sampleSize,2);
  assert.strictEqual(report.gateMetrics.some((g:any)=>g.gateName==='DISTANCE_FROM_LOW'),false);
});
