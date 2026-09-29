// ============================================================
// maintenanceJob.ts — Nexus Quant Solana
// Roda a cada 24h: gestão de partições e expurgo de 90 dias
// ============================================================

import { Pool } from 'pg';

export async function runMaintenance(pgPool: Pool | null): Promise<void> {
  if (!pgPool) return;

  let client;
  try {
    client = await pgPool.connect();

    // 1. Cria partição do próximo mês (se não existir)
    try {
      const nextPartition = await client.query('SELECT create_next_partition()');
      console.log(`🧹 [Maintenance] Partição do próximo mês verificada/criada: ${nextPartition.rows[0]?.create_next_partition}`);
    } catch (err: any) {
      console.warn('⚠️ [Maintenance] Aviso ao criar próxima partição:', err.message);
    }

    // 2. Remove partições com mais de 90 dias
    try {
      const dropped = await client.query('SELECT drop_old_partitions(90)');
      if (dropped.rows[0]?.drop_old_partitions?.length > 0) {
        console.log(`🧹 [Maintenance] Partições antigas expiradas removidas: ${dropped.rows[0].drop_old_partitions.join(', ')}`);
      }
    } catch (err: any) {
      console.warn('⚠️ [Maintenance] Aviso ao expurgar partições antigas:', err.message);
    }

    // 3. Vacuum leve nas tabelas auxiliares
    try {
      await client.query('VACUUM ANALYZE trade_outcomes');
      await client.query('VACUUM ANALYZE calibration_snapshots');
    } catch (err: any) {
      console.warn('⚠️ [Maintenance] Aviso no VACUUM ANALYZE:', err.message);
    }

    console.log('✅ [Maintenance] Rotina diária de manutenção do banco concluída.');
  } catch (err: any) {
    console.warn('⚠️ [Maintenance] Falha na conexão para manutenção:', err.message);
  } finally {
    if (client) {
      client.release();
    }
  }
}
