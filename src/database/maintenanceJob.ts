// ============================================================
// maintenanceJob.ts — Nexus Quant Solana
// Roda a cada 24h: gestão de partições e expurgo de 90 dias
// ============================================================

import { Pool } from 'pg';
import { assertJournalSchema } from './journalSchemaCompatibility.js';

export async function runMaintenance(pgPool: Pool | null): Promise<void> {
  await assertJournalSchema(pgPool);
  console.log(JSON.stringify({ event: 'JOURNAL_SCHEMA_CHECK', ready: true,
    maintenance: 'READ_ONLY', retentionEnabled: false }));
}
