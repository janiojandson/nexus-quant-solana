import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { SolanaAdminAuthService } from './adminAuthService.js';

function makePool() {
  const users = new Map<string, any>();
  const pool = {
    async query(sql: string, params: any[] = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (/CREATE TABLE IF NOT EXISTS solana_admin_users/i.test(normalized)) {
        return { rowCount: 0, rows: [] };
      }
      if (/SELECT 1 FROM solana_admin_users/i.test(normalized)) {
        const active = [...users.values()].filter((u) => u.role === 'ADMIN' && u.is_active);
        return { rowCount: active.length ? 1 : 0, rows: active.length ? [{ '?column?': 1 }] : [] };
      }
      if (/INSERT INTO solana_admin_users/i.test(normalized)) {
        const [id, email, passwordHash, name] = params;
        const existing = [...users.values()].find((u) => u.email.toLowerCase() === String(email).toLowerCase());
        const record = {
          id: existing?.id || id,
          email,
          password_hash: passwordHash,
          name,
          role: 'ADMIN',
          is_active: true
        };
        users.set(record.id, record);
        return { rowCount: 1, rows: [] };
      }
      if (/FROM solana_admin_users\s+WHERE LOWER\(email\)/i.test(normalized)) {
        const email = String(params[0]).toLowerCase();
        const row = [...users.values()].find((u) => u.email.toLowerCase() === email && u.role === 'ADMIN');
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (/FROM solana_admin_users WHERE id = \$1/i.test(normalized)) {
        const row = users.get(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (/UPDATE solana_admin_users SET password_hash/i.test(normalized)) {
        const [hash, id] = params;
        const row = users.get(id);
        if (row) row.password_hash = hash;
        return { rowCount: row ? 1 : 0, rows: [] };
      }
      throw new Error('Query inesperada no teste: ' + normalized);
    }
  };
  return { pool: pool as any, users };
}

test('SolanaAdminAuthService cadastra primeiro admin, faz login e valida JWT', async () => {
  const oldToken = process.env.NEXUS_ADMIN_TOKEN;
  const oldJwt = process.env.SOLANA_JWT_SECRET;
  process.env.NEXUS_ADMIN_TOKEN = 'bootstrap-token-test';
  process.env.SOLANA_JWT_SECRET = 'jwt-secret-test-0123456789';
  try {
    const { pool } = makePool();
    const auth = new SolanaAdminAuthService(pool);

    const created = await auth.registerFirstAdmin({
      email: 'Admin@Example.com',
      password: 'senha-segura-123',
      name: 'Admin Teste',
      bootstrapToken: 'bootstrap-token-test'
    });

    assert.equal(created.email, 'admin@example.com');
    assert.equal(created.role, 'ADMIN');

    const login = await auth.login('ADMIN@example.com', 'senha-segura-123');
    assert.ok(login.token.length > 20);
    assert.equal(login.user.role, 'ADMIN');

    const verified = auth.verifyAdminToken(login.token);
    assert.equal(verified?.email, 'admin@example.com');
    assert.equal(verified?.role, 'ADMIN');
  } finally {
    if (oldToken === undefined) delete process.env.NEXUS_ADMIN_TOKEN;
    else process.env.NEXUS_ADMIN_TOKEN = oldToken;
    if (oldJwt === undefined) delete process.env.SOLANA_JWT_SECRET;
    else process.env.SOLANA_JWT_SECRET = oldJwt;
  }
});

test('SolanaAdminAuthService recusa bootstrap inválido e segundo cadastro', async () => {
  const oldToken = process.env.NEXUS_ADMIN_TOKEN;
  const oldJwt = process.env.SOLANA_JWT_SECRET;
  process.env.NEXUS_ADMIN_TOKEN = 'bootstrap-correto';
  process.env.SOLANA_JWT_SECRET = 'jwt-secret-test-abcdefghij';
  try {
    const { pool } = makePool();
    const auth = new SolanaAdminAuthService(pool);

    await assert.rejects(
      () => auth.registerFirstAdmin({
        email: 'admin@example.com',
        password: 'senha-segura-123',
        name: 'Admin',
        bootstrapToken: 'errado'
      }),
      /Código mestre inválido/
    );

    await auth.registerFirstAdmin({
      email: 'admin@example.com',
      password: 'senha-segura-123',
      name: 'Admin',
      bootstrapToken: 'bootstrap-correto'
    });

    await assert.rejects(
      () => auth.registerFirstAdmin({
        email: 'outro@example.com',
        password: 'outra-senha-123',
        name: 'Outro',
        bootstrapToken: 'bootstrap-correto'
      }),
      /Administrador já cadastrado/
    );
  } finally {
    if (oldToken === undefined) delete process.env.NEXUS_ADMIN_TOKEN;
    else process.env.NEXUS_ADMIN_TOKEN = oldToken;
    if (oldJwt === undefined) delete process.env.SOLANA_JWT_SECRET;
    else process.env.SOLANA_JWT_SECRET = oldJwt;
  }
});

test('SolanaAdminAuthService altera senha somente com senha atual correta', async () => {
  const oldToken = process.env.NEXUS_ADMIN_TOKEN;
  const oldJwt = process.env.SOLANA_JWT_SECRET;
  process.env.NEXUS_ADMIN_TOKEN = 'bootstrap-change';
  process.env.SOLANA_JWT_SECRET = 'jwt-secret-test-change-12345';
  try {
    const { pool, users } = makePool();
    const auth = new SolanaAdminAuthService(pool);
    const admin = await auth.registerFirstAdmin({
      email: 'admin@example.com',
      password: 'senha-antiga-123',
      name: 'Admin',
      bootstrapToken: 'bootstrap-change'
    });

    await assert.rejects(
      () => auth.changePassword(admin.userId, 'senha-errada', 'senha-nova-123'),
      /Senha atual incorreta/
    );

    await auth.changePassword(admin.userId, 'senha-antiga-123', 'senha-nova-123');
    const row = users.get(admin.userId);
    assert.equal(await bcrypt.compare('senha-nova-123', row.password_hash), true);
  } finally {
    if (oldToken === undefined) delete process.env.NEXUS_ADMIN_TOKEN;
    else process.env.NEXUS_ADMIN_TOKEN = oldToken;
    if (oldJwt === undefined) delete process.env.SOLANA_JWT_SECRET;
    else process.env.SOLANA_JWT_SECRET = oldJwt;
  }
});
