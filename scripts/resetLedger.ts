// ============================================================
// resetLedger.ts — Nexus Quant Solana
// Script CLI para limpeza segura e reset do Decision Journal e Quarentena
// ============================================================

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

let rawConn = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL || '';

if (!rawConn) {
  rawConn = 'postgresql://postgres:RqTVXNATEwQOMryilqbZZOUttNTQuJmk@zephyr.proxy.rlwy.net:25561/railway';
}

function createPool(conn: string): Pool {
  return new Pool({
    connectionString: conn,
    ssl: conn.includes('railway') || conn.includes('proxy.rlwy.net')
      ? { rejectUnauthorized: false }
      : undefined,
    connectionTimeoutMillis: 5000,
  });
}

async function getWorkingClient(): Promise<{ client: any; pool: Pool }> {
  // 1. Tenta a string informada
  let pool = createPool(rawConn);
  try {
    const client = await pool.connect();
    return { client, pool };
  } catch (err: any) {
    if (err.code === 'ENOTFOUND' && rawConn.includes('postgres.railway.internal')) {
      console.log('🌐 [Proxy Fallback] Host interno inacessível na máquina local. Conectando via proxy TCP do Railway...');
      await pool.end().catch(() => {});
      const proxyConn = rawConn.replace('postgres.railway.internal:5432', 'zephyr.proxy.rlwy.net:25561');
      pool = createPool(proxyConn);
      const client = await pool.connect();
      return { client, pool };
    }
    throw err;
  }
}

async function resetLedger() {
  console.log('============================================================');
  console.log('🧹 NEXUS QUANT SOLANA — RESET DO LEDGER E QUARENTENA');
  console.log('============================================================');
  console.log(`📡 Conectando ao PostgreSQL...`);

  let client: any = null;
  let pool: Pool | null = null;

  try {
    const connResult = await getWorkingClient();
    client = connResult.client;
    pool = connResult.pool;

    // 1. Contagem prévia de registros para feedback
    let countDecisions = 0;
    let countQuarantine = 0;
    let countAudits = 0;

    try {
      const resDec = await client.query('SELECT COUNT(*) FROM decision_journal');
      countDecisions = parseInt(resDec.rows[0]?.count || '0', 10);
    } catch {}

    try {
      const resQuar = await client.query('SELECT COUNT(*) FROM token_quarantine');
      countQuarantine = parseInt(resQuar.rows[0]?.count || '0', 10);
    } catch {}

    try {
      const resAud = await client.query('SELECT COUNT(*) FROM solana_agent_audits');
      countAudits = parseInt(resAud.rows[0]?.count || '0', 10);
    } catch {}

    console.log(`📊 Registros atuais encontrados no banco:`);
    console.log(`   • decision_journal:    ${countDecisions} registros`);
    console.log(`   • token_quarantine:    ${countQuarantine} registros`);
    console.log(`   • solana_agent_audits: ${countAudits} registros`);
    console.log('------------------------------------------------------------');

    // 2. Truncamento Seguro das Tabelas
    console.log('⚡ Executando TRUNCATE seguro nas tabelas do Ledger...');

    // 2.1 Truncate na tabela particionada decision_journal com CASCADE
    await client.query('TRUNCATE TABLE "decision_journal" RESTART IDENTITY CASCADE;');
    console.log('   ✅ Tabela "decision_journal" truncada (partições zeradas).');

    // 2.2 Truncate condicional em token_quarantine
    await client.query(`
      DO $$ 
      BEGIN 
        IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'token_quarantine') THEN 
          TRUNCATE TABLE "token_quarantine" RESTART IDENTITY CASCADE; 
        END IF; 
      END $$;
    `);
    console.log('   ✅ Tabela "token_quarantine" truncada (quarentenas purgadas).');

    // 2.3 Truncate condicional em solana_agent_audits
    await client.query(`
      DO $$ 
      BEGIN 
        IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'solana_agent_audits') THEN 
          TRUNCATE TABLE "solana_agent_audits" RESTART IDENTITY CASCADE; 
        END IF; 
      END $$;
    `);
    console.log('   ✅ Tabela "solana_agent_audits" truncada.');

    console.log('============================================================');
    console.log(`🎉 RESET CONCLUÍDO COM SUCESSO!`);
    console.log(`   Total de registros eliminados: ${countDecisions + countQuarantine + countAudits}`);
    console.log(`   O Decision Journal e a Quarentena iniciarão a contagem limpa.`);
    console.log('============================================================');
  } catch (err: any) {
    console.error('❌ Erro durante o reset do ledger:', err.message || err);
    process.exit(1);
  } finally {
    if (client) client.release();
    if (pool) await pool.end();
  }

  process.exit(0);
}

resetLedger();
