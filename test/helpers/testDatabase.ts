/**
 * Nexus Quant Solana — Unified Test Database Helper (Mission V2.3-R2)
 *
 * Single source of truth for all PostgreSQL integration tests:
 * 1. Enforces TEST_DATABASE_URL across all test suites.
 * 2. Prohibits production Railway URLs.
 * 3. Fails closed (REAL_POSTGRES_REQUIRED) if PostgreSQL is unavailable.
 *    SILENT SKIPS OR PASSING WITHOUT DB ARE STRICTLY PROHIBITED.
 */

import { Pool } from 'pg';

export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://test_nexus_user:descartavel_secret_pass_123@localhost:55432/test_nexus_journal';

export function getRequiredTestDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;

  // Proibir terminantemente credenciais Railway
  if (url.includes('railway.internal') || url.includes('rlwy.net')) {
    throw new Error('REAL_POSTGRES_REQUIRED: PROIBIDO usar banco Railway de produção para testes!');
  }

  return url;
}

export async function createRequiredTestPool(): Promise<Pool> {
  const connectionString = getRequiredTestDatabaseUrl();
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000
  });

  try {
    const res = await pool.query('SELECT version()');
    if (!res.rows || res.rows.length === 0) {
      throw new Error('Empty response from SELECT version()');
    }
    return pool;
  } catch (err: any) {
    await pool.end().catch(() => {});
    const target = connectionString.split('@')[1] || connectionString;
    throw new Error(
      `REAL_POSTGRES_REQUIRED: Integration test failed because required test database at ${target} is unavailable or rejected credentials. Error: ${err?.message || err}`
    );
  }
}
